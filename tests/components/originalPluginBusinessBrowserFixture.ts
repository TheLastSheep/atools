import App from "../../src/App.svelte";
import { mount, unmount, tick, flushSync } from "svelte";
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { FeatureAction, SearchResult } from "../../src/lib/types";
export { provideOriginalImagePaste } from "./originalPluginBrowserImageFixture";
import { originalImageDataUrl } from "./originalPluginBrowserImageFixture";

// Read unchanged package bytes. No original runtime callback or business operation is mocked.
const originals = import.meta.glob("/ZTools-plugins/plugins/{subnet-calculator,uuid-kit,image-stitch}/**/*.{html,js,json,css}",
  { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const workspace = new URL(location.href).searchParams.get("workspace") || "";
if (!workspace.startsWith("/") || workspace.includes("..") || workspace.endsWith("/")) throw Error("Explicit absolute fixture workspace required");
const root = `${workspace}/ZTools-plugins/plugins/`;
const cases = [{ id: "subnet-calculator", code: "subnet", label: "子网" }, { id: "uuid-kit", code: "gen", label: "uuid" }];
const imageManifest = JSON.parse(originals["/ZTools-plugins/plugins/image-stitch/plugin.json"]);
if (!imageManifest.features.some((feature: { code: string; cmds: { type?: string }[] }) => feature.code === "image-stitch-img"
  && feature.cmds.some(command => command.type === "img"))) throw Error("Original image manifest img entry changed");
const imageFeature: SearchResult = { code: "image-stitch-img", plugin_id: "image-stitch", plugin_name: imageManifest.title,
  label: "拼接图片", explain: "拼接剪贴板图片", icon: null, score: 100, match_type: "img", content_search_terms: ["图片拼接", "image stitch"] };
const features: SearchResult[] = cases.map(item => {
  const manifest = JSON.parse(originals[`/ZTools-plugins/plugins/${item.id}/plugin.json`]);
  const feature = manifest.features.find((candidate: { code: string }) => candidate.code === item.code);
  if (!feature || !feature.cmds.includes(item.label)) throw Error("Original manifest entry changed");
  return { code: item.code, plugin_id: item.id, plugin_name: manifest.title, label: item.label,
    explain: feature.explain, icon: null, score: 100, match_type: "exact" };
});
const listeners = new Map<number, string>();
let sequence = 0;
let app: ReturnType<typeof mount> | undefined;
export const calls: Array<{ command: string; args: unknown }> = [];
export const rejected: string[] = [];
export const hostDoubles = { nativePermissions: "clipboard/data/path/dialog unavailable; Node session explicitly fixture-preapproved", fileReads: "unchanged original package text bytes",
  imageNodeAnalysis: "faithful detected/requiresNode=true/entryMode=page from current Rust classifier; actual current Node bootstrap/codec protocol, native permission and TaskRun not exercised", nativeClipboardMedia: "null files-only response; image bytes come from fixture FileReader" };
export const events: Array<{ type: string; trusted: boolean; target: string; key?: string }> = [];
for (const type of ["pointerdown", "keydown", "beforeinput", "input"]) document.addEventListener(type, event => {
  const node = event.target as Element;
  events.push({ type, trusted: event.isTrusted, target: node?.id || node?.getAttribute?.("aria-label") || node?.tagName || "",
    ...(event instanceof KeyboardEvent ? { key: event.key } : {}) });
}, true);

function readOriginal(path: unknown) {
  if (typeof path !== "string" || !path.startsWith(root)) throw Error("Original read outside three pinned packages");
  const relative = path.slice(root.length);
  if (![...cases.map(item => item.id), "image-stitch"].some(id => relative.startsWith(id + "/")) || relative.split("/").some(p => p === ".." || p === ".")) throw Error("Original path rejected");
  const text = originals[`/ZTools-plugins/plugins/${relative}`];
  if (typeof text !== "string") throw Error("Unregistered original text file: " + relative);
  return text;
}
mockWindows("main"); mockConvertFileSrc("macos");
mockIPC(async (command, args) => {
  calls.push({ command, args });
  if (command === "plugin:event|listen") { const id = ++sequence; listeners.set(id, String(args?.event)); return id; }
  if (command === "plugin:event|unlisten") { listeners.delete(Number(args?.eventId)); return; }
  if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
  if (command === "feature_catalog") return features;
  if (command === "search_features") return features.filter(item => item.label.toLowerCase().includes(String(args?.query || "").toLowerCase()));
  if (command === "read_launcher_clipboard_media" && args?.filesOnly === true) return null;
  if (command === "search_image_content_features") return [imageFeature];
  if (command === "activate_image_content_feature") {
    if (args?.code !== imageFeature.code || args?.expectedPluginId !== imageFeature.plugin_id || args?.dataUrl !== originalImageDataUrl) throw Error("Original image activation owner/bytes changed");
    return { plugin_id: imageFeature.plugin_id, plugin_name: imageFeature.plugin_name, feature_code: imageFeature.code,
      feature_label: imageFeature.label, main_url: imageManifest.main, plugin_path: `${root}image-stitch`, expand_height: 640,
      plugin_permissions: [], payload: args.dataUrl, entry_type: "img" } satisfies FeatureAction;
  }
  if (command === "plugin_legacy_node_usage" && args?.pluginId === "image-stitch") return { usage: "detected", requiresNode: true, entryMode: "page" };
  if (["prepare_legacy_node", "get_legacy_node_session", "close_legacy_node"].includes(command)) {
    const request = (window as unknown as { __originalNodeHostRequest: (command: string, args: unknown) => Promise<unknown> }).__originalNodeHostRequest;
    if (typeof request !== "function") throw Error("Faithful Node fixture host is not connected");
    return request(command, args);
  }
  if (command === "list_pending_agent_requests" || command === "search_local_apps") return [];
  if (command === "activate_feature") {
    const selected = features.find(item => item.code === args?.code && item.plugin_id === args?.expectedPluginId);
    if (!selected) throw Error("Original activation owner differs");
    const manifest = JSON.parse(readOriginal(`${root}${selected.plugin_id}/plugin.json`));
    return { plugin_id: selected.plugin_id, plugin_name: selected.plugin_name, feature_code: selected.code,
      feature_label: selected.label, main_url: manifest.main, plugin_path: `${root}${selected.plugin_id}`,
      preload_path: `${root}${selected.plugin_id}/${manifest.preload}`, expand_height: 640, plugin_permissions: [], payload: args?.payload ?? null } satisfies FeatureAction;
  }
  if (command === "plugin:fs|read_text_file") return Array.from(new TextEncoder().encode(readOriginal(args?.path)));
  if (command === "read_plugin_preload_module") {
    const id = String(args?.pluginId), path = String(args?.modulePath);
    if (!cases.some(item => item.id === id) || !path.startsWith(root + id + "/")) throw Error("Original preload owner differs");
    return readOriginal(path);
  }
  if (["prepare_plugin_data", "prepare_plugin_paths", "prepare_plugin_dialogs", "prepare_plugin_display", "prepare_host_clipboard"].includes(command)) {
    if (args?.requestPermission !== false) throw Error("This verifier grants no native permissions");
    return { unavailable: true, usage: "not_detected" };
  }
  if (["close_plugin_data", "close_plugin_paths", "close_plugin_dialogs", "close_host_clipboard", "expand_window", "reset_window"].includes(command)) return;
  rejected.push(command); throw Error("Original browser fixture did not authorize IPC: " + command);
});
export async function mountFixture() {
  localStorage.clear();
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync(); await tick();
}
export async function dispose() {
  if (app) { await unmount(app); app = undefined; } await tick();
  // Production onDestroy fires asynchronous controller drains; observe their actual unlisten completion.
  const deadline = performance.now() + 1000;
  while (listeners.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return { listeners: listeners.size, remaining: [...listeners.values()] };
}
