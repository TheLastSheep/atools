import App from "../../src/App.svelte";
import "../../src/components/SettingsPanel.svelte";
import "../../src/components/PluginPanel.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { FeatureAction, SearchResult } from "../../src/lib/types";
import { alphaPlugin, betaPlugin, gammaPlugin, ordinaryPluginQuery } from "./launcherReturnContextFixture";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void; settled: boolean };
type PendingActivation = Deferred<FeatureAction> & { index: number; pluginId: string; code: string };
type PendingExpand = { index: number; height: number; settled: boolean; release?: () => void };
type BrowserFixture = {
  mountFresh: () => Promise<void>;
  activationSnapshot: () => Array<{ index: number; pluginId: string; code: string; settled: boolean }>;
  resolveActivation: (index: number) => void;
  rejectActivation: (index: number, message: string) => void;
  holdNextPluginExpand: () => void;
  pluginExpandSnapshot: () => Array<{ index: number; height: number; settled: boolean }>;
  releasePluginExpand: (index: number) => void;
  commandSnapshot: (command: string) => Array<Record<string, unknown>>;
  resultCodes: { alpha: string; beta: string; gamma: string; queryA: string; queryB: string };
};
const allowedPlugins: SearchResult[] = [alphaPlugin, betaPlugin, gammaPlugin];
const previewPluginExpandHeight = 400;
const pluginByCode = new Map(allowedPlugins.map(plugin => [plugin.code, plugin]));
const listeners = new Map<number, { event: string; handler: number }>();
const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
const activations: PendingActivation[] = [];
const pluginExpansions: PendingExpand[] = [];
let app: ReturnType<typeof mount> | undefined;
let listenerId = 0;
let pluginExpandHolds = 0;
const setting = { localAppSearch: false, autoPaste: "never", pluginEscapeToSearch: true, showRecentInSearch: false };
mockWindows("main");
mockConvertFileSrc("macos");

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject, settled: false };
}

function recordInvokeArgs(rawArgs: InvokeArgs | undefined): Record<string, unknown> {
  if (rawArgs === undefined) return {};
  if (Array.isArray(rawArgs) || rawArgs instanceof ArrayBuffer || rawArgs instanceof Uint8Array) {
    throw Error("Browser fixture only authorizes record-shaped IPC arguments");
  }
  return rawArgs;
}

mockIPC((command, rawArgs) => {
  const args = recordInvokeArgs(rawArgs);
  if (command === "plugin:event|listen") {
    const id = ++listenerId;
    listeners.set(id, { event: String(args.event ?? ""), handler: Number(args.handler ?? 0) });
    return id;
  }
  if (command === "plugin:event|unlisten") { listeners.delete(Number(args.eventId)); return; }
  commands.push({ command, args: { ...args } });
  if (command === "get_setting") return JSON.stringify(setting);
  if (command === "set_setting") return;
  if (command === "feature_catalog") return allowedPlugins;
  if (command === "search_features") {
    const query = String(args.query ?? "");
    if (query === ordinaryPluginQuery) return [alphaPlugin, betaPlugin];
    if (query === "新插件") return [gammaPlugin];
    return [];
  }
  if (["list_pending_agent_requests", "search_local_apps"].includes(command)) return [];
  if (command === "get_accessibility_permission_status") return { supported: false, granted: true, detail: "browser QA fixture" };
  if (command === "plugin:path|resolve_directory") return "/fixture/home";
  if (command === "activate_feature") {
    const code = String(args.code ?? ""), plugin = pluginByCode.get(code);
    if (!plugin || args.expectedPluginId !== plugin.plugin_id) throw Error("Browser fixture rejected an unapproved activation owner/code");
    const gate = deferred<FeatureAction>();
    const item: PendingActivation = { ...gate, index: activations.length, pluginId: plugin.plugin_id, code };
    activations.push(item);
    item.resolve = value => { item.settled = true; gate.resolve(value); };
    item.reject = reason => { item.settled = true; gate.reject(reason); };
    return gate.promise;
  }
  if (command === "expand_window") {
    const height = Number(args.height);
    if (height !== previewPluginExpandHeight) return;
    const item: PendingExpand = { index: pluginExpansions.length, height, settled: false };
    pluginExpansions.push(item);
    if (pluginExpandHolds > 0) {
      pluginExpandHolds -= 1;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      item.release = () => { item.settled = true; release(); };
      return gate;
    }
    item.settled = true;
    return;
  }
  if ([
    "reset_window", "close_host_clipboard", "hide_main_window", "update_global_hotkey", "set_tray_icon_visible",
    "sync_app_shortcuts", "apply_settings", "apply_window_settings", "set_tray_visible", "set_launch_at_login",
    "update_app_shortcuts", "set_super_panel_visible", "set_floating_ball_visible", "set_main_window_opacity",
    "set_clipboard_retention_days", "plugin:autostart|enable", "plugin:autostart|disable",
  ].includes(command)) return;
  throw Error("Browser fixture did not authorize IPC: " + command);
});

function actionFor(code: string): FeatureAction {
  const plugin = pluginByCode.get(code);
  if (!plugin) throw Error("Unknown preview action code");
  return {
    plugin_id: plugin.plugin_id,
    plugin_name: plugin.plugin_name,
    feature_code: plugin.code,
    feature_label: plugin.label,
    feature_label_source: "declared",
    main_url: "index.html",
    plugin_path: "__atools_plugin_host_preview__",
    expand_height: previewPluginExpandHeight,
    plugin_permissions: [],
    payload: { srcdoc: `<!doctype html><html><body><main>${plugin.plugin_name} browser preview</main></body></html>` },
  };
}

export async function mountFresh() {
  if (app) await unmount(app);
  localStorage.clear();
  localStorage.setItem("atools:settings-general", JSON.stringify(setting));
  commands.length = 0; activations.length = 0; pluginExpansions.length = 0; listeners.clear(); pluginExpandHolds = 0;
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync(); await tick();
}

const fixture: BrowserFixture = {
  mountFresh,
  activationSnapshot: () => activations.map(({ index, pluginId, code, settled }) => ({ index, pluginId, code, settled })),
  resolveActivation(index) {
    const item = activations[index];
    if (!item || item.settled) throw Error("Activation is missing or already settled: " + index);
    item.resolve(actionFor(item.code));
  },
  rejectActivation(index, message) {
    const item = activations[index];
    if (!item || item.settled) throw Error("Activation is missing or already settled: " + index);
    item.reject(new Error(message));
  },
  holdNextPluginExpand() { pluginExpandHolds += 1; },
  pluginExpandSnapshot: () => pluginExpansions.map(({ index, height, settled }) => ({ index, height, settled })),
  releasePluginExpand(index) {
    const item = pluginExpansions[index];
    if (!item?.release || item.settled) throw Error("Plugin expansion is missing or already settled: " + index);
    item.release();
  },
  commandSnapshot(command) { return commands.filter(call => call.command === command).map(call => ({ ...call.args })); },
  resultCodes: { alpha: alphaPlugin.code, beta: betaPlugin.code, gamma: gammaPlugin.code, queryA: ordinaryPluginQuery, queryB: "新插件" },
};
(window as Window & { launcherPendingPluginFixture?: BrowserFixture }).launcherPendingPluginFixture = fixture;
