import vm from "node:vm";
import type { FeatureAction } from "../../src/lib/types";
import { createPluginPanelDocumentSourceHost } from "../../src/lib/pluginPanelDocumentSourceHost";
import { createCompiledPluginFrameBrowserGlobals } from "./compiledPluginFrameBrowserGlobals";
import { executeCompiledPluginBridgeScripts } from "./compiledPluginBridgeScriptRunner";

export const NATIVE_FRAME_ID = "native-child-42";
export const NATIVE_GEOMETRY = {
  windowId: NATIVE_FRAME_ID,
  clientCreateId: "create-native-42",
  ownerKey: JSON.stringify(["child", "parent-window", 1, "a".repeat(32), "document"]),
  instanceNonce: "b".repeat(32),
  documentGeneration: 1,
  documentNonce: "c".repeat(32),
  revision: 1,
  bounds: { x: 1, y: 2, width: 320, height: 240 },
  minimumSize: [0, 0],
  maximumSize: [0, 0],
};
export const NATIVE_FRAME_HTML = "<!doctype html><html><head><title>Plugin child</title></head><body><main>child</main></body></html>";

const SELF_BOOTSTRAP = /if \(_atoolsBrowserWindowId && _atoolsBrowserWindowGeometry\) _createBrowserWindowHandle\(\{[\s\S]*?\n\s*hostKind: _atoolsWindowHostKind\s*\}\);/;

export function makeNativeFrameAction(payload: unknown = null, permissions?: string[]): FeatureAction {
  return {
    plugin_id: "snipaste",
    plugin_name: "Snipaste",
    feature_code: "paste",
    main_url: "index.html",
    plugin_path: "/plugins/snipaste",
    expand_height: 0,
    payload,
    ...(permissions ? { plugin_permissions: permissions } : {}),
  };
}

export function makeNativeFrameDocumentSourceHost(action = makeNativeFrameAction()) {
  let iframeSrcDoc = "";
  const ports = {
    action: () => action,
    workerDocument: { freshScope: () => "test-worker-scope", clearScope: () => undefined },
    hostedIpc: { reserve: () => 7 },
    mainPushHost: undefined,
    generation: () => 1,
    pluginPathForPreview: "/preview",
    productName: "ATools",
    productVersion: "test",
    clipboard: () => undefined,
    data: () => undefined,
    paths: () => undefined,
    dialogs: () => undefined,
    display: () => undefined,
    bridgeScript: () => "",
    smokeEnabled: () => false,
    smokeSampleIndex: () => 0,
    subInputState: () => ({ visible: false, value: "", placeholder: "", sequence: 0,
      generation: 0, epoch: 1, focusRequest: null }),
    setSubInputState: () => undefined,
    iframeSrc: () => undefined,
    iframeSrcDoc: (value: string) => { iframeSrcDoc = value; },
    setPluginItems: () => undefined,
    setSelectedIndex: () => undefined,
    setLoadError: () => undefined,
  };
  const host = createPluginPanelDocumentSourceHost(ports as unknown as Parameters<typeof createPluginPanelDocumentSourceHost>[0]);
  return { host, ports, getIframeSrcDoc: () => iframeSrcDoc };
}

export function compileNativeFrameDocument(html: string) {
  const browser = createCompiledPluginFrameBrowserGlobals();
  const messages: Record<string, unknown>[] = [];
  const listeners = new Map<string, Set<(event: { type: string; source: unknown; data: unknown }) => void>>();
  const parent = { postMessage: (message: Record<string, unknown>) => { messages.push(message); } };
  const document = {
    readyState: "complete",
    addEventListener() {},
    removeEventListener() {},
  };
  const nativeWindowCalls = { close: 0, resizeTo: [] as Array<[unknown, unknown]> };
  const frameTransport = {
    post(message: Record<string, unknown>, _transfer?: Transferable[]) { messages.push(message); return true; },
    postLegacy(message: Record<string, unknown>, _targetOrigin?: string, transfer?: Transferable[]) {
      return frameTransport.post(message, transfer);
    },
    accept: () => true,
    ready: () => true,
    dispose: () => undefined,
  };
  const originalWindowMethods = {
    close: () => { nativeWindowCalls.close++; },
    resizeTo: (width: unknown, height: unknown) => { nativeWindowCalls.resizeTo.push([width, height]); },
  };
  const window: Record<string, any> = {
    parent,
    top: {},
    document,
    location: browser.location,
    history: browser.history,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    URL,
    URLSearchParams,
    matchMedia: () => ({ matches: false }),
    close: originalWindowMethods.close,
    resizeTo: originalWindowMethods.resizeTo,
    addEventListener(name: string, listener: (event: any) => void) {
      const group = listeners.get(name) ?? new Set();
      group.add(listener);
      listeners.set(name, group);
    },
    removeEventListener(name: string, listener: (event: any) => void) { listeners.get(name)?.delete(listener); },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) listener({ type: event.type, source: parent, data: undefined });
      return true;
    },
    __ATOOLS_FRAME_TRANSPORT__: frameTransport,
  };
  const dispatchMessage = (data: Record<string, unknown>) => {
    for (const listener of listeners.get("message") ?? []) listener({ type: "message", source: parent, data });
  };
  const context = vm.createContext({ window, document, navigator: { platform: "MacIntel", userAgent: "VM" },
    TextEncoder, Event: browser.Event, CustomEvent: browser.CustomEvent, Date, Math, Number, Promise,
    URL, URLSearchParams, setTimeout, clearTimeout, queueMicrotask,
    console: { error() {}, warn() {}, log() {} } });

  // Observe the production-created private self handle without adding a test-only production API.
  const instrumentedHtml = html.replace(SELF_BOOTSTRAP, match =>
    `${match}\nwindow.__testWindowHostKind = _atoolsWindowHostKind;\nwindow.__testSelfWindowHandle = _browserWindowHandles[_atoolsBrowserWindowId];`);
  if (instrumentedHtml === html) throw new Error("Serialized bridge self bootstrap marker was not found");
  executeCompiledPluginBridgeScripts(instrumentedHtml, context, 3);
  return { sourceHtml: html, window, messages, dispatchMessage, nativeWindowCalls, originalWindowMethods, dispose: browser.dispose };
}

export function compileNativeWindowSelf(action = makeNativeFrameAction(), hostKind: "native" | "hosted" = "native") {
  const sourceHost = makeNativeFrameDocumentSourceHost(action);
  const html = sourceHost.host.injectBridge(NATIVE_FRAME_HTML, "browserWindow", NATIVE_FRAME_ID,
    "", NATIVE_GEOMETRY, hostKind);
  return compileNativeFrameDocument(html);
}
