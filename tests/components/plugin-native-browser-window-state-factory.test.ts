import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { TextEncoder } from "node:util";
import { createPluginBrowserWindowGeometryHost } from "../../src/lib/pluginBrowserWindowGeometryHost";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { UTOOLS_BRIDGE } from "../../src/lib/pluginUtoolsBridgeSource";
import { createPluginNativeBrowserWindowState } from "../../src/lib/pluginNativeBrowserWindowStateFactory";

const nativeRequire = createRequire(resolve("package.json"));

function nativeSnapshot() {
  return {
    bounds: { x: -42, y: 16, width: 620, height: 480 },
    contentBounds: { x: -42, y: 16, width: 620, height: 480 },
    minimumSize: [120, 90] as [number, number], maximumSize: [0, 0] as [number, number],
    visible: true, focused: false, alwaysOnTop: true, minimized: false, maximized: false,
    fullScreen: false, resizable: true, title: "native fixture", nativeSequence: 3, constraintsSource: "adapter" as const,
  };
}

async function bridgeFixture(hostKind?: "native" | "overlay") {
  const sourceEvents = new Map<string, Function[]>(), posted: any[] = [], errors: unknown[] = [];
  const parent = { postMessage: (message: any) => posted.push(message) };
  const window: any = { parent, top: {}, matchMedia: () => ({ matches: false }),
    addEventListener(name: string, listener: Function) { sourceEvents.set(name, [...(sourceEvents.get(name) || []), listener]); },
    removeEventListener(name: string, listener: Function) { sourceEvents.set(name, (sourceEvents.get(name) || []).filter(value => value !== listener)); },
    dispatchEvent(event: any) { for (const listener of sourceEvents.get(event.type) || []) listener(event); } };
  const { injectPluginBridgeFactories } = nativeRequire(resolve("scripts/lib/plugin-bridge-fixture.mjs"));
  const script = (await injectPluginBridgeFactories(UTOOLS_BRIDGE)).replace(/<\\\/script>/g, "</script>")
    .replace(/^\s*<script>\s*/, "").replace(/\s*<\/script>\s*$/, "")
    .replace(/__(?:PLUGIN_ID|FEATURE_CODE|APP_NAME|APP_VERSION|PLUGIN_PATH)__/g, '"fixture"')
    .replace(/__ACTION_PAYLOAD__/g, "null");
  class Event { constructor(public type: string, public detail?: unknown) {} }
  const context = vm.createContext({ window, document: { readyState: "complete", addEventListener() {} },
    navigator: { platform: "MacIntel", userAgent: "Fixture" }, Event, CustomEvent: Event,
    console: { error: (...args: unknown[]) => errors.push(args), warn() {}, log() {} }, Date, Math, Number, Promise, TextEncoder,
    setTimeout, clearTimeout, queueMicrotask });
  vm.runInContext(script, context);
  function host(data: any, from = parent) {
    for (const listener of [...(sourceEvents.get("message") || [])]) listener({ source: from, data });
  }
  function reply(call: any, payload: any) { host({ __atools_native_response__: true, reqId: call.reqId, ...payload }); }
  const sources = new PluginFrameSourceRegistry(); sources.setMain(window);
  const creator = { source: window, identity: sources.currentIdentityForHost(window)! };
  const geometry = createPluginBrowserWindowGeometryHost({ creatorFor: () => creator, sourceFor: () => null, sources,
    nonce: () => "host-fixed-instance", post: (_source, message) => { host(message); return true; } });
  const actual = { id: "hosted-one", clientCreateId: "", documentGeneration: 1, x: -42, y: 16, width: 620, height: 480,
    minimumWidth: 120, minimumHeight: 90, maximumWidth: 0, maximumHeight: 0 };
  const handle = window.utools.createBrowserWindow("child.html", { width: 1 });
  await Promise.resolve();
  const create = posted.find(message => message.method === "createBrowserWindow");
  actual.clientCreateId = create.args.clientCreateId;
  const seed = geometry.snapshot(actual)!;
  reply(create, { result: { id: actual.id, ...(hostKind ? { hostKind } : {}), clientCreateId: actual.clientCreateId,
    webContentsId: 555, url: "child.html", title: "Host", geometrySnapshot: seed,
    ...(hostKind === "native" ? { processId: 777, osProcessId: 888, webContentsMediaSourceId: "fake-media-id" } : {}) } });
  await new Promise(resolve => setTimeout(resolve, 0));
  host({ __atools_browser_window_ready__: true, windowId: actual.id, clientCreateId: actual.clientCreateId });
  if (!handle.isDestroyed()) await handle.ready;
  return { handle, errors, posted };
}

