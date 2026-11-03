import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import SystemPanel from "../../src/components/SystemPanel.svelte";
import SettingsPanel from "../../src/components/SettingsPanel.svelte";
import PluginMarketPanel from "../../src/components/PluginMarketPanel.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { DEFAULT_ZTOOLS_MARKET_URL } from "../../src/lib/pluginMarketView";
import type { InstalledPlugin, PluginMarketCatalog, PluginMarketCatalogPlugin, ZToolsImportCandidate } from "../../src/lib/types";

const customSource = "https://fixture.invalid/custom-market";
const settings = {
  pluginMarketCustom: true,
  pluginMarketUrl: customSource,
  pluginMarketTrustedPublicKeys: [],
  localAppSearch: false,
  autoPaste: "never",
};
const sourceCandidate: ZToolsImportCandidate = {
  path: "/fixture/community/regex-editor",
  source_type: "directory",
  entry_readiness: "requires_build",
  name: "regex-editor",
  title: "正则可视编辑器",
  version: "1.0.0",
  features_count: 1,
  platform_supported: true,
  main_exists: true,
  preload_exists: true,
  logo_exists: true,
  unsupported_cmd_types: [],
  warnings: [],
  errors: [],
};
const exactPlugin: PluginMarketCatalogPlugin = {
  id: "regex-editor", name: "Regex Editor", version: "1.0.1",
  description: "Synthetic exact ID release candidate", trust_policy: "official_ztools_confirm",
};
const similarPlugin: PluginMarketCatalogPlugin = {
  id: "regex-editor-legacy", name: "正则可视编辑器旧版", version: "2.0.0",
  description: "Synthetic similarly named but different ID", trust_policy: "official_ztools_confirm",
};
const customPlugin: PluginMarketCatalogPlugin = {
  id: "custom-only", name: "Fixture custom catalog", version: "0.1.0",
  description: "Synthetic custom source entry", trust_policy: "signed_required",
};

type Call = { command: string; args: Record<string, unknown> | null };
type TargetMode = "available" | "not_found" | "unsupported_platform" | "error";
const calls: Call[] = [];
const unexpectedCommands: string[] = [];
const eventListeners = new Map<number, { event: string; handler: number }>();
let listenerSequence = 0;
let app: ReturnType<typeof mount> | undefined;
let installed: InstalledPlugin[] = [];
let targetMode: TargetMode = "available";

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  if (command === "plugin:event|listen") {
    const id = ++listenerSequence;
    eventListeners.set(id, { event: String(args?.event), handler: Number(args?.handler) });
    return id;
  }
  if (command === "plugin:event|unlisten") {
    eventListeners.delete(Number(args?.eventId));
    return;
  }
  calls.push({ command, args });
  switch (command) {
    case "get_setting":
      return JSON.stringify(settings);
    case "set_setting":
      return;
    case "feature_catalog":
    case "search_features":
    case "list_pending_agent_requests":
    case "search_local_apps":
      return [];
    case "scan_default_ztools_plugins":
      return [sourceCandidate];
    case "scan_ztools_plugins":
      return [sourceCandidate];
    case "list_plugins":
      return installed;
    case "fetch_official_plugin_target": {
      if (targetMode === "error") throw new Error("Synthetic official target lookup failure");
      const pluginId = String(args?.pluginId ?? "");
      return {
        plugin_id: pluginId,
        source_url: DEFAULT_ZTOOLS_MARKET_URL,
        source_kind: "ztools",
        status: targetMode,
        plugin: targetMode === "available" && pluginId === exactPlugin.id ? exactPlugin : null,
      };
    }
    case "fetch_plugin_market_catalog": {
      const url = String(args?.url ?? "");
      const official = url === DEFAULT_ZTOOLS_MARKET_URL;
      const catalog: PluginMarketCatalog = {
        source_url: url,
        source_kind: official ? "ztools" : "atools",
        plugins: official ? [exactPlugin, similarPlugin] : [customPlugin],
      };
      return catalog;
    }
    case "resolve_plugin_market_download":
      return { download_url: "https://ztools.zosen.link/__fixture__/never-downloaded.zip", package_format: "zip", trust_policy: "official_ztools_confirm" };
    case "install_plugin_from_market": {
      const plugin: InstalledPlugin = {
        id: "regex-editor",
        name: "regex-editor",
        path: "/fixture/installed/regex-editor",
        version: "1.0.1",
        enabled: false,
        manifest: { title: "Regex Editor", features: [] },
      } as InstalledPlugin;
      installed = [plugin];
      return plugin;
    }
    case "update_plugin_from_market": {
      const plugin: InstalledPlugin = {
        id: "regex-editor",
        name: "regex-editor",
        path: "/fixture/installed/regex-editor",
        version: "1.0.1",
        enabled: false,
        manifest: { title: "Regex Editor", features: [] },
      } as InstalledPlugin;
      installed = [plugin];
      return plugin;
    }
    case "expand_window":
    case "reset_window":
    case "show_main_window":
    case "hide_main_window":
    case "get_accessibility_permission_status":
    case "get_home_dir":
      return command === "get_accessibility_permission_status" ? { supported: false, trusted: false } : null;
    case "system_get_path":
      return "/fixture/home";
    case "open_url":
      return null;
    case "call_agent_tool":
      if (args?.name === "open_url" && args.arguments && typeof args.arguments === "object"
        && (args.arguments as Record<string, unknown>).url === "https://z-tools.top/api/market") return null;
      unexpectedCommands.push(command);
      return null;
    default:
      unexpectedCommands.push(command);
      return null;
  }
});

export async function mountFresh() {
  if (app) await unmount(app);
  calls.length = 0;
  unexpectedCommands.length = 0;
  installed = [];
  targetMode = "available";
  listenerSequence = 0;
  eventListeners.clear();
  localStorage.clear();
  localStorage.setItem("atools:settings-general", JSON.stringify(settings));
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync();
  await tick();
}

export async function dispose() {
  if (!app) return;
  await unmount(app);
  app = undefined;
}

export const fixture = {
  calls,
  unexpectedCommands,
  settings,
  customSource,
  officialSource: DEFAULT_ZTOOLS_MARKET_URL,
  setTargetMode(mode: TargetMode) { targetMode = mode; },
  setInstalledVersion(version: string) { installed = installed.map(plugin => ({ ...plugin, version })); },
  mountFresh,
  dispose,
};
Object.assign(window, { pluginMarketRecoveryFixture: fixture });
void [SystemPanel, SettingsPanel, PluginMarketPanel];
void mountFresh();
