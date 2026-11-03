import vm from "node:vm";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { productionHostedIpcFixture } from "./pluginHostedIpcProductionFixture";
import { createCompiledPluginFrameBrowserGlobals } from "./compiledPluginFrameBrowserGlobals";

const frameCleanups = new Set<() => void>();
afterEach(() => {
  for (const dispose of frameCleanups) dispose();
  frameCleanups.clear();
});

function productionEntry(entry_type: unknown, mode: "list" | "none" | "ordinary", payloadOverride?: unknown) {
  const payload = payloadOverride ?? " 固定原文\nhttps://fixture.invalid/a?b=%2F </script> $& $` $' __PLUGIN_PATH__ __APP_VERSION__ ";
  const documentSource = createPluginBridgeDocument({
    action: { plugin_id: "fixed", plugin_name: "Fixed", feature_code: "fixed", main_url: "index.html",
      plugin_path: "/fixture", expand_height: 0, payload, entry_type: entry_type as "regex" | "over" },
    windowType: "main", browserWindowId: "", geometrySnapshot: null, workerScope: "fixed-worker-scope",
    mainPushConfig: null, webContentsId: 7, subInputEpoch: 0, appName: "ATools", appVersion: "fixture", baseBridgeScript: "",
  });
  if (!documentSource.trim()) throw new Error("Production bridge compiler returned an empty source");
  const browser = createCompiledPluginFrameBrowserGlobals();
  frameCleanups.add(browser.dispose);
  const listeners = new Map<string, Function[]>(), domReady = new Map<Function, boolean>();
  const timers = new Map<number, { callback: Function; delay: number; dueAt: number; id: number }>(), posted: any[] = [];
  const scheduledDelays: number[] = [], executedDelays: number[] = [];
  let nextTimerId = 0, taskWaves = 0, fakeNow = 0;
  const document = {
    readyState: "loading",
    addEventListener(name: string, callback: Function, options?: { once?: boolean }) {
      if (name === "DOMContentLoaded") domReady.set(callback, options?.once === true);
    },
    removeEventListener(name: string, callback: Function) {
      if (name === "DOMContentLoaded") domReady.delete(callback);
    },
    dispatchDomReady() {
      for (const [callback, once] of [...domReady]) {
        if (once) domReady.delete(callback);
        callback();
      }
    },
  };
  const window: any = { parent: { postMessage: (message: unknown) => posted.push(message) }, top: {},
    location: browser.location, history: browser.history, Event: browser.Event, CustomEvent: browser.CustomEvent,
    console: { error: vi.fn() },
    addEventListener: (name: string, cb: Function) => listeners.set(name, [...listeners.get(name) ?? [], cb]),
    removeEventListener: (name: string, cb: Function) => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== cb)),
    dispatchEvent: (event: any) => { for (const cb of listeners.get(event.type) ?? []) cb(event); }, matchMedia: () => ({ matches: false }),
    __ATOOLS_FRAME_TRANSPORT__: { post: (message: unknown) => posted.push(message), accept: () => true },
  };
  const context = vm.createContext({ window, navigator: { platform: "MacIntel" }, document, TextEncoder,
    setTimeout: (cb: Function, delay = 0) => {
      expect([0, 50]).toContain(delay);
      const id = ++nextTimerId; scheduledDelays.push(delay);
      timers.set(id, { callback: cb, delay, dueAt: fakeNow + delay, id }); return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); }, console: window.console,
    Event: browser.Event, CustomEvent: browser.CustomEvent,
  });
  executeCompiledPluginBridgeScripts(documentSource, context, 3);
  const generic = vi.fn(), ready = vi.fn(), exported = vi.fn((_action: unknown, cb?: (items: unknown[]) => void) => cb?.([{ title: "fixed" }]));
  window.ztools.onPluginEnter(generic); window.utools.onPluginReady(ready);
  if (mode !== "ordinary") window.exports = { fixed: { mode, args: { enter: exported } } };
  document.dispatchDomReady();
  for (let wave = 0; wave < 8 && timers.size > 0; wave++) {
    const next = [...timers.values()].sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
    timers.delete(next.id);
    fakeNow = Math.max(fakeNow, next.dueAt);
    taskWaves++;
    executedDelays.push(next.delay);
    next.callback();
  }
  if (timers.size > 0) throw new Error("bounded production bridge timer drain exceeded eight next-task waves");
  return { payload, generic, ready, exported, window, posted, context, document, taskWaves, scheduledDelays, executedDelays };
}

