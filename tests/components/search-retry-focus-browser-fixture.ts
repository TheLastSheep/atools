import App from "../../src/App.svelte";
import "../../src/components/SettingsPanel.svelte";
import "../../src/components/PluginPanel.svelte";
import { flushSync, mount, tick } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { AToolsSettings } from "../../src/lib/settings";
import type { FeatureAction } from "../../src/lib/types";
import { DEFAULT_ATOOLS_SETTINGS, SETTINGS_STORAGE_KEY, dispatchAToolsSettings } from "../../src/lib/settings";
import { alphaPlugin } from "./launcherReturnContextFixture";

const queryPrefix = "qa-retry-";
const counts = { searches: 0, activations: 0 };
const listeners = new Map<number, { event: string; handler: number }>();
let listenerId = 0;
let settings: AToolsSettings = {
  ...DEFAULT_ATOOLS_SETTINGS,
  localAppSearch: true,
  showRecentInSearch: false,
  autoPaste: "never",
  pluginEscapeToSearch: true,
  tabKeyFunction: "navigate",
  tabTarget: { pluginId: alphaPlugin.plugin_id, code: alphaPlugin.code, label: alphaPlugin.label },
};

function recordArgs(raw: InvokeArgs | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  if (Array.isArray(raw) || raw instanceof ArrayBuffer || raw instanceof Uint8Array) throw Error("Fixture only accepts record IPC arguments");
  return raw;
}

function refreshCounts() {
  const output = document.getElementById("fixture-counts");
  if (output) output.textContent = `搜索 ${counts.searches} 次，启动 ${counts.activations} 次`;
}

function featureAction(): FeatureAction {
  return {
    plugin_id: alphaPlugin.plugin_id,
    plugin_name: alphaPlugin.plugin_name,
    feature_code: alphaPlugin.code,
    feature_label: alphaPlugin.label,
    feature_label_source: "declared",
    main_url: "index.html",
    plugin_path: "__atools_plugin_host_preview__",
    expand_height: 400,
    plugin_permissions: [],
    payload: { srcdoc: `<!doctype html><main>${alphaPlugin.label} QA preview</main>` },
  };
}

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = recordArgs(rawArgs);
  if (command === "plugin:event|listen") {
    const id = ++listenerId;
    listeners.set(id, { event: String(args.event ?? ""), handler: Number(args.handler ?? 0) });
    return id;
  }
  if (command === "plugin:event|unlisten") { listeners.delete(Number(args.eventId)); return; }
  if (command === "get_setting") return JSON.stringify(settings);
  if (command === "set_setting") return;
  if (command === "feature_catalog") return [alphaPlugin];
  if (command === "search_features") {
    counts.searches += 1;
    refreshCounts();
    const query = String(args.query ?? "");
    if (!query.startsWith(queryPrefix)) return [];
    return [alphaPlugin];
  }
  if (command === "search_local_apps") return Promise.reject(new Error("Fixture keeps the search in a partial-results state"));
  if (command === "load_local_app_icons") return {};
  if (["list_pending_agent_requests", "search_text_content_features"].includes(command)) return [];
  if (command === "search_file_content_features") return { files: [], results: [] };
  if (command === "get_accessibility_permission_status") return { supported: false, granted: true, detail: "browser fixture" };
  if (command === "activate_feature") {
    if (args.code !== alphaPlugin.code || args.expectedPluginId !== alphaPlugin.plugin_id) throw Error("Fixture rejected an unexpected feature identity");
    counts.activations += 1;
    refreshCounts();
    return featureAction();
  }
  if (command === "expand_window") return;
  if ([
    "reset_window", "close_host_clipboard", "hide_main_window", "update_global_hotkey", "set_tray_icon_visible",
    "sync_app_shortcuts", "apply_settings", "apply_window_settings", "set_tray_visible", "set_launch_at_login",
    "update_app_shortcuts", "set_super_panel_visible", "set_floating_ball_visible", "set_main_window_opacity",
    "set_clipboard_retention_days", "plugin:autostart|enable", "plugin:autostart|disable",
  ].includes(command)) return;
  throw Error(`Fixture denied unknown IPC: ${command}`);
});

function setTabMode(value: string) {
  const tabKeyFunction = value === "target-command" ? "target-command" : "navigate";
  settings = { ...settings, tabKeyFunction };
  dispatchAToolsSettings(settings);
}

function resetFixture() {
  counts.searches = 0;
  counts.activations = 0;
  setTabMode("navigate");
  const mode = document.getElementById("tab-mode") as HTMLSelectElement | null;
  if (mode) mode.value = "navigate";
  const input = document.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]');
  if (input) {
    input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.focus();
  }
  refreshCounts();
}

export async function mountRetryFocusFixture() {
  settings = { ...settings, localAppSearch: true, tabKeyFunction: "navigate" };
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  const appTarget = document.getElementById("app");
  if (!appTarget) throw Error("App mount target is missing");
  mount(App, { target: appTarget, props: { backgroundServices: false } });
  flushSync();
  await tick();
  document.getElementById("tab-mode")?.addEventListener("change", event => {
    setTabMode((event.currentTarget as HTMLSelectElement).value);
  });
  document.getElementById("reset-fixture")?.addEventListener("click", resetFixture);
  refreshCounts();
}
