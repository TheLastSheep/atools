import App from "../../src/App.svelte";
import "../../src/components/SettingsPanel.svelte";
import "../../src/components/PluginPanel.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { FeatureAction, SearchResult } from "../../src/lib/types";
import { alphaPlugin, betaPlugin, gammaPlugin } from "./launcherReturnContextFixture";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void };
type SearchCall = { command: "search_features" | "search_local_apps"; query: string; attempt: number };
type BrowserFixture = {
  codes: { retryQuery: string; emptyErrorQuery: string; staleQuery: string; newestQuery: string; activationQuery: string; alpha: string; custom: string; beta: string; gamma: string; terminal: string };
  calls: (command: SearchCall["command"], query?: string) => SearchCall[];
  activations: () => Array<{ code: string; pluginId: string }>;
  settle: (command: SearchCall["command"], query: string, attempt: number, mode: "resolve" | "reject", rows?: SearchResult[]) => void;
};
const codes = {
  retryQuery: "retry-flow-qa-1440", emptyErrorQuery: "empty-error-qa-1440", staleQuery: "stale-search-qa-1440", newestQuery: "latest-search-qa-1440",
  activationQuery: "activate-selected-qa-1440", alpha: alphaPlugin.code, beta: betaPlugin.code,
  custom: "local-app:custom", gamma: gammaPlugin.code, terminal: "local-app:/Applications/QA-Terminal.app",
};
const customFeature: SearchResult = { ...alphaPlugin, code: codes.custom, plugin_id: "custom-feature-plugin",
  plugin_name: "第三方插件", label: "Custom feature", explain: "third-party feature row", score: 150 };
const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
const searchCalls: SearchCall[] = [];
const pending = new Map<string, Deferred<SearchResult[]>>();
const activations: Array<{ code: string; pluginId: string }> = [];
const listeners = new Map<number, { event: string; handler: number }>();
const rowsByCode = new Map([[alphaPlugin.code, alphaPlugin], [betaPlugin.code, betaPlugin], [gammaPlugin.code, gammaPlugin], [customFeature.code, customFeature]]);
let app: ReturnType<typeof mount> | undefined;
let listenerId = 0;
let localAppSearch = false;
mockWindows("main");
mockConvertFileSrc("macos");