describe("actual serialized PluginPanel renderer and entry normalization", () => {
  it("routes copied-file lookup through the production native normalizer", async () => {
    const fixture = await productionHostedIpcFixture();
    try {
      const main = await fixture.frame();
      const copied = await main.evaluate("window.utools.getCopiedFiles()");
      expect(copied).toEqual([
        { path: "/fixture/report.pdf", name: "report.pdf", isFile: true, isDiractory: false },
        { path: "/fixture/folder/", name: "folder", isFile: false, isDiractory: true },
      ]);
      expect(fixture.receivedNative.filter(item => item.method === "getCopyedFiles")).toHaveLength(1);
    } finally {
      fixture.closeRpc();
      fixture.closeDocuments();
    }
  });
  it.each(["regex", "over"])("passes backend %s type and exact raw text to ordinary/list/none", entryType => {
    for (const mode of ["ordinary", "list", "none"] as const) {
      const f = productionEntry(entryType, mode);
      const received = mode === "ordinary" ? f.generic.mock.calls : f.exported.mock.calls;
      expect(received).toHaveLength(1); expect(received[0][0]).toEqual({ code: "fixed", type: entryType, payload: f.payload, from: "main" });
      if (mode !== "ordinary") { expect(f.generic).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled(); }
      else {
        expect(f.ready).toHaveBeenCalledOnce(); expect(f.taskWaves).toBeGreaterThan(0);
        expect(f.scheduledDelays).toEqual(expect.arrayContaining([0, 50]));
        expect(f.scheduledDelays.indexOf(0)).toBeLessThan(f.scheduledDelays.indexOf(50));
        expect(f.executedDelays).toEqual(expect.arrayContaining([0, 50]));
        expect(f.executedDelays.indexOf(0)).toBeLessThan(f.executedDelays.indexOf(50));
      }
    }
  });
  it.each([undefined, "text", "__proto__"])("ordinary backend type %s defaults to text", entryType => {
    const f = productionEntry(entryType, "ordinary"); expect(f.generic.mock.calls[0][0]).toMatchObject({ type: "text", payload: f.payload });
  });
  it.each(["files", "img"])("passes exact %s media payload through actual ordinary/list/none serialized entry", entryType => {
    const payload = entryType === "files" ? [{path:"/tmp/$& $` __PLUGIN_PATH__ </script>.pdf",name:"原始.pdf",isFile:true,isDirectory:false}] : "data:image/png;base64,iVBORw==";
    for (const mode of ["ordinary", "list", "none"] as const) {
      const f = productionEntry(entryType, mode, payload);
      const received = mode === "ordinary" ? f.generic.mock.calls : f.exported.mock.calls;
      expect(received).toHaveLength(1);
      expect(received[0][0]).toEqual({code:"fixed",type:entryType,payload,from:"main"});
    }
  });
  it("respects explicit lifecycle detail type and option without changing its payload", () => {
    const f = productionEntry("over", "ordinary");
    const detail = { type: "regex", payload: "explicit raw", option: { custom: true }, inputState: { fixture: true } };
    f.window.dispatchEvent(new f.context.CustomEvent("atools-plugin-enter", { detail }));
    expect(f.generic.mock.calls[1][0]).toEqual({ code: "fixed", type: "regex", payload: "explicit raw", from: "main", option: { custom: true }, inputState: { fixture: true } });
  });
});
