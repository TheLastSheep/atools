import App from "../../src/App.svelte";
// Discover fixture-only lazy dependencies before mounting so Vite does not reload mid-scenario.
import "../../src/components/SettingsPanel.svelte";
import "../../src/components/PluginPanel.svelte";
import { mount, unmount, tick, flushSync } from "svelte";
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { SearchResult, FeatureAction } from "../../src/lib/types";
const feature: SearchResult = { code: "convert", plugin_id: "converter", plugin_name: "转换工具", label: "字符转换", explain: "文本工具", icon: null, score: 10, match_type: "catalog" };
const other: SearchResult = { ...feature, code: "unrelated", plugin_id: "other", label: "其他工具", score: 100 };
let app: ReturnType<typeof mount> | undefined;
let unavailable = false, collide = false, zeroResults = false, seq = 0;
let holdActivation = false;
const pendingActivations: Array<() => void> = [];
const listeners = new Map<number, { event: string; handler: number }>();
export const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
const initial = { localAppSearch: false, autoPaste: "never", tabKeyFunction: "target-command" };
mockWindows("main"); mockConvertFileSrc("macos");
mockIPC((command, args = {}) => {
  if (command === "plugin:event|listen") { const id = ++seq; listeners.set(id, { event: args.event as string, handler: args.handler as number }); return id; }
  if (command === "plugin:event|unlisten") { listeners.delete(args.eventId as number); return; }
  calls.push({ command, args });
  if (command === "get_setting") return localStorage.getItem("atools:settings-general") || JSON.stringify(initial);
  if (command === "set_setting") { localStorage.setItem("atools:settings-general", String(args.value)); return; }
  if (command === "feature_catalog") return unavailable ? [other] : collide ? [feature, { ...feature, plugin_id: "intruder" }] : [feature, other];
  if (command === "search_features") return zeroResults ? [] : [other];
  if (["list_pending_agent_requests", "search_local_apps"].includes(command)) return [];
  if (command === "activate_feature") {
    if (args.expectedPluginId !== "converter" || args.code !== "convert" || unavailable || collide) throw Error("Fixture owner mismatch");
    const action = { plugin_id: "converter", plugin_name: "转换工具", feature_code: "convert", feature_label: "字符转换", feature_label_source: "declared",
      main_url: "index.html", plugin_path: "__atools_plugin_host_preview__", expand_height: 400, payload: args.payload } satisfies FeatureAction;
    return holdActivation ? new Promise<FeatureAction>(resolve => pendingActivations.push(() => resolve(action))) : action;
  }
  if (command === "get_accessibility_permission_status") return { supported: false, granted: true, detail: "离线夹具" };
  if (command === "plugin:path|resolve_directory") return "/fixture/home";
  if (["expand_window", "reset_window", "close_host_clipboard", "hide_main_window", "update_global_hotkey", "set_tray_icon_visible", "sync_app_shortcuts", "apply_settings", "apply_window_settings", "set_tray_visible", "set_launch_at_login", "update_app_shortcuts", "set_super_panel_visible", "set_floating_ball_visible", "set_main_window_opacity", "set_clipboard_retention_days", "plugin:autostart|enable", "plugin:autostart|disable"].includes(command)) return;
  throw Error("Tab target fixture did not authorize IPC: " + command);
});
export async function mountFresh(seed = false) {
  if (app) await unmount(app);
  if (seed) { localStorage.clear(); localStorage.setItem("atools:settings-general", JSON.stringify(initial)); }
  calls.length = 0;
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } }); flushSync(); await tick();
}
export function setAvailability(state: string) { unavailable = state === "missing"; collide = state === "collision"; zeroResults = state === "zero"; }

export function deferActivation() { holdActivation = true; }
export function pendingActivationCount() { return pendingActivations.length; }
export function releaseActivations() { holdActivation = false; for (const resolve of pendingActivations.splice(0)) resolve(); }
