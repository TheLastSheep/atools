import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { productionHostedIpcFixture } from "./pluginHostedIpcProductionFixture";
import { HostedBrowserWindowNavigationTokens } from "../../src/lib/hostedBrowserWindowRpc";
import { createPluginBrowserWindowWebContentsController } from "../../src/lib/pluginBrowserWindowWebContentsController";
import { createPluginBrowserWindowFrameCommands } from "../../src/lib/pluginBrowserWindowFrameCommands";
import { createPluginBrowserWindowActionDispatcher } from "../../src/lib/pluginBrowserWindowActionDispatcher";
import type { PluginBrowserWindowParentMessage } from "../../src/lib/pluginBrowserWindowTypes";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";
import { preparePluginBrowserWindowPreload } from "../../src/lib/pluginBrowserWindowPreload";

const originalRoot = "ZTools-plugins/plugins/pomodoro-timer/";
const oldFixture = "output/plugin-input-2026-10-17/hosted-ipc-evidence-v1/validation/atools-batch29-menu-diagnostics/before/nativePluginHostedIpcOperations.js";
export const menuClickChannel = "atools:fixture:hosted-ipc:original-menu-click";
export const menuClickMarker = "atools-original-menu-click-v1";
export type Trace = { event: string; action?: string; reqId?: number };

