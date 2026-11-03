import vm from "node:vm";
import { JSDOM } from "jsdom";
import { MessageChannel, MessagePort } from "node:worker_threads";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { postPluginBrowserWindowReadiness } from "../../src/lib/pluginBrowserWindowReady";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { createPluginNativeBridgeRouter } from "../../src/lib/pluginPanelNativeBridgeRouter";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";
import { normalizeCopiedFileEntries } from "../../src/lib/pluginPanelSystemClipboard";
import { createPluginPanelFrameMounts } from "../../src/lib/pluginPanelFrameMount";
import { createPluginBrowserWindowGeometryHost } from "../../src/lib/pluginBrowserWindowGeometryHost";
import { HostedBrowserWindowRpcHost } from "../../src/lib/hostedBrowserWindowRpc";
import { createPluginFrameBootstrap } from "../../src/lib/pluginFrameBootstrap";
import { pluginFrameTransportScript } from "../../src/lib/pluginFrameTransport";
import type { HostClipboardConfig } from "../../src/lib/hostClipboardBridge";

export async function productionHostedIpcFixture(options: {
  documentTimeoutMs?: number;
  clipboardTransport?: (endpoint: string, payload: Record<string, unknown>) => unknown;
} = {}) {
  const fixtureDom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "about:blank" });
  const fixtureDocument = fixtureDom.window.document;
  const sources = new PluginFrameSourceRegistry(), creators = new Map<string, any>(), windows: any[] = [];
  const router = createPluginHostedIpcRouter({ sources, creatorFor: id => creators.get(id), timeoutMs: options.documentTimeoutMs ?? 100 });
  const rpc = new HostedBrowserWindowRpcHost({ timeoutMs: 100, createChannel: () => new MessageChannel() as any });
  const childFrames = new Map<string, any>();
  const fixtureFrameNodes = new Set<HTMLIFrameElement>();
  const frameNodeBySource = new WeakMap<Window, HTMLIFrameElement>();
  let geometryNonce = 0;
  const geometry = createPluginBrowserWindowGeometryHost({ sources, creatorFor: id => creators.get(id),
    sourceFor: id => childFrames.get(id)?.contentWindow, nonce: () => "fixture-geometry-" + ++geometryNonce,
    post: (source, message, identity) => sources.reply(source, identity, message) });
  const documentBootstraps: Array<ReturnType<typeof createPluginFrameBootstrap>> = [], documentPorts: any[] = [], claims: number[] = [];
  const receivedNative: any[] = [], errors: unknown[] = [], deliveries: any[] = [], frames: any[] = [], nativeSinks: any[] = [];
  let permission: (value: string) => Promise<void> = async () => {};
  let createGate: () => Promise<void> = async () => {};
  let realChildCreates: { holdLifecycle: boolean } | undefined;
  let native: (event: any, call: any, identity: any) => Promise<void>;
  let browserWindowAction: (args: Record<string, unknown>) => unknown = (args: Record<string, unknown>) => {
    nativeSinks.push({ method: "browserWindowAction", args }); return null;
  };
  let parentIngress: ((event: MessageEvent) => unknown) | undefined;
  const browserWindowFrames = new Map<string, HTMLIFrameElement>();
  let lastCopiedPath = "";
  let fixtureCryptoSequence = 0;

  function dispatchFrameLoad(node: HTMLIFrameElement) {
    const view = node.ownerDocument.defaultView;
    if (!view) throw new Error("Fixture iframe has no owning Window");
    node.dispatchEvent(new view.Event("load"));
  }

  function createFixtureWindowSource(): Window {
    const node = fixtureDocument.createElement("iframe");
    fixtureDocument.body.append(node);
    const source = node.contentWindow;
    if (!source) { node.remove(); throw Error("JSDOM iframe did not create a content window"); }
    fixtureFrameNodes.add(node);
    frameNodeBySource.set(source, node);
    return source;
  }
  function replaceFixturePostMessage(source: Window, post: Window["postMessage"]) {
    Object.defineProperty(source, "postMessage", { configurable: true, value: post });
  }
  const nativeOperation = async (method: string, _args: any, creatorSource?: unknown) => {
    nativeSinks.push({ method, args: _args });
    if (method === "shellOpenExternal" || method === "copyFile") return null;
    if (method !== "createBrowserWindow") throw Error("Unexpected native method " + method);
    const creator = frames.find(item => item.source === creatorSource) ?? frames[0];
    await createGate();
    if (!sources.isCurrent(creator.source, creator.identity)) throw Error("Creator document changed");
    const child = await frame("child-" + (windows.length + 1), creator, !realChildCreates, undefined, realChildCreates?.holdLifecycle ?? false, !!realChildCreates);
    windows.find(item => item.id === child.windowId).clientCreateId = _args.clientCreateId;
    if (realChildCreates) child.childWiring!.load();
    else queueMicrotask(() => child.creator.host({ __atools_browser_window_ready__: true, windowId: child.windowId, clientCreateId: _args.clientCreateId }));
    return { id: child.windowId, webContentsId: child.id, clientCreateId: _args.clientCreateId, url: _args.url, title: "Child" };
  };
  const nativeRouter = createPluginNativeBridgeRouter({
    invoke: async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => { nativeSinks.push({ method: command, args }); return null as T; },
    sources, hostedIpc: router, getBrowserWindows: () => windows, creatorFor: id => creators.get(id),
    ensurePermission: (value) => permission(value || ""), onclose: () => {},
    writePluginImage: async () => {}, pathFromBridgeValue: value => { lastCopiedPath = String(value ?? ""); return lastCopiedPath; },
    pathsFromBridgeValue: value => Array.isArray(value) ? value.map(String) : [],
    runAppleScript: async (_script, label) => {
      if (label === "copyFile") await nativeOperation("copyFile", { file: lastCopiedPath });
      if (label === "getCopyedFiles") {
        nativeSinks.push({ method: "getCopyedFiles", args: {} });
        return "/fixture/report.pdf\n/fixture/folder/";
      }
      return "";
    },
    appleScriptString: value => JSON.stringify(value),
    normalizeCopiedFileEntries,
    runCommand: async () => "", writeText: async () => {}, hidePanelForPaste: async () => {},
    pluginFileClipboardAppleScript: () => "", pickScreenColorWithEyeDropper: async () => ({ hex: "", rgb: "" }),
    dispatchPluginBrowserWindowParentMessage: args => { nativeSinks.push({ method: "sendToParent", args }); return null; },
    handlePluginBrowserWindowAction: args => browserWindowAction(args),
    createPluginBrowserWindow: (args, creator) => nativeOperation("createBrowserWindow", args, creator.source),
    shellOpen: async path => { await nativeOperation("shellOpenExternal", { path }); },
  });
  native = nativeRouter.handleNativeBridgeCall;
  const frameMounts = createPluginPanelFrameMounts({
    activePage: () => undefined,
    hasMainReservation: () => router.hasReservation({ kind: "main" }),
    registerFrame: (role, source, ready, loaded) => router.registerFrame(role, source, ready, loaded),
    invalidateFrame: (role, close, source) => router.invalidate(role, close, source),
    unregisterMain: source => sources.unregisterMain(source),
    registerChild: (id, source) => sources.registerChild(id, source),
    unregisterChild: (id, source) => sources.unregisterChild(id, source),
    currentIdentity: source => sources.currentIdentityForHost(source), bind: (role, source, identity) => router.bind(role, source, identity),
    confirmReady: (role, source, nonce) => router.confirmReady(role, source, nonce),
    readinessFailureIsCurrent: (role, source, nonce) => router.readinessFailureIsCurrent(role, source, nonce),
    sources, rpc, frames: childFrames, windows: () => windows, geometry, creators, postReadiness: postPluginBrowserWindowReadiness,
    post: (source, message) => { const identity = sources.currentIdentityForHost(source); return identity ? sources.reply(source, identity, message) : false; },
    focusMainFrame: () => true, reportReady: () => {},
  });

  async function frame(windowId?: string, creator?: any, ready = true, reuse?: any, holdLifecycle = false,
    mountBeforeStart = false, documentMode = false, clipboard?: HostClipboardConfig) {
    if (documentMode && windowId) throw Error("Document-mode child windows remain unsupported");
    const parentOrigin = "tauri://localhost", pageOrigin = "atools-page://0123456789abcdef0123456789abcdef.localhost";
    const pageDocumentId = "01234567-89ab-4def-8123-456789abcdef";
    let bootstrap: ReturnType<typeof createPluginFrameBootstrap> | undefined;
    const role = windowId ? { kind: "child" as const, windowId } : { kind: "main" as const };
    const id = router.reserve(role), listeners = new Map<string, Function[]>(), posted: any[] = [], lifecycle: any[] = [], outbound: any[] = [];
    let identity: any;
    const parent = { postMessage(message: any, targetOrigin?: string) {
      const copied = structuredClone(message); posted.push(copied); receivedNative.push(copied);
      outbound.push({ message: copied, targetOrigin });
      const event = { source, origin: pageOrigin, data: copied };
      if (bootstrap?.handleMessage(event)) return;
      const authenticated = documentMode ? sources.identifyEvent(event) : sources.identify(source);
      if (copied.__atools_hosted_ipc_document__ && authenticated) {
        if (holdLifecycle) lifecycle.push(copied); else router.handleLifecycle({ source, identity: authenticated }, copied);
      }
      if (copied.__atools_native_call__) {
        if (authenticated) void native({ source }, copied, authenticated);
      }
      if (copied.__atools_clipboard_change__ === true) parentIngress?.(event as MessageEvent);
    } };
    const source: Window = reuse ? reuse.source : createFixtureWindowSource();
    replaceFixturePostMessage(source, (message: unknown, _origin?: string | WindowPostMessageOptions, ports: Transferable[] = []) => {
      deliveries.push({ target: id, message }); host(structuredClone(message), parent, ports);
    });
    function host(data: any, from: unknown = parent, ports: unknown[] = [], origin = documentMode ? parentOrigin : undefined) {
      for (const listener of [...(listeners.get("message") || [])]) listener({ source: from, data, ports, origin });
    }
    const frameBrowser = source as Window & typeof globalThis;
    const fixtureCrypto = {
      getRandomValues(values: Uint8Array) { values.fill((++fixtureCryptoSequence) & 255); return values; },
      randomUUID() { return `00000000-0000-4000-8000-${String(++fixtureCryptoSequence).padStart(12, "0")}`; },
    };
    const fixtureTransportPost = (message: unknown) => { parent.postMessage(message); return true; };
    class FixtureXmlHttpRequest {
      status = 200;
      responseText = "";
      private endpoint = "";
      open(_method: string, endpoint: string) { this.endpoint = endpoint; }
      setRequestHeader(_name: string, _value: string) {}
      send(body: string) {
        const payload = JSON.parse(body) as Record<string, unknown>;
        const result = options.clipboardTransport?.(this.endpoint, payload) ?? null;
        this.responseText = JSON.stringify({ ok: true, result });
      }
    }
    const window: any = {
      parent, top: {}, location: frameBrowser.location, history: frameBrowser.history,
      crypto: fixtureCrypto,
      Event: frameBrowser.Event, CustomEvent: frameBrowser.CustomEvent, DOMParser: frameBrowser.DOMParser,
      console: { error: (...values: unknown[]) => errors.push(values) },
      XMLHttpRequest: FixtureXmlHttpRequest,
      addEventListener(name: string, listener: Function) { listeners.set(name, [...(listeners.get(name) || []), listener]); },
      removeEventListener(name: string, listener: Function) { listeners.set(name, (listeners.get(name) || []).filter(value => value !== listener)); },
      dispatchEvent(event: any) { for (const listener of listeners.get(event.type) || []) listener(event); },
      matchMedia: () => ({ matches: false }),
      screen: { width: 1440, height: 900 }, devicePixelRatio: 1,
      ...(documentMode ? {} : { __ATOOLS_FRAME_TRANSPORT__: {
        post: fixtureTransportPost,
        postLegacy: (message: unknown, _origin?: string, _transfer?: Transferable[]) => fixtureTransportPost(message),
        accept: () => true,
      } }),
    };
    const context = vm.createContext({ window, parent: window.parent, addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window), document: { readyState: "complete", addEventListener() {} },
      navigator: { platform: "MacIntel", userAgent: "fixture" }, TextEncoder, Event: frameBrowser.Event,
      CustomEvent: frameBrowser.CustomEvent, XMLHttpRequest: FixtureXmlHttpRequest, crypto: fixtureCrypto,
      setTimeout, clearTimeout, queueMicrotask, console: window.console });
    const raw = createPluginBridgeDocument({
      action: { plugin_id: "ipc-fixture", plugin_name: "IPC fixture", feature_code: "ipc", main_url: "index.html",
        plugin_path: "/fixture", expand_height: 0, plugin_permissions: ["browserWindow", "clipboard.read", "clipboard.write"], payload: null },
      windowType: windowId ? "browserWindow" : "main", browserWindowId: windowId || "", geometrySnapshot: null,
      workerScope: "fixture-worker-scope", mainPushConfig: null, webContentsId: id, subInputEpoch: 0,
      appName: "ATools", appVersion: "3.0.0", baseBridgeScript: "", clipboard,
    });
    if (!raw.trim()) throw Error("Production bridge compiler returned an empty source");
    if (documentMode) {
      const reservation = sources.reserveDocument({ kind: "main", source, pageDocumentId, expectedOrigin: pageOrigin, parentOrigin });
      const runtimePost = source.postMessage;
      let deliver!: (value: any) => void;
      const delivered = new Promise<any>(resolve => { deliver = resolve; });
      replaceFixturePostMessage(source, (offer: unknown, origin?: string | WindowPostMessageOptions, ports: Transferable[] = []) => {
        if (!offer || typeof offer !== "object" || Array.isArray(offer) || origin !== pageOrigin
          || !("kind" in offer) || offer.kind !== "atools-bootstrap-offer") throw Error("Invalid real bootstrap offer");
        const peer = ports[0];
        if (!(peer instanceof MessagePort)) throw Error("Real bootstrap offer omitted its message port");
        documentPorts.push(peer);
        peer.onmessage = event => deliver(event.data); peer.start();
        peer.postMessage({ ...offer, kind: "atools-bootstrap-ack" });
      });
      bootstrap = createPluginFrameBootstrap({ sources, reservation, source, claim: async () => { claims.push(id); }, getHtml: () => raw,
        createChannel: () => new MessageChannel() as any });
      documentBootstraps.push(bootstrap);
      bootstrap.handleMessage({ source, origin: pageOrigin, data: { kind: "atools-bootstrap-hello", runId: pageDocumentId, id: pageDocumentId, docNonce: "b".repeat(32) } });
      bootstrap.handleLoad();
      const payload = await delivered;
      if (payload.kind !== "atools-bootstrap-payload-html" || payload.html !== raw) throw Error("Invalid real bootstrap payload");
      window.__ATOOLS_BOOTSTRAP_HANDOFF__ = { runId: payload.runId, id: payload.id, docNonce: payload.docNonce, generation: payload.generation };
      replaceFixturePostMessage(source, runtimePost);
    } else if (!reuse) { if (windowId) sources.registerChild(windowId, source); else sources.setMain(source); }
    identity = sources.currentIdentityForHost(source)!;
    router.bind(role, source, identity, ready);
    if (creator && windowId) { creators.set(windowId, { source: creator.source, identity: creator.identity }); windows.push({ id: windowId, clientCreateId: "fixture-create-" + windowId, documentGeneration: 1,
      x: 0, y: 0, width: 400, height: 300, minimumWidth: 100, minimumHeight: 80, maximumWidth: 1000, maximumHeight: 800 }); }
    const childWiring = mountBeforeStart ? mountChild({ source, windowId }) : undefined;
    if (documentMode) vm.runInContext(pluginFrameTransportScript({ pageDocumentId, parentOrigin }).slice("<script>".length, -"</script>".length), context);
    executeCompiledPluginBridgeScripts(raw, context, clipboard ? 4 : 3);
    const rawElectron = window.require("electron");
    identity = sources.currentIdentityForHost(source)!;
    if (ready) router.markReady(role, source, identity);
    if (windowId) {
      const node = frameNodeBySource.get(source);
      if (!node) throw Error("Hosted child frame has no fixture-owned iframe node");
      browserWindowFrames.set(windowId, node);
    }
    const item = { id, role, windowId, window, source, identity, creator, rawElectron, context, host, posted, outbound, childWiring, parentOrigin, pageOrigin,
      evaluate: (code: string) => vm.runInContext(code, context),
      flushLifecycle() { for (const data of lifecycle.splice(0)) router.handleLifecycle({ source, identity: sources.currentIdentityForHost(source)! }, data); item.identity = sources.currentIdentityForHost(source)!; } };
    frames.push(item);
    return item;
  }
  function mountNode(source: Window) {
    const node = frameNodeBySource.get(source);
    if (!node) throw Error("Fixture iframe is not owned by this hosted IPC fixture");
    return node;
  }
  function mainFrameNode(source: Window) {
    return mountNode(source);
  }
  function mountMain(item: any) {
    const node = mountNode(item.source);
    const action = frameMounts.pluginMainFrame(node);
    return { load: () => dispatchFrameLoad(node), destroy: () => { action.destroy(); node.remove(); fixtureFrameNodes.delete(node); } };
  }
  function mountChild(item: any) {
    const node = mountNode(item.source);
    const action = frameMounts.pluginBrowserWindowFrame(node, item.windowId);
    return { load: () => dispatchFrameLoad(node), destroy: () => { action.destroy(); node.remove(); fixtureFrameNodes.delete(node); } };
  }
  return { frame, frames, sources, creators, windows, router, rpc, geometry, deliveries, errors, receivedNative, nativeSinks, browserWindowFrames,
    native: (event: any, call: any, identity: any) => native(event, call, identity),
    setBrowserWindowAction: (handler: (args: Record<string, unknown>) => unknown) => { browserWindowAction = handler; }, mainFrameNode, mountMain,
    closeRpc: () => { rpc.closeAll(); for (const node of fixtureFrameNodes) node.remove(); fixtureFrameNodes.clear(); fixtureDom.window.close(); }, claims,
    closeDocuments: () => { documentBootstraps.forEach(value => value.close()); documentPorts.forEach(port => port.close()); },
    setCreateGate: (next: typeof createGate) => { createGate = next; },
    setRealChildCreates: (next: typeof realChildCreates) => { realChildCreates = next; },
    setPermission: (next: typeof permission) => { permission = next; },
    setParentMessageHandler: (handler: (event: MessageEvent) => unknown) => { parentIngress = handler; },
    settle: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); },
  };
}
