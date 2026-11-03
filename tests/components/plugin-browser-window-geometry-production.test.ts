import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { TextEncoder } from "node:util";
const nativeRequire = createRequire(resolve("package.json"));
import { createPluginBrowserWindowGeometryHost } from "../../src/lib/pluginBrowserWindowGeometryHost";
import { UTOOLS_BRIDGE } from "../../src/lib/pluginUtoolsBridgeSource";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";

async function fixture(beforeReply?: (host: (data: any) => void, seed: any) => void) {
  const source = await readFile("src/components/PluginPanel.svelte", "utf8");
  const template = UTOOLS_BRIDGE;
  const listeners = new Map<string, Function[]>(), posted: any[] = [], errors: unknown[] = [];
  const parent = { postMessage: (message: any) => posted.push(message) };
  const window: any = { parent, top: {}, matchMedia: () => ({ matches: false }),
    addEventListener(name: string, listener: Function) { listeners.set(name, [...(listeners.get(name) || []), listener]); },
    removeEventListener(name: string, listener: Function) { listeners.set(name, (listeners.get(name) || []).filter(value => value !== listener)); },
    dispatchEvent(event: any) { for (const listener of listeners.get(event.type) || []) listener(event); } };
  const { injectPluginBridgeFactories } = nativeRequire(resolve("scripts/lib/plugin-bridge-fixture.mjs"));
  const script = (await injectPluginBridgeFactories(template)).replace(/<\\\/script>/g, "</script>")
    .replace(/^\s*<script>\s*/, "").replace(/\s*<\/script>\s*$/, "")
    .replace(/__(?:PLUGIN_ID|FEATURE_CODE|APP_NAME|APP_VERSION|PLUGIN_PATH)__/g, '"fixture"')
    .replace(/__ACTION_PAYLOAD__/g, "null");
  class Event { constructor(public type: string, public detail?: unknown) {} }
  const context = vm.createContext({ window, document: { readyState: "complete", addEventListener() {} },
    navigator: { platform: "MacIntel", userAgent: "Fixture" }, Event, CustomEvent: Event,
    console: { error: (...args: unknown[]) => errors.push(args), warn() {}, log() {} }, Date, Math, Number, Promise, TextEncoder, setTimeout, clearTimeout, queueMicrotask });
  vm.runInContext(script, context);
  function host(data: any, from = parent) { for (const listener of [...(listeners.get("message") || [])]) listener({ source: from, data }); }
  function reply(call: any, payload: any) { host({ __atools_native_response__: true, reqId: call.reqId, ...payload }); }
  const sources = new PluginFrameSourceRegistry(); sources.setMain(window);
  const creator = { source: window, identity: sources.currentIdentityForHost(window)! };
  const geometry = createPluginBrowserWindowGeometryHost({ creatorFor: () => creator, sourceFor: () => null, sources,
    nonce: () => "host-fixed-instance", post: (_source, message) => { host(message); return true; } });
  const actual = { id: "hosted-one", clientCreateId: "", documentGeneration: 1, x: -25, y: 9, width: 400, height: 300,
    minimumWidth: 100, minimumHeight: 80, maximumWidth: 1000, maximumHeight: 800 };
  const handle = window.utools.createBrowserWindow("child.html", { width: 1 });
  await Promise.resolve();
  const create = posted.find(message => message.method === "createBrowserWindow");
  actual.clientCreateId = create.args.clientCreateId;
  const seed = geometry.snapshot(actual)!;
  beforeReply?.(host, seed);
  reply(create, { result: { id: actual.id, clientCreateId: actual.clientCreateId, url: "child.html", title: "Host", geometrySnapshot: seed } });
  await new Promise(resolve => setTimeout(resolve, 0));
  host({ __atools_browser_window_ready__: true, windowId: actual.id, clientCreateId: actual.clientCreateId });
  if (!handle.isDestroyed()) await handle.ready;
  return { handle, posted, host, reply, geometry, actual, errors, seed, window, script, context };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("serialized production BrowserWindow geometry wiring", () => {
  it("uses actual create state and defensive synchronous copies with zero getter IPC", async () => {
    const f = await fixture(), before = f.posted.length;
    for (let index = 0; index < 1000; index++) {
      const bounds = f.handle.getBounds();
      expect(bounds.then).toBeUndefined(); expect(bounds.width).toBe(400); bounds.x = 10;
      expect(plain(f.handle.getPosition())).toEqual([-25, 9]);
      expect(plain(f.handle.getSize())).toEqual([400, 300]);
      expect(plain(f.handle.getContentSize())).toEqual([400, 300]);
      expect(plain(f.handle.getMinimumSize())).toEqual([100, 80]);
      expect(plain(f.handle.getMaximumSize())).toEqual([1000, 800]);
    }
    expect(f.posted.length).toBe(before);
  });

  it("bypasses a pending setter and preserves confirmed geometry on observable permission rejection", async () => {
    const f = await fixture();
    const pending = f.handle.setBounds({ x: 70, y: 80, width: 500, height: 400 });
    await Promise.resolve();
    const call = f.posted.find(message => message.args?.action === "setBounds");
    expect(plain(f.handle.getBounds())).toEqual(f.seed.bounds);
    expect(f.handle.getBounds().then).toBeUndefined();
    const rejected = expect(pending).rejects.toThrow("permission denied");
    f.reply(call, { error: "permission denied" }); await rejected;
    expect(plain(f.handle.getBounds())).toEqual(f.seed.bounds);
  });

  it("applies confirmed mutation state before resize listeners and rejects stale/foreign updates", async () => {
    const f = await fixture(), seen: unknown[] = [];
    f.handle.on("resize", () => seen.push(plain(f.handle.getBounds())));
    const updated = f.geometry.snapshot({ ...f.actual, x: 88, width: 700 })!;
    f.host({ __atools_browser_window_event__: true, windowId: f.actual.id, event: "resize", args: [], geometrySnapshot: updated });
    expect(seen).toEqual([updated.bounds]);
    for (const bad of [f.seed, { ...updated, revision: 99, instanceNonce: "other" }, { ...updated, revision: 99, ownerKey: "other" }])
      f.host({ __atools_browser_window_geometry__: true, windowId: f.actual.id, clientCreateId: f.actual.clientCreateId, geometrySnapshot: bad });
    f.host({ __atools_browser_window_geometry__: true, windowId: f.actual.id, geometrySnapshot: { ...updated, revision: 99 } }, {});
    expect(plain(f.handle.getBounds())).toEqual(updated.bounds);
  });

  it("observes latest confirmed state during queued setters, without promising same-turn acknowledgement", async () => {
    const f = await fixture();
    const first = f.handle.setPosition(20, 30), second = f.handle.setSize(600, 500);
    await Promise.resolve();
    expect(plain(f.handle.getPosition())).toEqual([-25, 9]);
    const one = f.posted.find(message => message.args?.action === "setPosition");
    f.geometry.publish({ ...f.actual, x: 20, y: 30 });
    expect(plain(f.handle.getPosition())).toEqual([20, 30]);
    f.reply(one, { result: [20, 30] }); await first;
    await Promise.resolve();
    const two = f.posted.find(message => message.args?.action === "setSize");
    f.geometry.publish({ ...f.actual, x: 20, y: 30, width: 600, height: 500 });
    f.reply(two, { result: [600, 500] }); await second;
    expect(plain(f.handle.getSize())).toEqual([600, 500]);
  });



  it("seeds the child mirror from actual host state before preload code runs", async () => {
    const f = await fixture();
    // Observe the actual production mirror, without substituting any getter or geometry implementation.
    const child = f.script.replace("var _atoolsWindowType = 'main';", "var _atoolsWindowType = 'browserWindow';")
      .replace("var _atoolsBrowserWindowId = '';", "var _atoolsBrowserWindowId = " + JSON.stringify(f.actual.id) + ";")
      .replace("var _atoolsBrowserWindowGeometry = null;", "var _atoolsBrowserWindowGeometry = " + JSON.stringify(f.seed) + ";")
      .replace("    var destroyed = false;", "    window.__observedGeometryMirror = geometry;\n    var destroyed = false;");
    const childListeners = new Map<string, Function[]>(), childPosted: any[] = [];
    const childWindow: any = { parent: { postMessage: (message: any) => childPosted.push(message) }, top: {},
      matchMedia: () => ({ matches: false }),
      addEventListener(name: string, listener: Function) { childListeners.set(name, [...(childListeners.get(name) || []), listener]); },
      removeEventListener(name: string, listener: Function) { childListeners.set(name, (childListeners.get(name) || []).filter(value => value !== listener)); },
      dispatchEvent(event: any) { for (const listener of childListeners.get(event.type) || []) listener(event); } };
    const childContext = vm.createContext({ window: childWindow, document: { readyState: "complete", addEventListener() {} },
      navigator: { platform: "MacIntel", userAgent: "Fixture" }, Event, CustomEvent: Event,
      console: { error: (...args: unknown[]) => f.errors.push(args), warn() {}, log() {} }, Date, Math, Number, Promise, TextEncoder, setTimeout, clearTimeout, queueMicrotask });
    vm.runInContext(child + "\nwindow.__preloadBounds = window.__observedGeometryMirror.read('getBounds');", childContext);
    expect(plain(childWindow.__preloadBounds)).toEqual(f.seed.bounds);
    const afterSeed = childPosted.length;
    expect(plain(childWindow.__observedGeometryMirror.read("getPosition"))).toEqual([-25, 9]);
    expect(childPosted.length).toBe(afterSeed);
  });

  it("retains an authoritative geometry update arriving before create acknowledgement", async () => {
    const f = await fixture((host, seed) => host({ __atools_browser_window_geometry__: true, windowId: seed.windowId,
      clientCreateId: seed.clientCreateId, geometrySnapshot: { ...seed, revision: seed.revision + 1, bounds: { ...seed.bounds, x: 72 } } }));
    expect(plain(f.handle.getPosition())).toEqual([72, 9]);
  });

  it("retains a resize event arriving before create acknowledgement", async () => {
    const f = await fixture((host, seed) => host({ __atools_browser_window_event__: true, windowId: seed.windowId,
      clientCreateId: seed.clientCreateId, event: "resize", args: [],
      geometrySnapshot: { ...seed, revision: seed.revision + 1, bounds: { ...seed.bounds, width: 550 } } }));
    expect(plain(f.handle.getSize())).toEqual([550, 300]);
  });

  it("remembers an authoritative close arriving before create acknowledgement", async () => {
    const f = await fixture((host, seed) => host({ __atools_browser_window_event__: true, windowId: seed.windowId,
      clientCreateId: seed.clientCreateId, event: "closed", args: [], geometrySnapshot: seed }));
    expect(f.handle.isDestroyed()).toBe(true);
    expect(() => f.handle.getBounds()).toThrow("ERR_ATOOLS_BROWSER_WINDOW_CLOSED");
    expect(f.posted.filter(message => message.args?.action === "close")).toHaveLength(0);
  });

  it("keeps geometry after a rejected close and rejects reads during an unconfirmed close", async () => {
    const f = await fixture(), closing = f.handle.close();
    expect(() => f.handle.getBounds()).toThrow("ERR_ATOOLS_BROWSER_WINDOW_CLOSED");
    await Promise.resolve(); await Promise.resolve();
    const call = f.posted.find(message => message.args?.action === "close");
    const rejected = expect(closing).rejects.toThrow("ERR_ATOOLS_BROWSER_WINDOW_CLOSE_UNCONFIRMED");
    f.reply(call, { result: { closed: false } }); await rejected;
    expect(plain(f.handle.getBounds())).toEqual(f.seed.bounds);
  });

  it("updates across reload and closes synchronously before closed listeners", async () => {
    const f = await fixture(), outcomes: string[] = [];
    const next = f.geometry.snapshot({ ...f.actual, documentGeneration: 2, x: 90 })!;
    f.host({ __atools_browser_window_geometry__: true, windowId: f.actual.id, geometrySnapshot: next });
    f.host({ __atools_browser_window_geometry__: true, windowId: f.actual.id, geometrySnapshot: { ...f.seed, revision: 99 } });
    expect(plain(f.handle.getPosition())).toEqual([90, 9]);
    f.host({ __atools_browser_window_event__: true, windowId: f.actual.id, event: "closed", args: [], geometrySnapshot: f.seed });
    expect(f.handle.isDestroyed()).toBe(false);
    expect(plain(f.handle.getPosition())).toEqual([90, 9]);
    f.handle.on("closed", () => { try { f.handle.getBounds(); } catch (error) { outcomes.push(String(error)); } });
    f.host({ __atools_browser_window_event__: true, windowId: f.actual.id, event: "closed", args: [], geometrySnapshot: next });
    expect(outcomes[0]).toContain("ERR_ATOOLS_BROWSER_WINDOW_CLOSED");
    expect(() => f.handle.getBounds()).toThrow("ERR_ATOOLS_BROWSER_WINDOW_CLOSED");
  });
});