function key(command: string, query: string, attempt: number) { return `${command}\n${query}\n${attempt}`; }
function defer(command: SearchCall["command"], query: string, attempt: number): Promise<SearchResult[]> {
  const gate: Deferred<SearchResult[]> = { promise: Promise.resolve([]), resolve: () => {}, reject: () => {} };
  gate.promise = new Promise<SearchResult[]>((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
  pending.set(key(command, query, attempt), gate);
  return gate.promise;
}
function recordArgs(raw: InvokeArgs | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  if (Array.isArray(raw) || raw instanceof ArrayBuffer || raw instanceof Uint8Array) throw Error("Fixture only accepts record IPC arguments");
  return raw;
}
function featureAction(code: string): FeatureAction {
  const row = rowsByCode.get(code);
  if (!row) throw Error("Fixture refused an unowned feature code");
  return {
    plugin_id: row.plugin_id, plugin_name: row.plugin_name, feature_code: row.code, feature_label: row.label,
    feature_label_source: "declared", main_url: "index.html", plugin_path: "__atools_plugin_host_preview__",
    expand_height: 400, plugin_permissions: [], payload: { srcdoc: `<!doctype html><main>${row.label} browser QA preview</main>` },
  };
}
function search(command: SearchCall["command"], query: string): Promise<SearchResult[]> {
  const attempt = searchCalls.filter(call => call.command === command && call.query === query).length + 1;
  searchCalls.push({ command, query, attempt });
  if (query === codes.emptyErrorQuery) return Promise.reject(new Error(`fixture ${command} unavailable`));
  if (query === codes.retryQuery) {
    if (command === "search_features") {
      if (attempt === 1) return Promise.resolve([alphaPlugin, customFeature, betaPlugin]);
      return defer(command, query, attempt);
    }
    if (attempt === 1) return Promise.reject(new Error("fixture local-app source unavailable"));
    return defer(command, query, attempt);
  }
  if (command === "search_features" && query === codes.staleQuery) return defer(command, query, attempt);
  if (command === "search_features" && query === codes.newestQuery) return Promise.resolve([gammaPlugin]);
  if (command === "search_features" && query === codes.activationQuery) return Promise.resolve([alphaPlugin, betaPlugin]);
  return Promise.resolve([]);
}

mockIPC((command, rawArgs) => {
  const args = recordArgs(rawArgs);
  if (command === "plugin:event|listen") {
    const id = ++listenerId;
    listeners.set(id, { event: String(args.event ?? ""), handler: Number(args.handler ?? 0) });
    return id;
  }
  if (command === "plugin:event|unlisten") { listeners.delete(Number(args.eventId)); return; }
  commands.push({ command, args: { ...args } });
  if (command === "get_setting") return JSON.stringify({ localAppSearch, autoPaste: "never", pluginEscapeToSearch: true, showRecentInSearch: false, theme: "light" });
  if (command === "set_setting") return;
  if (command === "feature_catalog") return [alphaPlugin, betaPlugin, gammaPlugin];
  if (command === "search_features" || command === "search_local_apps") return search(command, String(args.query ?? ""));
  if (command === "load_local_app_icons") return {};
  if (["list_pending_agent_requests", "search_text_content_features"].includes(command)) return [];
  if (command === "search_file_content_features") return { files: [], results: [] };
  if (command === "get_accessibility_permission_status") return { supported: false, granted: true, detail: "browser QA fixture" };
  if (command === "plugin:path|resolve_directory") return "/fixture/home";
  if (command === "activate_feature") {
    const code = String(args.code ?? ""), pluginId = String(args.expectedPluginId ?? "");
    const row = rowsByCode.get(code);
    if (!row || row.plugin_id !== pluginId) throw Error("Fixture rejected an unapproved activation owner/code");
    activations.push({ code, pluginId });
    return featureAction(code);
  }
  if (command === "expand_window") return;
  if ([
    "reset_window", "close_host_clipboard", "hide_main_window", "update_global_hotkey", "set_tray_icon_visible",
    "sync_app_shortcuts", "apply_settings", "apply_window_settings", "set_tray_visible", "set_launch_at_login",
    "update_app_shortcuts", "set_super_panel_visible", "set_floating_ball_visible", "set_main_window_opacity",
    "set_clipboard_retention_days", "plugin:autostart|enable", "plugin:autostart|disable",
  ].includes(command)) return;
  throw Error("Browser fixture did not authorize IPC: " + command);
});

export async function mountFresh() {
  if (app) await unmount(app);
  localStorage.clear();
  const scenario = new URLSearchParams(location.search).get("scenario");
  localAppSearch = scenario === "retry-flow" || scenario === "empty-error";
  localStorage.setItem("atools:settings-general", JSON.stringify({ localAppSearch, autoPaste: "never", pluginEscapeToSearch: true,
    showRecentInSearch: false, theme: "light" }));
  commands.length = 0; searchCalls.length = 0; pending.clear(); activations.length = 0; listeners.clear(); listenerId = 0;
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync(); await tick();
}
const fixture: BrowserFixture = {
  codes,
  calls: (command, query) => searchCalls.filter(call => call.command === command && (query === undefined || call.query === query)),
  activations: () => activations.map(item => ({ ...item })),
  settle(command, query, attempt, mode, rows = []) {
    const gate = pending.get(key(command, query, attempt));
    if (!gate) throw Error(`No held ${command} call for ${query} attempt ${attempt}`);
    pending.delete(key(command, query, attempt));
    if (mode === "resolve") gate.resolve(rows);
    else gate.reject(new Error(`fixture ${command} attempt ${attempt} rejected`));
  },
};
(window as Window & { launcherSearchRetryBrowserFixture?: BrowserFixture }).launcherSearchRetryBrowserFixture = fixture;
