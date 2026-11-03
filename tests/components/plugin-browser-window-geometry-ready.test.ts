import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { createPluginPanelFrameMounts } from "../../src/lib/pluginPanelFrameMount";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import type { PluginPanelFrameMountPorts } from "../../src/lib/pluginPanelFrameMount";
import type { PluginBrowserWindowState } from "../../src/lib/pluginBrowserWindowTypes";
import { createPluginBrowserWindowGeometryHost } from "../../src/lib/pluginBrowserWindowGeometryHost";
import { PluginFrameSourceRegistry, type PluginFrameIdentity } from "../../src/lib/pluginFrameDocumentIdentity";
import { postPluginBrowserWindowReadiness } from "../../src/lib/pluginBrowserWindowReady";
import { registerPluginNativeBrowserWindowRendererReady } from "../../src/lib/pluginNativeBrowserWindowCallbacks";
import { createPluginNativeBrowserWindowState } from "../../src/lib/pluginNativeBrowserWindowStateFactory";
import { applyPluginNativeBrowserWindowSnapshot, readPluginNativeBrowserWindowSnapshot } from "../../src/lib/pluginNativeBrowserWindowSnapshot";
import type { PluginNativeBrowserWindowSnapshot } from "../../src/lib/pluginNativeBrowserWindowTypes";

function dispatchFrameLoad(node: HTMLIFrameElement) {
  const view = node.ownerDocument.defaultView;
  if (!view) throw new Error("Fixture iframe has no owning Window");
  node.dispatchEvent(new view.Event("load"));
}

function nativeSnapshot(overrides: Partial<PluginNativeBrowserWindowSnapshot> = {}): PluginNativeBrowserWindowSnapshot {
  const value = readPluginNativeBrowserWindowSnapshot({
    bounds: { x: -25, y: 9, width: 400, height: 300 },
    contentBounds: { x: -17, y: 45, width: 384, height: 254 },
    minimumSize: [100, 80], maximumSize: [1000, 800],
    visible: true, focused: false, alwaysOnTop: false, minimized: false, maximized: false,
    fullScreen: false, resizable: true, title: "Child", nativeSequence: 1, constraintsSource: "adapter",
    ...overrides,
  });
  if ("closed" in value) throw new Error("Expected an open native snapshot");
  return value;
}

function createWindowState(): PluginBrowserWindowState {
  const state = createPluginNativeBrowserWindowState({
    id: "child", clientCreateId: "creation", url: "child.html", title: "Child", srcdoc: "",
    documentGeneration: 1, preloadOptions: {}, snapshot: nativeSnapshot(), windowSequence: 1, webContentsId: 1,
  });
  // Native geometry comes from the accepted snapshot even if legacy scalar mirrors are stale.
  Object.assign(state, { x: 900, y: 901, width: 902, height: 903,
    minimumWidth: 904, minimumHeight: 905, maximumWidth: 906, maximumHeight: 907 });
  return state;
}

function applyNativeSnapshot(state: PluginBrowserWindowState, snapshot: PluginNativeBrowserWindowSnapshot) {
  const updated = applyPluginNativeBrowserWindowSnapshot(state, snapshot);
  if (!updated) throw new Error("Expected a newer valid native snapshot");
  Object.assign(state, updated);
}

