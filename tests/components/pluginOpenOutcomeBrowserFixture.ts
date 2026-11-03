import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { FeatureAction, InstalledPlugin } from "../../src/lib/types";

const previewPath = "__atools_plugin_host_preview__";
const featureCode = "fixture-open-feature";
const pluginPath = "/synthetic/plugins/plugin-open-outcome";
const settings = {
  pluginMarketCustom: false,
  pluginMarketUrl: "https://fixture.invalid/offline-market",
  pluginMarketTrustedPublicKeys: [],
  localAppSearch: false,
  autoPaste: "never",
};

type NativeCall = { command: string; args: Record<string, unknown> | null };
const calls: NativeCall[] = [];
const unexpectedCommands: string[] = [];
const plugins = new Map<string, InstalledPlugin>();
const eventHandlers = new Map<number, { name: string; handler: number }>();
let nextEventId = 0;
let installIndex = 0;
let activationIndex = 0;
let rejectFirstActivation = true;
let pendingFirstReject: ((error: Error) => void) | null = null;
let pendingLeaveResolve: ((action: FeatureAction) => void) | null = null;
let app: ReturnType<typeof mount> | undefined;

function installedPlugin(id: string, title: string, enabled: boolean): InstalledPlugin {
  return {
    id,
    name: id,
    title,
    version: "1.0.0",
    path: `${pluginPath}/${id}`,
    enabled,
    manifest: {
      title,
      main: "index.html",
      features: [{ code: featureCode, label: "演示功能", explain: "离线打开结果验收" }],
    },
  } as InstalledPlugin;
}

function activatedPlugin(id: string, title: string): FeatureAction {
  return {
    plugin_id: id,
    plugin_name: title,
    feature_code: featureCode,
    feature_label: "演示功能",
    feature_label_source: "command_label",
    main_url: "index.html",
    plugin_path: previewPath,
    expand_height: 541,
    plugin_permissions: [],
    payload: {
      srcdoc: `<!doctype html><html><body><main data-fixture-plugin="${id}"><h1>${title}</h1><p>仅使用合成激活结果验证插件面板挂载。</p></main></body></html>`,
    },
  };
}

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  if (command === "plugin:event|listen") {
    const id = ++nextEventId;
    eventHandlers.set(id, { name: String(args?.event), handler: Number(args?.handler) });
    return id;
  }
  if (command === "plugin:event|unlisten") {
    eventHandlers.delete(Number(args?.eventId));
    return;
  }
  calls.push({ command, args });
  switch (command) {
    case "get_setting": return JSON.stringify(settings);
    case "set_setting": return;
    case "feature_catalog":
    case "search_features":
    case "list_pending_agent_requests":
    case "search_local_apps": return [];
    case "list_plugins": return [...plugins.values()];
    case "plugin:dialog|open": return `${pluginPath}/plugin-${++installIndex}`;
    case "install_plugin": {
      const plugin = installedPlugin(installIndex === 1 ? "fixture-open-retry" : "fixture-open-leave", installIndex === 1 ? "打开失败后可重试" : "离开后取消挂载", false);
      plugins.set(plugin.id, plugin);
      return plugin;
    }
    case "authorize_plugin_permissions": {
      const id = String(args?.pluginId ?? "");
      const current = plugins.get(id);
      if (!current) throw new Error("Unknown synthetic plugin");
      const enabled = { ...current, enabled: true };
      plugins.set(id, enabled);
      return enabled;
    }
    case "activate_feature": {
      activationIndex += 1;
      if (rejectFirstActivation) {
        rejectFirstActivation = false;
        return new Promise<FeatureAction>((_resolve, reject) => { pendingFirstReject = reject; });
      }
      const owner = String(args?.expectedPluginId ?? "");
      if (activationIndex === 3) {
        return new Promise<FeatureAction>((resolve) => { pendingLeaveResolve = resolve; });
      }
      const plugin = plugins.get(owner);
      if (!plugin?.enabled) throw new Error("Synthetic plugin owner is not enabled");
      return activatedPlugin(owner, plugin.title || plugin.name);
    }
    case "expand_window":
    case "reset_window":
    case "show_main_window":
    case "hide_main_window":
    case "get_accessibility_permission_status":
    case "get_home_dir": return command === "get_accessibility_permission_status" ? { supported: false, trusted: false } : null;
    case "system_get_path": return "/synthetic/home";
    default:
      unexpectedCommands.push(command);
      throw new Error(`Unexpected synthetic IPC command: ${command}`);
  }
});

async function mountFresh() {
  if (app) await unmount(app);
  app = undefined;
  calls.length = 0;
  unexpectedCommands.length = 0;
  plugins.clear();
  eventHandlers.clear();
  installIndex = 0;
  activationIndex = 0;
  rejectFirstActivation = true;
  pendingFirstReject = null;
  pendingLeaveResolve = null;
  localStorage.clear();
  localStorage.setItem("atools:settings-general", JSON.stringify(settings));
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync();
  await tick();
}

async function dispose() {
  pendingLeaveResolve = null;
  if (app) await unmount(app);
  app = undefined;
}

export const fixture = {
  calls,
  unexpectedCommands,
  get activationIndex() { return activationIndex; },
  get pendingFirst() { return Boolean(pendingFirstReject); },
  get pendingLeave() { return Boolean(pendingLeaveResolve); },
  rejectFirst() {
    const reject = pendingFirstReject;
    pendingFirstReject = null;
    reject?.(new Error("Synthetic activation rejection; private data must not reach UI"));
  },
  resolveLeave() {
    const resolve = pendingLeaveResolve;
    pendingLeaveResolve = null;
    if (resolve) resolve(activatedPlugin("fixture-open-leave", "离开后取消挂载"));
  },
  mountFresh,
  dispose,
};
Object.assign(window, { pluginOpenOutcomeFixture: fixture });
void mountFresh();
