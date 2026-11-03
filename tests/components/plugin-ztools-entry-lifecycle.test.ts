import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { preparePluginPreload } from "../../src/lib/pluginPreload";
import { hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";

type EntryMode = "activate" | "preload";
type ExportMode = "ordinary" | "list" | "none";

const fixtures = new Set<() => void>();
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function makeFixture(options: {
  entryMode?: EntryMode | string;
  actionEntryMode?: EntryMode;
  windowType?: "main" | "browserWindow";
  browserWindowId?: string;
  exportMode?: ExportMode;
  mainPush?: boolean;
  payload?: unknown;
} = {}) {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const browser = iframe.contentWindow as (Window & typeof globalThis) | null;
  if (!browser) throw new Error("JSDOM iframe did not create a browser window");

  const posted: Record<string, unknown>[] = [];
  const windowListeners = new Map<string, Array<{ callback: (event: Event) => void; once: boolean }>>();
  const documentReady = new Set<() => void>();
  const timers = new Map<number, { callback: () => void; dueAt: number; id: number }>();
  let timerId = 0, now = 0;
  const console = { error: vi.fn() };
  const window: any = {
    parent: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
    top: {}, location: browser.location, history: browser.history, DOMParser: browser.DOMParser,
    Event: browser.Event, CustomEvent: browser.CustomEvent, MessageEvent: browser.MessageEvent, HTMLElement: browser.HTMLElement,
    console, matchMedia: () => ({ matches: false }),
    addEventListener(name: string, callback: (event: Event) => void, listenerOptions?: { once?: boolean }) {
      const listeners = windowListeners.get(name) ?? [];
      listeners.push({ callback, once: listenerOptions?.once === true });
      windowListeners.set(name, listeners);
    },
    removeEventListener(name: string, callback: (event: Event) => void) {
      windowListeners.set(name, (windowListeners.get(name) ?? []).filter(item => item.callback !== callback));
    },
    dispatchEvent(event: Event) {
      for (const item of [...windowListeners.get(event.type) ?? []]) {
        if (!(windowListeners.get(event.type) ?? []).includes(item)) continue;
        if (item.once) window.removeEventListener(event.type, item.callback);
        item.callback(event);
      }
      return true;
    },
    __ATOOLS_FRAME_TRANSPORT__: {
      post: (message: Record<string, unknown>) => { posted.push(message); return true; },
      accept: () => true,
    },
  };
  if (options.exportMode) {
    window.exports = { fixed: { mode: options.exportMode, args: { enter: vi.fn(), search: vi.fn(), select: vi.fn() } } };
  }
  const mainPushConfig = options.mainPush ? {
    runnerId: "entry-runner", nonce: "entry-nonce", epoch: 7, featureCode: "fixed",
    parentOrigin: "https://host.fixture", queryOnly: true,
  } : null;
  const action: any = {
    plugin_id: "entry-fixture", plugin_name: "Entry fixture", feature_code: "fixed", main_url: "index.html",
    plugin_path: "/fixture", expand_height: 0, payload: options.payload ?? "original payload",
  };
  if (options.actionEntryMode) action.entryMode = options.actionEntryMode;
  const compilerOptions: any = {
    action, windowType: options.windowType ?? "main", browserWindowId: options.browserWindowId ?? "", geometrySnapshot: null,
    workerScope: "entry-fixture", mainPushConfig, webContentsId: 1, subInputEpoch: 0,
    appName: "ATools", appVersion: "fixture", baseBridgeScript: "",
  };
  if (options.entryMode) compilerOptions.entryMode = options.entryMode;
  const html = createPluginBridgeDocument(compilerOptions);

  const fakeDocument = {
    readyState: "loading",
    addEventListener(name: string, callback: () => void) { if (name === "DOMContentLoaded") documentReady.add(callback); },
    removeEventListener(name: string, callback: () => void) { if (name === "DOMContentLoaded") documentReady.delete(callback); },
  };
  const context = vm.createContext({
    window, document: fakeDocument, navigator: { platform: "MacIntel" }, TextEncoder,
    Event: browser.Event, CustomEvent: browser.CustomEvent, Date, Math, Number, Promise,
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++timerId; timers.set(id, { callback, dueAt: now + delay, id }); return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); }, console,
    parent: window.parent,
    addEventListener: (name: string, callback: (event: Event) => void, listenerOptions?: { once?: boolean }) =>
      window.addEventListener(name, callback, listenerOptions),
    removeEventListener: (name: string, callback: (event: Event) => void) => window.removeEventListener(name, callback),
  });
  executeCompiledPluginBridgeScripts(html, context, 3);
  const start = async () => {
    for (const callback of [...documentReady]) { documentReady.delete(callback); callback(); }
    for (let step = 0; timers.size > 0 && step < 12; step++) {
      const task = [...timers.values()].sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      timers.delete(task.id); now = Math.max(now, task.dueAt); task.callback();
    }
    if (timers.size) throw new Error("entry lifecycle timer drain exceeded the bounded fixture budget");
    await flush();
  };
  const fire = (name: string, detail?: unknown) => {
    const event = detail === undefined ? new browser.Event(name) : new browser.CustomEvent(name, { detail });
    window.dispatchEvent(event);
  };
  const sendMessage = (data: Record<string, unknown>) => {
    const event = new browser.MessageEvent("message", { data, origin: "https://host.fixture" });
    Object.defineProperty(event, "source", { configurable: true, value: window.parent });
    window.dispatchEvent(event);
  };
  const cleanup = () => iframe.remove();
  fixtures.add(cleanup);
  return { window, posted, start, fire, sendMessage, cleanup, mainPushConfig, context };
}