async function scene() {
  const sources = new PluginFrameSourceRegistry(), frames = new Map<string, any>(), events: any[] = [];
  const windows: PluginBrowserWindowState[] = [], creators = new Map<string, { source: unknown; identity: PluginFrameIdentity }>();
  const hosted = createPluginHostedIpcRouter({ sources, creatorFor: id => creators.get(id) });
  hosted.reserve({ kind: "main" });
  const owner = { postMessage: (message: any) => events.push({ recipient: "owner", message }) };
  sources.setMain(owner);
  const creator = { source: owner, identity: sources.currentIdentityForHost(owner)! };
  const state = createWindowState();
  windows.push(state); creators.set(state.id, creator);
  let rejectSelf = false, nonce = 0, rpcGeneration = 0;
  const post = (source: unknown, message: any, identity: any) => {
    if (rejectSelf && identity.kind === "child" && message.__atools_browser_window_geometry__) return false;
    return sources.reply(source, identity, message);
  };
  const geometry = createPluginBrowserWindowGeometryHost({ sources, creatorFor: id => creators.get(id),
    sourceFor: id => frames.get(id)?.contentWindow, post, nonce: () => "host-nonce-" + ++nonce });
  const rpc = { attach: () => ++rpcGeneration, waitReady: async () => {}, readyDocumentNonce: () => "ready-document",
    isAttached: () => true, isCurrentGeneration: (_id: string, generation: number) => generation === rpcGeneration, close() {} };
  const invalidateFrame: PluginPanelFrameMountPorts["invalidateFrame"] = (_role, _close, _source) => {};
  const bind: PluginPanelFrameMountPorts["bind"] = (_role, _source, _identity) => {};
  const ipc = {
    registerFrame(role: any, source: unknown) {
      const current = sources.currentIdentityForHost(source);
      if (!current) return role.kind === "child" ? sources.registerChild(role.windowId, source) : sources.setMain(source);
      return current;
    },
    bind, invalidate: invalidateFrame, readinessFailureIsCurrent: () => true,
    confirmReady: async (_role: any, source: unknown) => {
      const captured = sources.currentIdentityForHost(source)!;
      return { source, identity: captured, documentNonce: "ready-document",
        assertCurrent() { if (!sources.isCurrent(source, captured)) throw Error("Stale ready lease"); } };
    },
  };
  const mounts = createPluginPanelFrameMounts({
    activePage: () => undefined, hasMainReservation: () => hosted.hasReservation({ kind: "main" }),
    registerFrame: (role, source) => ipc.registerFrame(role, source),
    invalidateFrame: (role, close, source) => ipc.invalidate(role, close, source),
    unregisterMain: source => sources.unregisterMain(source), registerChild: (id, source) => sources.registerChild(id, source),
    unregisterChild: (id, source) => sources.unregisterChild(id, source),
    currentIdentity: source => sources.currentIdentityForHost(source), bind: (role, source, identity) => ipc.bind(role, source, identity),
    confirmReady: ipc.confirmReady, readinessFailureIsCurrent: ipc.readinessFailureIsCurrent,
    sources, rpc, frames, windows: () => windows, geometry, creators, postReadiness: postPluginBrowserWindowReadiness,
    post: (source, message) => { const identity = sources.currentIdentityForHost(source); return identity ? post(source, message, identity) : false; },
    focusMainFrame: () => true, reportReady: () => {},
  });
  const firstSeed = geometry.snapshot(state)!;

  async function childDocument(seed: unknown) {
    const node = document.createElement("iframe");
    document.body.append(node);
    const source = node.contentWindow;
    if (!source) { node.remove(); throw Error("JSDOM iframe did not create a content window"); }
    const listeners = new Map<string, Function[]>();
    const parent = { postMessage() {} };
    const frameBrowser = source as Window & typeof globalThis;
    const window: any = { parent, top: {}, location: frameBrowser.location, history: frameBrowser.history,
      Event: frameBrowser.Event, CustomEvent: frameBrowser.CustomEvent, matchMedia: () => ({ matches: false }),
      __ATOOLS_FRAME_TRANSPORT__: { post: (message: unknown) => { source.postMessage(message, "*"); return true; }, accept: () => true },
      addEventListener(name: string, listener: Function) { listeners.set(name, [...(listeners.get(name) || []), listener]); },
      removeEventListener(name: string, listener: Function) { listeners.set(name, (listeners.get(name) || []).filter(value => value !== listener)); },
      dispatchEvent(event: any) { for (const listener of listeners.get(event.type) || []) listener(event); } };
    const postMessage: Window["postMessage"] = (message: unknown) => {
      events.push({ recipient: window, message });
      for (const listener of [...(listeners.get("message") || [])]) listener({ source: parent, data: structuredClone(message) });
    };
    Object.defineProperty(source, "postMessage", { configurable: true, value: postMessage });
    let raw = createPluginBridgeDocument({
      action: { plugin_id: "fixture", plugin_name: "Fixture", feature_code: "fixture", main_url: "index.html",
        plugin_path: "/fixture", expand_height: 0, payload: null },
      windowType: "browserWindow", browserWindowId: state.id, geometrySnapshot: seed, workerScope: "fixture-scope",
      mainPushConfig: null, webContentsId: 1, subInputEpoch: 0, appName: "ATools", appVersion: "fixture", baseBridgeScript: "",
    });
    const marker = "    var destroyed = false;";
    if (!raw.includes(marker)) throw Error("Compiled production BrowserWindow bridge marker missing");
    raw = raw.replace(marker, "    window.__observedGeometryMirror = geometry;\n" + marker);
    if (!raw.trim()) throw Error("Production bridge compiler emitted empty source");
    const context = vm.createContext({ window, document: { readyState: "complete", addEventListener() {} },
      navigator: { platform: "MacIntel", userAgent: "Fixture" }, Event: frameBrowser.Event, CustomEvent: frameBrowser.CustomEvent,
      console: { error() {}, warn() {}, log() {} }, Date, Math, Number, Promise, TextEncoder, setTimeout, clearTimeout, queueMicrotask });
    executeCompiledPluginBridgeScripts(raw, context, 3);
    const action = mounts.pluginBrowserWindowFrame(node, state.id);
    return { window, source, action, load: () => dispatchFrameLoad(node),
      destroy: () => { action.destroy(); node.remove(); },
      bounds: () => JSON.parse(JSON.stringify(window.__observedGeometryMirror.read("getBounds"))),
      size: () => JSON.parse(JSON.stringify(window.__observedGeometryMirror.read("getSize"))),
      contentSize: () => JSON.parse(JSON.stringify(window.__observedGeometryMirror.read("getContentSize"))) };
  }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  return { state, firstSeed, geometry, childDocument, events, windows, frames, sources, settle,
    rejectSelf: () => { rejectSelf = true; } };
}