describe("native BrowserWindow state provenance", () => {
  it("uses the accepted background-throttling preference and defaults only the runtime state", () => {
    const createState = (preloadOptions: Record<string, unknown>) => createPluginNativeBrowserWindowState({
      id: "child", clientCreateId: "create", url: "fixture.html", srcdoc: "", documentGeneration: 1,
      preloadOptions, snapshot: nativeSnapshot(), windowSequence: 9, webContentsId: 42,
    });

    const throttledOff = createState({ webPreferences: { preload: "preload.js", backgroundThrottling: false } });
    expect(throttledOff.backgroundThrottling).toBe(false);
    expect(throttledOff.preloadOptions.webPreferences).toEqual({ preload: "preload.js", backgroundThrottling: false });
    expect(createState({}).backgroundThrottling).toBe(true);
  });

  it("maps accepted options as constructor-derived and keeps native/OS identifiers unknown", () => {
    const state = createPluginNativeBrowserWindowState({ id: "child", clientCreateId: "create", url: "fixture.html",
      srcdoc: "", documentGeneration: 1, preloadOptions: { closable: false, minimizable: false,
        maximizable: false, fullscreenable: false, hasShadow: false, skipTaskbar: true,
        visibleOnAllWorkspaces: true, focusable: false, backgroundColor: "#112233" },
      snapshot: nativeSnapshot(), windowSequence: 9, webContentsId: 42 });

    expect(state).toMatchObject({ visible: true, x: -42, y: 16, resizable: true, movable: true,
      closable: false, minimizable: false, maximizable: false, fullScreenable: false, hasShadow: false,
      skipTaskbar: true, visibleOnAllWorkspaces: true, focusable: false, backgroundColor: "#112233" });
    expect(state.nativeConstructorState).toEqual({ backgroundColor: "#112233", movable: true, closable: false,
      minimizable: false, maximizable: false, fullScreenable: false, hasShadow: false, skipTaskbar: true,
      visibleOnAllWorkspaces: true, focusable: false });
    expect(state).toMatchObject({ mediaSourceId: "", webContentsMediaSourceId: "", processId: 0, osProcessId: 0 });
  });

  it("rejects native identifier getters in the serialized bridge without changing legacy fallbacks", async () => {
    const native = await bridgeFixture("native");
    for (const getter of [native.handle.webContents.getMediaSourceId, native.handle.webContents.getProcessId,
      native.handle.webContents.getOSProcessId]) {
      expect(() => getter.call(native.handle.webContents)).toThrowError(expect.objectContaining({
        code: "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED",
      }));
    }
    await expect(native.handle.getMediaSourceId()).rejects.toMatchObject({ code: "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED" });

    const legacy = await bridgeFixture("overlay");
    expect(legacy.handle.webContents.getProcessId()).toBeGreaterThan(0);
    expect(legacy.handle.webContents.getOSProcessId()).toBeGreaterThan(0);
    expect(legacy.handle.webContents.getMediaSourceId()).toMatch(/^web-contents:/);
  });

  it("rejects native background-throttling setter before mutation or IPC while keeping legacy setter behavior", async () => {
    const native = await bridgeFixture("native");
    expect(native.handle.webContents.getBackgroundThrottling()).toBe(true);
    expect(() => native.handle.webContents.setBackgroundThrottling(false)).toThrowError(expect.objectContaining({
      code: "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED",
    }));
    expect(native.handle.webContents.getBackgroundThrottling()).toBe(true);
    expect(native.posted.filter(message => message.method === "browserWindowAction"
      && message.args?.action === "webContents.setBackgroundThrottling")).toEqual([]);

    const legacy = await bridgeFixture("overlay");
    legacy.handle.webContents.setBackgroundThrottling(false);
    expect(legacy.handle.webContents.getBackgroundThrottling()).toBe(false);
    expect(legacy.posted).toContainEqual(expect.objectContaining({ method: "browserWindowAction",
      args: expect.objectContaining({ action: "webContents.setBackgroundThrottling", args: [false] }) }));
  });
});