function preparedPreloadBody(script: string): string {
  return script.replace(/^<script[^>]*>\s*/, "").replace(/\s*<\/script>\s*$/, "");
}

async function executePreparedFixturePreload(f: ReturnType<typeof makeFixture>) {
  const modules = new Map([
    ["/fixture/preload/preload.js", "module.exports = require('./entry-service.js');"],
    ["/fixture/preload/entry-service.js", `module.exports = { registerEntry: function() {
      window.ztools.onPluginReady(function(action) { window.__preparedPreloadEnter = action; });
    } };`],
  ]);
  const prepared = await preparePluginPreload({
    pluginDir: "/fixture/preload",
    preloadPath: "/fixture/preload/preload.js",
    readTextFile: async path => {
      const source = modules.get(path);
      if (source !== undefined) return source;
      throw Object.assign(new Error("missing fixture module"), { code: "ENOENT" });
    },
  });
  vm.runInContext(preparedPreloadBody(prepared), f.context);
  return prepared;
}

afterEach(() => { for (const cleanup of fixtures) cleanup(); fixtures.clear(); });

describe("compiled ZTools entry lifecycle modes", () => {
  it("keeps separate ztools/utools facades, shares API objects, and routes ZTools ready through the enter slot", async () => {
    const f = makeFixture();
    expect(f.window.ztools).not.toBe(f.window.utools);
    const publicKeys = Object.keys(f.window.utools);
    expect(publicKeys.length).toBeGreaterThan(10);
    expect(f.window.utools.db).toEqual(expect.any(Object));
    expect(f.window.utools.dbStorage).toEqual(expect.any(Object));
    for (const key of publicKeys.filter(key => key !== "onPluginReady")) {
      expect(Object.prototype.hasOwnProperty.call(f.window.ztools, key)).toBe(true);
      expect(f.window.ztools[key]).toBe(f.window.utools[key]);
    }
    const ztools = f.window.ztools, utools = f.window.utools;
    expect(ztools.onPluginReady).toBe(ztools.onPluginEnter);
    expect(ztools.onPluginReady).not.toBe(utools.onPluginReady);

    const first = vi.fn(), latest = vi.fn(), utoolsReady = vi.fn();
    ztools.onPluginReady(first);
    ztools.onPluginReady(latest);
    utools.onPluginReady(utoolsReady);
    const one = { code: "custom", type: "regex", payload: "  exact 😀  ", from: "main", option: { id: 9 }, inputState: { tab: "x" } };
    f.fire("atools-plugin-enter", one);
    await flush();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(one);
    expect(utoolsReady).not.toHaveBeenCalled();
    f.fire("atools-plugin-enter", { ...one, payload: "second exact" });
    await flush();
    expect(latest).toHaveBeenCalledTimes(2);
    expect(latest.mock.calls[1][0]).toEqual({ ...one, payload: "second exact" });
    f.fire("atools-plugin-ready");
    f.fire("atools-plugin-ready");
    expect(utoolsReady).toHaveBeenCalledOnce();
  });

  it("buffers an enter that arrives before ZTools registration and consumes it once", async () => {
    const f = makeFixture();
    const payload = { code: "late", type: "text", payload: "buffered", from: "main" };
    f.fire("atools-plugin-enter", payload);
    const ready = vi.fn();
    f.window.ztools.onPluginReady(ready);
    expect(ready).not.toHaveBeenCalled();
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(payload);
    f.window.ztools.onPluginReady(vi.fn());
    await flush();
    expect(ready).toHaveBeenCalledOnce();
  });

  it("preserves separate callback semantics through the production preload preparer", async () => {
    const f = makeFixture();
    const utoolsReady = vi.fn();
    f.window.utools.onPluginReady(utoolsReady);
    const preload = await executePreparedFixturePreload(f);
    expect(preload).toContain("data-atools-plugin-preload");
    expect(f.window.ztools).not.toBe(f.window.utools);
    expect(f.window.ztools.onPluginReady).toBe(f.window.ztools.onPluginEnter);
    expect(f.window.utools.onPluginReady).not.toBe(f.window.ztools.onPluginReady);
    expect(f.window.services.registerEntry).toEqual(expect.any(Function));
    f.window.services.registerEntry();
    const entered = { code: "preload-service", type: "regex", payload: "original preload", from: "main", option: { id: 4 } };
    f.fire("atools-plugin-enter", entered);
    await flush();
    expect(f.window.__preparedPreloadEnter).toEqual(entered);
    expect(utoolsReady).not.toHaveBeenCalled();
    f.fire("atools-plugin-ready");
    f.fire("atools-plugin-ready");
    expect(utoolsReady).toHaveBeenCalledOnce();
  });

  it.each(["ordinary", "list", "none"] as const)("preload startup does not auto invoke existing %s exports", async exportMode => {
    const f = makeFixture({ entryMode: "preload", exportMode });
    const entered = vi.fn(), ready = vi.fn();
    f.window.addEventListener("atools-plugin-enter", entered);
    f.window.addEventListener("atools-plugin-ready", ready);
    const exportsBeforeStart = f.window.exports;
    await f.start();
    expect(f.window.exports).toBe(exportsBeforeStart);
    expect(entered).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(f.window.exports.fixed.args.enter).not.toHaveBeenCalled();
    expect(f.posted.some(message => message.__atools_feature_exports__ === true)).toBe(false);
  });

  it("only trusts the compiler entryMode: action and payload flags cannot promote preload or suppress activation", async () => {
    const defaultActivate = makeFixture({ actionEntryMode: "preload", payload: { entryMode: "preload" }, exportMode: "ordinary" });
    defaultActivate.window.entryMode = "preload";
    defaultActivate.window.__ATOOLS_ENTRY_MODE__ = "preload";
    defaultActivate.window._atoolsEntryMode = "preload";
    const activated = vi.fn();
    defaultActivate.window.ztools.onPluginEnter(activated);
    await defaultActivate.start();
    expect(activated).toHaveBeenCalledOnce();

    const trustedPreload = makeFixture({ entryMode: "preload", actionEntryMode: "activate", payload: { entryMode: "activate" }, exportMode: "ordinary" });
    trustedPreload.window.entryMode = "activate";
    trustedPreload.window.__ATOOLS_ENTRY_MODE__ = "activate";
    trustedPreload.window._atoolsEntryMode = "activate";
    const shouldStayPreloaded = vi.fn();
    trustedPreload.window.ztools.onPluginEnter(shouldStayPreloaded);
    await trustedPreload.start();
    expect(shouldStayPreloaded).not.toHaveBeenCalled();
    expect(trustedPreload.posted.some(message => message.__atools_feature_exports__ === true)).toBe(false);
  });

  it("falls back to activate for an invalid compiler entryMode", async () => {
    const f = makeFixture({ entryMode: "not-a-mode", exportMode: "ordinary" });
    const activated = vi.fn();
    f.window.ztools.onPluginEnter(activated);
    await f.start();
    expect(activated).toHaveBeenCalledOnce();
  });

  it("keeps default activate behavior for feature exports, mainPush boot, and child entry", async () => {
    const list = makeFixture({ exportMode: "list" });
    const exportEnter = list.window.exports.fixed.args.enter;
    await list.start();
    expect(exportEnter).toHaveBeenCalledOnce();

    const mainPush = makeFixture({ mainPush: true });
    await mainPush.start();
    expect(mainPush.posted).toContainEqual(expect.objectContaining({ __atools_main_push__: true, booted: true }));

    const child = makeFixture({ windowType: "browserWindow", browserWindowId: "child-entry" });
    const childEnter = vi.fn(), childReady = vi.fn();
    child.window.addEventListener("atools-plugin-enter", childEnter);
    child.window.addEventListener("atools-plugin-ready", childReady);
    await child.start();
    expect(childEnter).toHaveBeenCalledOnce();
    expect((childEnter.mock.calls[0][0] as CustomEvent).detail).toEqual({
      code: "fixed", type: "text", payload: "original payload", from: "main",
    });
    expect(childReady).toHaveBeenCalledOnce();
  });

  it("preload ignores a manually dispatched mainPush promote event", async () => {
    const f = makeFixture({ entryMode: "preload", exportMode: "list", mainPush: true });
    const exportEnter = f.window.exports.fixed.args.enter;
    await f.start();
    f.fire("atools-main-push-promote", { code: "fixed", type: "text", payload: "promote", from: "main" });
    expect(exportEnter).not.toHaveBeenCalled();
    expect(f.posted.some(message => message.__atools_feature_exports__ === true)).toBe(false);
  });

  it("preload does not start MainPush or route legacy/private query and select commands", async () => {
    const f = makeFixture({ entryMode: "preload", exportMode: "list", mainPush: true });
    const query = vi.fn(() => [{ text: "should not run" }]), select = vi.fn();
    f.window.utools.onMainPush(query, select);
    await f.start();
    f.sendMessage({ __ipc_main_push__: true, reqId: "legacy-q", action: { payload: "legacy" } });
    f.sendMessage({ __ipc_main_push_select__: true, action: { payload: "legacy-select" } });
    f.sendMessage({ __atools_main_push_command__: true, command: "query", runnerId: "entry-runner", nonce: "entry-nonce",
      epoch: 7, requestId: "private-q", generation: 1, type: "text", payload: "private" });
    f.sendMessage({ __atools_main_push_command__: true, command: "promote", runnerId: "entry-runner", nonce: "entry-nonce",
      epoch: 7, requestId: "private-promote", queryId: "private-q" });
    await flush();
    expect(query).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(f.posted.some(message => message.__atools_main_push__ === true || message.__atools_feature_exports__ === true)).toBe(false);
  });

  it("forwards copied-file API replacement and assignment across the facade after real preload normalization", async () => {
    const f = makeFixture();
    await executePreparedFixturePreload(f);
    const ztools = f.window.ztools, utools = f.window.utools;
    expect(ztools).not.toBe(utools);
    for (const key of Object.keys(utools).filter(key => key !== "onPluginReady")) {
      expect(Object.prototype.hasOwnProperty.call(ztools, key)).toBe(true);
      expect(ztools[key]).toBe(utools[key]);
    }
    expect(Object.getOwnPropertyDescriptor(ztools, "getCopiedFiles")).toMatchObject({
      enumerable: true, configurable: true, get: expect.any(Function), set: expect.any(Function),
    });

    const initial = utools.getCopiedFiles;
    const assignedFromZTools = vi.fn();
    ztools.getCopiedFiles = assignedFromZTools;
    expect(utools.getCopiedFiles).toBe(assignedFromZTools);
    const assignedFromUTools = vi.fn();
    utools.getCopiedFiles = assignedFromUTools;
    expect(ztools.getCopiedFiles).toBe(assignedFromUTools);
    utools.getCopiedFiles = initial;

    const endpoint = "http://127.0.0.1:43123/host/" + "c".repeat(64);
    const xhrCalls: Array<{ method: string; endpoint: string; async: boolean; payload: unknown }> = [];
    class FixtureXhr {
      status = 200;
      responseText = "";
      method = "";
      endpoint = "";
      async = true;
      open(method: string, endpoint: string, async = true) { this.method = method; this.endpoint = endpoint; this.async = async; }
      setRequestHeader() {}
      send(body: string) {
        const payload = JSON.parse(body);
        xhrCalls.push({ method: this.method, endpoint: this.endpoint, async: this.async, payload });
        this.responseText = JSON.stringify({ ok: true, result: [{
          name: "report.pdf", path: "/fixture/report.pdf", isFile: true, isDirectory: false,
        }] });
      }
    }
    Object.assign(f.context, { XMLHttpRequest: FixtureXhr });
    const script = hostClipboardBridgeScript({ instanceId: "entry-lifecycle-clipboard", endpoints: { read: endpoint } });
    vm.runInContext(preparedPreloadBody(script), f.context);

    expect(ztools.getCopiedFiles).toBe(utools.getCopiedFiles);
    expect(ztools.getCopyedFiles).toBe(utools.getCopyedFiles);
    expect(ztools.getCopiedFiles).toBe(ztools.getCopyedFiles);
    expect(ztools.getCopiedFiles()).toEqual([{
      name: "report.pdf", path: "/fixture/report.pdf", isFile: true, isDirectory: false, isDiractory: false,
    }]);
    expect(utools.getCopyedFiles()).toEqual([{
      name: "report.pdf", path: "/fixture/report.pdf", isFile: true, isDirectory: false, isDiractory: false,
    }]);
    expect(xhrCalls).toEqual([
      { method: "POST", endpoint, async: false, payload: { format: "files" } },
      { method: "POST", endpoint, async: false, payload: { format: "files" } },
    ]);
  });

  it("preserves enumerable Symbol extensions through generated preload normalization", async () => {
    const f = makeFixture(), visible = Symbol("visible-extension"), hidden = Symbol("hidden-extension");
    const extension = { source: "preload fixture extension" };
    f.window.ztools[visible] = extension;
    Object.defineProperty(f.window.ztools, hidden, { value: extension, enumerable: false });
    Object.defineProperty(f.window.ztools, "hiddenExtension", { value: extension, enumerable: false });
    const ready = f.window.utools.onPluginReady;
    await executePreparedFixturePreload(f);
    expect(f.window.utools[visible]).toBe(extension);
    expect(Object.prototype.hasOwnProperty.call(f.window.utools, hidden)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(f.window.utools, "hiddenExtension")).toBe(false);
    expect(f.window.utools.onPluginReady).toBe(ready);
    expect(f.window.ztools.onPluginReady).toBe(f.window.ztools.onPluginEnter);
    expect(f.window.ztools).not.toBe(f.window.utools);
  });

  it.each(["pagehide", "atools-plugin-out"])("disposes the ZTools enter slot on %s", async eventName => {
    const f = makeFixture();
    const callback = vi.fn();
    f.window.ztools.onPluginReady(callback);
    f.fire(eventName);
    f.fire("atools-plugin-enter", { code: "late", type: "text", payload: null, from: "main" });
    f.fire("atools-plugin-ready");
    await flush();
    expect(callback).not.toHaveBeenCalled();
  });
});
