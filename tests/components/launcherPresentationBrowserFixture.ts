import App from "../../src/App.svelte";
import { mount } from "svelte";
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { FeatureAction, SearchResult } from "../../src/lib/types";

/** Frontend-only offline fixture. Native catalog resolution is verified separately. */
const rows: SearchResult[] = [
  { code: "color", plugin_id: "color-helper", plugin_name: "颜色助手", label: "颜色", explain: "颜色", icon: null, score: 100, match_type: "exact" },
  { code: "character-transform", plugin_id: "char-transform", plugin_name: "字符转换", label: "字符转换", explain: "编码、摘要与常用文本转换", icon: null, score: 99, match_type: "contains" },
  { code: "collect", plugin_id: "color-helper", plugin_name: "颜色助手", label: "收藏颜色", explain: "为常用色值命名并保存", icon: null, score: 98, match_type: "contains" },
  { code: "timestamp", plugin_id: "timestamp", plugin_name: "时间工具", label: "时间戳转换", explain: "秒、毫秒与日期互转", icon: null, score: 97, match_type: "pinyin" },
  { code: "md5", plugin_id: "char-transform", plugin_name: "字符转换", label: "MD5", explain: "计算文本摘要", icon: null, score: 96, match_type: "prefix" },
];
const listeners = new Map<number, { event: string; handler: number }>();
let sequence = 0;
export const calls: Array<{ command: string; args: unknown }> = [];
mockWindows("main"); mockConvertFileSrc("macos");
mockIPC((command, args) => {
  if (command === "plugin:event|listen") {
    const id = ++sequence; listeners.set(id, { event: args?.event as string, handler: args?.handler as number }); return id;
  }
  if (command === "plugin:event|unlisten") { listeners.delete(args?.eventId as number); return; }
  calls.push({ command, args });
  if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
  if (command === "feature_catalog") return rows;
  if (command === "search_features") {
    const query = String(args?.query || "").trim().toLowerCase();
    return query === "工具" ? rows : rows.filter(row => [row.label, row.explain, row.plugin_name, row.code].some(value => value.toLowerCase().includes(query)));
  }
  if (["list_pending_agent_requests", "search_local_apps"].includes(command)) return [];
  if (command === "activate_feature") {
    const row = rows.find(item => item.code === args?.code);
    if (!row) throw Error("Unknown fixture feature");
    return { plugin_id: row.plugin_id, plugin_name: row.plugin_name, feature_code: row.code, feature_label: row.label,
      feature_label_source: "declared", main_url: "index.html", plugin_path: "__atools_plugin_host_preview__", expand_height: 400,
      payload: { srcdoc: "<!doctype html><title>Offline presentation fixture</title><main>离线展示夹具</main>" } } satisfies FeatureAction;
  }
  if (["expand_window", "reset_window", "close_host_clipboard"].includes(command)) return;
  throw Error("Presentation fixture did not authorize IPC: " + command);
});

export function mountFixture() {
  localStorage.clear();
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  return mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
}
