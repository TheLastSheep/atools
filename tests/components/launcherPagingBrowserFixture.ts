import App from "../../src/App.svelte";
import { mount } from "svelte";
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { SearchResult } from "../../src/lib/types";

/** Generated catalog, real App/search/result components. No native IPC or plugin activation. */
const rows: SearchResult[] = Array.from({ length: 1200 }, (_, index) => ({
  code: `page-${index}`, plugin_id: `page-source-${index % 4}`, plugin_name: `本地工具 ${index % 4 + 1}`,
  label: `分页命令 ${index}`, explain: "离线分页夹具", score: 2000 - index, match_type: "exact", icon: null,
}));
export const calls: Array<{ command: string; args: unknown }> = [];
mockWindows("main"); mockConvertFileSrc("macos");
let eventId = 0;
mockIPC((command, args) => {
  if (command === "plugin:event|listen") return ++eventId;
  if (command === "plugin:event|unlisten") return;
  calls.push({ command, args });
  if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
  if (command === "feature_catalog" || command === "search_features") return rows;
  if (["list_pending_agent_requests", "search_local_apps", "search_plugin_main_push_candidates"].includes(command)) return [];
  if (command === "expand_window" || command === "reset_window") return;
  throw Error("Paging fixture did not authorize IPC: " + command);
});
export function start() {
  localStorage.clear();
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  return mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
}
