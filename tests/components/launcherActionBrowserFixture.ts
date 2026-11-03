import App from "../../src/App.svelte";
import { mount, unmount, tick, flushSync } from "svelte";
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { SearchResult } from "../../src/lib/types";

const feature: SearchResult = { code: "convert", plugin_id: "converter", plugin_name: "转换插件", label: "字符转换", explain: "本地文本转换", icon: null, score: 100, match_type: "exact" };
const listeners = new Map<number, { event: string; handler: number }>();
let sequence = 0;
let app: ReturnType<typeof mount> | undefined;
let holdCatalog = false;
const pending: Array<(value: SearchResult[]) => void> = [];
export const calls: Array<{ command: string; args: unknown }> = [];
function callback(id: number, data: unknown) {
  (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void } }).__TAURI_INTERNALS__.runCallback(id, data);
}
mockWindows("main"); mockConvertFileSrc("macos");
mockIPC((command, args) => {
  if (command === "plugin:event|listen") { const id = ++sequence; listeners.set(id, { event: args?.event as string, handler: args?.handler as number }); return id; }
  if (command === "plugin:event|unlisten") { listeners.delete(args?.eventId as number); return; }
  calls.push({ command, args });
  if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
  if (command === "feature_catalog") return holdCatalog ? new Promise<SearchResult[]>(resolve => pending.push(resolve)) : [feature];
  if (command === "search_features") return [feature];
  if (command === "list_pending_agent_requests" || command === "search_local_apps") return [];
  if (command === "expand_window") return;
  throw Error("Launcher mock IPC did not authorize: " + command);
});

export async function mountFresh(hold = false, seed = false) {
  if (app) await unmount(app);
  calls.length = 0; holdCatalog = hold;
  if (seed) {
    localStorage.clear();
    localStorage.setItem("atools:command-history", JSON.stringify([{ ...feature, icon: "", input: "字符转换", usedAt: new Date().toISOString(), useCount: 1 }]));
  }
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync(); await tick();
}

export async function releaseCatalog() {
  holdCatalog = false;
  for (const resolve of pending.splice(0)) resolve([feature]);
  await tick();
}

export function emit(event: string) {
  for (const [id, listener] of listeners) if (listener.event === event) callback(listener.handler, { event, id, payload: null });
}