describe("production child ready geometry resynchronization", () => {
  it("refreshes a child that missed creator-confirmed state between srcdoc seeding and listener readiness", async () => {
    const f = await scene();
    applyNativeSnapshot(f.state, nativeSnapshot({
      bounds: { x: 80, y: 9, width: 650, height: 300 },
      contentBounds: { x: 88, y: 45, width: 634, height: 254 }, nativeSequence: 2,
    }));
    f.geometry.publish(f.state); // No self recipient is registered yet; creator alone confirms delivery.
    const child = await f.childDocument(f.firstSeed);
    expect(child.bounds()).toEqual(f.firstSeed.bounds);
    expect(child.size()).toEqual([400, 300]);
    expect(child.contentSize()).toEqual([384, 254]);
    child.load(); await f.settle();
    expect(child.bounds()).toEqual({ x: 80, y: 9, width: 650, height: 300 });
    expect(child.size()).toEqual([650, 300]);
    expect(child.contentSize()).toEqual([634, 254]);
    const selfIndex = f.events.findIndex(item => item.recipient === child.window && item.message.__atools_browser_window_geometry__);
    const readyIndex = f.events.findIndex(item => item.recipient === "owner" && item.message.__atools_browser_window_ready__);
    expect(selfIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(selfIndex);
    child.destroy();
  });

  it("resynchronizes a reloaded document and never posts current state to its stale predecessor", async () => {
    const f = await scene(), old = await f.childDocument(f.firstSeed);
    old.load(); await f.settle(); old.action.destroy();
    f.state.documentGeneration = 2;
    const reloadSeed = f.geometry.snapshot(f.state)!;
    applyNativeSnapshot(f.state, nativeSnapshot({
      bounds: { x: -25, y: 70, width: 400, height: 440 },
      contentBounds: { x: -17, y: 106, width: 384, height: 394 }, nativeSequence: 2,
    }));
    f.geometry.publish(f.state);
    const current = await f.childDocument(reloadSeed), before = f.events.length;
    expect(current.bounds()).toEqual(reloadSeed.bounds);
    current.load(); await f.settle();
    expect(current.bounds()).toEqual({ x: -25, y: 70, width: 400, height: 440 });
    expect(current.size()).toEqual([400, 440]);
    expect(current.contentSize()).toEqual([384, 394]);
    expect(f.events.slice(before).some(item => item.recipient === old.window)).toBe(false);
    old.load(); await f.settle();
    expect(old.bounds()).toEqual(f.firstSeed.bounds);
    current.action.destroy();
  });

  it("does not report creator ready when the exact self snapshot cannot be delivered", async () => {
    const f = await scene(), child = await f.childDocument(f.firstSeed);
    f.rejectSelf(); child.load(); await f.settle();
    expect(f.events.some(item => item.message.__atools_browser_window_ready__)).toBe(false);
    expect(f.events.some(item => item.message.__atools_browser_window_failed__)).toBe(true);
    child.destroy();
  });

  it.each(["frame", "identity"] as const)("rechecks the ready lease and mounted frame after native finalization (%s changed)", async changed => {
    const f = await scene(), child = await f.childDocument(f.firstSeed);
    let finishFinalization!: () => void, enteredFinalization!: () => void;
    const finalization = new Promise<void>(resolve => { finishFinalization = resolve; });
    const entered = new Promise<void>(resolve => { enteredFinalization = resolve; });
    const unregister = registerPluginNativeBrowserWindowRendererReady(child.source, "child", async () => {
      enteredFinalization(); await finalization;
    });

    child.load(); await entered;
    if (changed === "frame") f.frames.delete("child");
    else f.sources.registerChild("child", child.source);
    finishFinalization(); await f.settle();

    expect(f.events.some(item => item.message.__atools_browser_window_ready__)).toBe(false);
    unregister(); child.destroy();
  });
});