export async function waitFor(read: () => boolean, label: string) {
  const deadline = performance.now() + 1500;
  while (!read()) {
    if (performance.now() > deadline) throw Error(label);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/** Real transports and original sources, with gates only at independent queue boundaries. */
export async function originalMenuLifecycleFixture(options: {
  holdLifecycle?: boolean;
  documentTimeoutMs?: number;
  holdClickResponse?: boolean;
  holdMenuDelivery?: boolean;
  triggerMode?: "normal" | "missing" | "wrong-marker" | "wrong-sender";
} = {}) {
  // This scenario deliberately holds the lifecycle queue while loading real DOM/preload.
  // Use the production confirmation allowance; RPC response tests keep their 100ms bound.
  const h = await productionHostedIpcFixture({ documentTimeoutMs: options.documentTimeoutMs ?? 3000 }), main = await h.frame();
  h.setRealChildCreates({ holdLifecycle: !!options.holdLifecycle });
  const trace: Trace[] = [], heldReady: Array<() => void> = [], heldCreate: Array<() => void> = [];
  const heldResponses: Array<() => void> = [], heldMenu: Array<() => void> = [], domErrors: unknown[] = [];
  let createReqId = 0, clickReqId = 0, armReqId = 0, clickRpcRequests = 0, triggerSeen = 0;
  let child: any, stranger: any, dom: JSDOM | undefined;
  let clickError: string | undefined, clockOffset = 0, waitPauses = 0;
  let holdClickResponse = !!options.holdClickResponse, holdMenuDelivery = !!options.holdMenuDelivery;
  const runtime = createPluginRuntimePreload(async () => { throw Error("Unexpected Node invocation"); }, "ipc-fixture", () => true);

  // Preserve the actual Node MessageChannel. Delay posting a response, rather
  // than replacing RpcHost.call or inventing a result for executeJavaScript.
  const attach = h.rpc.attach.bind(h.rpc);
  h.rpc.attach = (id, target) => attach(id, { postMessage(message, origin, ports) {
    const port = ports[0] as MessagePort, post = port.postMessage.bind(port);
    port.postMessage = (value: any) => {
      if (value.__atools_hosted_browser_window_rpc_response__) {
        const deliver = () => { trace.push({ event: "rpc-response-posted", reqId: value.reqId }); post(value); };
        if (holdClickResponse && value.result === true) {
          trace.push({ event: "rpc-response-held", reqId: value.reqId }); heldResponses.push(deliver); return;
        }
        deliver(); return;
      }
      post(value);
    };
    target.postMessage(message, origin, ports);
  } });

  const sourcePost = main.source.postMessage.bind(main.source);
  function interceptSourcePost(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
  function interceptSourcePost(message: unknown, options?: WindowPostMessageOptions): void;
  function interceptSourcePost(message: unknown, targetOriginOrOptions?: string | WindowPostMessageOptions, transfer?: Transferable[]) {
    const detail = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (detail.__atools_native_response__ && detail.reqId === armReqId) {
      trace.push({ event: detail.error ? "arm-native-error" : "arm-native-result" });
    }
    if (detail.__atools_native_response__ && detail.reqId === clickReqId) {
      if (detail.error) clickError = String(detail.error);
      trace.push({ event: detail.error ? "click-native-error" : "click-native-result" });
    }
    const deliver = () => {
      if (typeof targetOriginOrOptions === "string") sourcePost(message, targetOriginOrOptions, transfer);
      else if (targetOriginOrOptions) sourcePost(message, targetOriginOrOptions);
      else sourcePost(message, "/");
    };
    if (detail.__atools_browser_window_ready__) { heldReady.push(deliver); return; }
    if (detail.__atools_native_response__ && detail.reqId === createReqId) { heldCreate.push(deliver); return; }
    if (detail.__atools_hosted_ipc__ && detail.channel === "contextMenuExce") {
      const menu = () => { trace.push({ event: "menu-parent-delivery" }); deliver(); };
      if (holdMenuDelivery) { heldMenu.push(menu); return; }
      menu(); return;
    }
    deliver();
  }
  main.source.postMessage = interceptSourcePost;

  // Compose the production controller modules directly. Only unrelated browser
  // actions are guarded; executeJavaScript and close use their real controllers.
  const navigation = new HostedBrowserWindowNavigationTokens();
  let windowsState = h.windows;
  const windowsPort = {
    get windows() { return windowsState; },
    set windows(value: typeof windowsState) { windowsState = value; h.windows.splice(0, h.windows.length, ...value); },
  };
  let lastMessage: PluginBrowserWindowParentMessage | null = null;
  const insertedCss = new Map<string, import("../../src/lib/pluginBrowserWindowTypes").PluginBrowserWindowInsertedCss>();
  let cssSequence = 0, findSequence = 0;
  const clearInsertedCss = (id: string) => {
    for (const [key, item] of insertedCss) if (item.windowId === id) insertedCss.delete(key);
  };
  const webContents = createPluginBrowserWindowWebContentsController({
    get windows() { return windowsState; }, set windows(value) { windowsPort.windows = value; },
    get lastMessage() { return lastMessage; }, set lastMessage(value) { lastMessage = value; },
    navigation, rpc: h.rpc, frames: h.browserWindowFrames, geometry: h.geometry, hostedIpc: h.router,
    sources: h.sources, insertedCss, clearInsertedCss,
    runNavigation: async (id, token, operation) => {
      navigation.assertCurrent(id, token); const result = await operation(); navigation.assertCurrent(id, token); return result;
    }, pageTitle: async (_id, fallback) => fallback, tick: async () => {},
  });
  const frameCommands = createPluginBrowserWindowFrameCommands({
    get windows() { return windowsState; }, set windows(value) { windowsPort.windows = value; },
    get lastMessage() { return lastMessage; }, set lastMessage(value) { lastMessage = value; },
    frames: h.browserWindowFrames, rpc: h.rpc, insertedCss, get cssSequence() { return cssSequence; }, set cssSequence(value) { cssSequence = value; },
    get findSequence() { return findSequence; }, set findSequence(value) { findSequence = value; },
    post: (source, message) => { const identity = h.sources.currentIdentityForHost(source); return identity ? h.sources.reply(source, identity, message) : false; },
    readyFrame: webContents.readyPluginBrowserWindowFrame,
    dispatchWebContentsEvent: webContents.dispatchPluginBrowserWindowWebContentsEvent,
  });
  const actionDispatcher = createPluginBrowserWindowActionDispatcher({
    get windows() { return windowsState; }, set windows(value) { windowsPort.windows = value; },
    get lastMessage() { return lastMessage; }, set lastMessage(value) { lastMessage = value; },
    mainFrame: () => h.mainFrameNode(main.source),
    post: (source, message) => { const identity = h.sources.currentIdentityForHost(source); return identity ? h.sources.reply(source, identity, message) : false; },
    geometry: h.geometry, navigation, rpc: h.rpc, hostedIpc: h.router, sources: h.sources,
    frames: h.browserWindowFrames, creators: h.creators, clearInsertedCss, webContents, frameCommands,
    nextZOrder: () => h.windows.length + 1,
    loadUrl: () => { throw Error("Unexpected navigation in menu lifecycle fixture"); },
    navigateHistory: () => { throw Error("Unexpected history navigation in menu lifecycle fixture"); },
    navigateHistoryToIndex: () => { throw Error("Unexpected history index in menu lifecycle fixture"); },
    clearHistory: () => { throw Error("Unexpected history clear in menu lifecycle fixture"); },
    updateUserAgent: () => { throw Error("Unexpected user-agent update in menu lifecycle fixture"); },
    updateFrameRate: () => { throw Error("Unexpected frame-rate update in menu lifecycle fixture"); },
    updateBackgroundThrottling: () => { throw Error("Unexpected throttling update in menu lifecycle fixture"); },
  });
  h.setBrowserWindowAction(args => {
    trace.push({ event: "native-action", action: String(args.action ?? "") });
    return actionDispatcher.handlePluginBrowserWindowAction(args);
  });
  const parentPost = main.window.parent.postMessage.bind(main.window.parent);
  main.window.parent.postMessage = (message: any, origin: string) => {
    if (message.__atools_native_call__ && message.method === "sendTo" && message.args?.channel === menuClickChannel) {
      trace.push({ event: "fixture-trigger-sent" });
      if (triggerSeen++ > 0) { parentPost(message, origin); return; }
      if (options.triggerMode === "wrong-marker") {
        parentPost({ ...message, args: { ...message.args, args: [menuClickMarker + "-wrong"] } }, origin);
      } else if (options.triggerMode === "missing" || options.triggerMode === "wrong-sender") {
        // Complete the parent's real native request against a different valid
        // target. A forged-sender test then uses the sibling's actual broker;
        // it never fabricates the authenticated event.senderId.
        parentPost({ ...message, args: { ...message.args, targetId: main.id } }, origin);
        if (stranger) stranger.window.require("electron").ipcRenderer.sendTo(child.id, menuClickChannel, menuClickMarker);
      } else parentPost(message, origin);
      return;
    }
    if (message.__atools_native_call__ && message.method === "createBrowserWindow") createReqId = message.reqId;
    if (message.__atools_native_call__ && message.method === "browserWindowAction") {
      if (message.args?.action === "webContents.executeJavaScript") {
        const code = String(message.args.args?.[0]);
        if (code === "document.getElementById('hidePile').click();true") { clickReqId = message.reqId; clickRpcRequests++; }
        if (code.includes("ipcRenderer.once(")) armReqId = message.reqId;
      }
      const identity = h.sources.identify(main.source);
      if (identity) void h.native({ source: main.source }, structuredClone(message), identity);
      return;
    }
    parentPost(message, origin);
  };

  main.window.console.log = () => {};
  main.window.ipcRenderer = main.window.require("electron").ipcRenderer;
  const toggles: boolean[] = [];
  main.window.__AToolsMenuFixtureState = { toggles };
  Object.assign(main.context, { URLSearchParams, performance: { now: () => performance.now() + clockOffset }, utools: main.window.utools,
    setTimeout: (callback: () => void, delay: number) => { if (delay === 20) waitPauses++; return setTimeout(callback, delay); },
    settings: { config: { autoHideAni: false, darkMode: "light" } }, tomatoPile: { getState: () => true },
    settingsPageComponent: [{ name: "showTomatoAnimation", component: { toggle: (value: boolean) => toggles.push(value) } }] });
  main.evaluate(await readFile(originalRoot + "page/index/js/contextMenuWindow.js", "utf8")
    + ";window.__AToolsReviewedContextMenuWindow=ContextMenuWindow;");

  async function prepareChild() {
    await waitFor(() => h.frames.length === 2, "Original child was not created");
    child = h.frames[1];
    const html = await readFile(originalRoot + "page/contextMenu/contextMenu.html", "utf8");
    dom = new JSDOM(html, { runScripts: "outside-only", url: "about:blank" });
    Object.assign(child.context, { document: dom.window.document, URLSearchParams, utools: child.window.utools });
    child.window.location = { search: "", origin: "null" }; child.window.console.log = () => {};
    child.context.location = child.window.location;
    const preload = await preparePluginBrowserWindowPreload({ pluginDir: "/fixture",
      options: { webPreferences: { nodeIntegration: true, preload: "base/js/preload.js" } },
      prepare: runtime.prepareAdditional, readTextFile: async path => {
        if (path !== "/fixture/base/js/preload.js") throw Error("Unexpected preload path");
        return readFile(originalRoot + "base/js/preload.js", "utf8");
      }, isCurrent: () => true });
    child.evaluate(preload.replace(/^<script[^>]*>\s*/, "").replace(/\s*<\/script>$/, ""));
    for (const script of dom.window.document.querySelectorAll("script")) child.evaluate(script.textContent || "");
    for (const element of dom.window.document.querySelectorAll("[onclick]")) {
      const original = element.getAttribute("onclick")!;
      element.addEventListener("click", () => { try { child.evaluate(original); } catch (error) { domErrors.push(error); } });
    }
    if (options.holdLifecycle) child.flushLifecycle();
    await waitFor(() => heldReady.length === 1 && heldCreate.length === 1, "Real readiness and create response did not arrive");
    if (options.triggerMode === "wrong-sender") stranger = await h.frame("untrusted-menu-sender", main);
    return child;
  }
  function release(queue: Array<() => void>) { for (const delivery of queue.splice(0)) delivery(); }
  async function startFixture(version: "old" | "current") {
    const filename = version === "old" ? oldFixture : "tests/components/nativePluginHostedIpcOperations.js";
    main.evaluate(await readFile(filename, "utf8"));
    return { result: main.window.__AToolsHostedIpcFixture.perform("original-context-menu") };
  }
  function startOriginal() {
    main.evaluate("window.__atoolsOriginalMenu=new window.__AToolsReviewedContextMenuWindow();window.__atoolsOriginalMenu.create(40,50);");
    return main.window.__atoolsOriginalMenu.contextmenuWindow;
  }
  async function close() {
    // Test cleanup is explicit and cannot turn an observed RPC failure into success.
    if (child && h.windows.some(item => item.id === child.windowId)) actionDispatcher.handlePluginBrowserWindowAction({ id: child.windowId, action: "close" });
    child?.childWiring?.destroy();
    for (const frame of h.frames) if (frame.windowId) h.sources.unregisterChild(frame.windowId);
    h.sources.unregisterMain(main.source); h.creators.clear(); h.windows.splice(0);
    h.closeRpc(); h.router.clear(); h.closeDocuments(); dom?.window.close(); await runtime.close();
    heldReady.length = heldCreate.length = heldResponses.length = heldMenu.length = 0;
  }
  return { h, main, trace, toggles, domErrors, prepareChild, startOriginal, startFixture, close,
    child: () => child, releaseReady: () => release(heldReady), releaseCreate: () => release(heldCreate),
    releaseMenu() { holdMenuDelivery = false; release(heldMenu); },
    releaseResponses() { holdClickResponse = false; release(heldResponses); },
    heldResponses: () => heldResponses.length, heldMenu: () => heldMenu.length,
    clickError: () => clickError, waitPauses: () => waitPauses,
    clickRpcRequests: () => clickRpcRequests,
    expireFixtureWait: () => { clockOffset += 6000; },
    failArming() { child.window.require("electron").ipcRenderer.once = () => { throw Error("controlled arming failure"); }; },
  };
}
