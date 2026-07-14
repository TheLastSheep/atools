import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const outDir = await mkdtemp(join(root.pathname, ".tmp-hosted-browser-window-isolation-"));
const outFile = join(outDir, "hostedBrowserWindowRpc.mjs");
const cleanups = [];

function waitForMessage(port, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    let timeoutId;
    const onMessage = (message) => {
      clearTimeout(timeoutId);
      resolve(message);
    };
    timeoutId = setTimeout(() => {
      port.off("message", onMessage);
      reject(new Error(`Timed out waiting ${timeoutMs}ms for MessagePort message`));
    }, timeoutMs);
    port.once("message", onMessage);
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cleanupWith(callback) {
  cleanups.push(callback);
}

async function loadRpcModule() {
  const sourcePath = new URL("src/lib/hostedBrowserWindowRpc.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);
  return import(pathToFileURL(outFile).href);
}

try {
  const rpc = await loadRpcModule();

  assert.equal(
    rpc.HOSTED_BROWSER_WINDOW_ISOLATED_UNSUPPORTED,
    "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED",
  );
  assert.equal(
    rpc.HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS,
    3_000,
    "frame attachment and RPC readiness should share the bounded timeout contract",
  );
  assert.deepEqual(
    [...rpc.HOSTED_BROWSER_WINDOW_RPC_METHODS].sort(),
    ["describe", "executeJavaScript", "findInPage", "insertCSS", "removeInsertedCSS", "sendInputEvent", "stopFindInPage"].sort(),
    "hosted child RPC must have a fixed, narrow method allowlist",
  );

  assert.equal(
    typeof rpc.HostedBrowserWindowNavigationTokens,
    "function",
    "hosted navigation should expose a per-window monotonic token guard",
  );
  const navigationTokens = new rpc.HostedBrowserWindowNavigationTokens();
  const firstHtml = deferred();
  const secondHtml = deferred();
  let navigationState = "initial";
  const issuedNavigationTokens = [];
  async function navigateWithDeferredHtml(label, html) {
    const token = navigationTokens.begin("concurrent-child");
    issuedNavigationTokens.push(token);
    const srcdoc = await html.promise;
    navigationTokens.assertCurrent("concurrent-child", token);
    navigationState = `${label}:${srcdoc}`;
    return token;
  }
  const firstNavigation = navigateWithDeferredHtml("first", firstHtml);
  const secondNavigation = navigateWithDeferredHtml("second", secondHtml);
  secondHtml.resolve("shared-srcdoc");
  const secondNavigationToken = await secondNavigation;
  assert.ok(issuedNavigationTokens[1] > issuedNavigationTokens[0], "concurrent navigation tokens must be unique and monotonic");
  assert.equal(navigationState, "second:shared-srcdoc");
  firstHtml.resolve("shared-srcdoc");
  await assert.rejects(
    firstNavigation,
    /navigation concurrent-child superseded/,
    "an older deferred navigation must reject instead of writing after a newer navigation",
  );
  assert.equal(navigationState, "second:shared-srcdoc", "the superseded navigation must not overwrite newer state");
  assert.equal(navigationTokens.isCurrent("concurrent-child", secondNavigationToken), true);

  const raceChannels = [];
  const raceHost = new rpc.HostedBrowserWindowRpcHost({
    timeoutMs: 20,
    createChannel() {
      const port1 = {
        onmessage: null,
        messages: [],
        start() {},
        close() {},
        postMessage(message) { this.messages.push(message); },
      };
      const port2 = { close() {} };
      const channel = { port1, port2 };
      raceChannels.push(channel);
      return channel;
    },
  });
  cleanupWith(() => raceHost.closeAll());
  const raceTarget = { postMessage() {} };
  const oldGeneration = raceHost.attach("race-child", raceTarget);
  const oldCall = raceHost.call("race-child", "describe", {});
  raceChannels[0].port1.onmessage({
    data: { __atools_hosted_browser_window_rpc_ready__: true, generation: oldGeneration },
  });
  const newGeneration = raceHost.attach("race-child", raceTarget);
  raceChannels[1].port1.onmessage({
    data: { __atools_hosted_browser_window_rpc_ready__: true, generation: newGeneration },
  });
  await assert.rejects(
    oldCall,
    /reloaded/,
    "a call waiting on an old generation must not resume against a replacement port",
  );
  assert.equal(
    raceChannels[1].port1.messages.length,
    0,
    "an old call must never post its request to the new generation",
  );
  raceHost.closeAll();

  const posted = [];
  const target = {
    postMessage(message, _origin, transfer) {
      posted.push({ message, transfer });
    },
  };
  const host = new rpc.HostedBrowserWindowRpcHost({ timeoutMs: 50 });
  cleanupWith(() => host.closeAll());
  const generation = host.attach("child-a", target);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.generation, generation);
  assert.equal(posted[0].message.windowId, undefined, "dedicated-port init must not trust or carry payload windowId");
  assert.equal(posted[0].transfer.length, 1);

  const childPort = posted[0].transfer[0];
  cleanupWith(() => childPort.close());
  childPort.postMessage({
    __atools_hosted_browser_window_rpc_ready__: true,
    generation,
    windowId: "spoofed-window",
  });
  await host.waitReady("child-a");

  const resultPromise = host.call("child-a", "describe", {});
  const request = await waitForMessage(childPort);
  assert.equal(request.method, "describe");
  assert.equal(request.windowId, undefined, "dedicated-port requests must not trust or carry payload windowId");
  childPort.postMessage({
    __atools_hosted_browser_window_rpc_response__: true,
    generation,
    reqId: request.reqId,
    windowId: "spoofed-window",
    result: { title: "opaque child" },
  });
  assert.deepEqual(await resultPromise, { title: "opaque child" });

  await assert.rejects(
    host.call("child-a", "unknownMethod", {}),
    /Unsupported hosted BrowserWindow RPC method: unknownMethod/,
  );

  const reloadPending = host.call("child-a", "describe", {});
  await waitForMessage(childPort);
  const reloadTarget = { postMessage() {} };
  host.attach("child-a", reloadTarget);
  await assert.rejects(reloadPending, /reloaded/);

  const closePosted = [];
  const closeTarget = {
    postMessage(message, _origin, transfer) {
      closePosted.push({ message, transfer });
    },
  };
  const closeGeneration = host.attach("child-b", closeTarget);
  const closePort = closePosted[0].transfer[0];
  cleanupWith(() => closePort.close());
  closePort.postMessage({ __atools_hosted_browser_window_rpc_ready__: true, generation: closeGeneration });
  await host.waitReady("child-b");
  const closePending = host.call("child-b", "describe", {});
  await waitForMessage(closePort);
  host.close("child-b");
  await assert.rejects(closePending, /closed/);

  assert.match(
    componentSource,
    /const PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX = "allow-scripts allow-popups"/,
    "hosted BrowserWindow iframe must remain opaque",
  );
  assert.doesNotMatch(componentSource, /contentDocument/, "host must never read a hosted child contentDocument");
  assert.doesNotMatch(componentSource, /frame\.contentWindow\?*\.?document/, "host must never read a hosted child contentWindow.document");
  assert.doesNotMatch(componentSource, /frame\.contentWindow[^\n;]*\.eval\(/, "host must never eval through a hosted child WindowProxy");
  assert.doesNotMatch(componentSource, /frame\.contentWindow[^\n;]*getSelection/, "host must never read a hosted child selection");
  assert.match(
    componentSource,
    /\{#key childWindow\.documentGeneration\}[\s\S]*?<iframe[\s\S]*?use:pluginBrowserWindowFrame=\{childWindow\.id\}[\s\S]*?<\/iframe>[\s\S]*?\{\/key\}/,
    "hosted child navigation must remount the iframe even when the next srcdoc string is unchanged",
  );
  const loadNavigationSource = componentSource.slice(
    componentSource.indexOf("async function loadPluginBrowserWindowUrl"),
    componentSource.indexOf("function stopPluginBrowserWindowLoading"),
  );
  const loadTokenIndex = loadNavigationSource.indexOf("const navigationToken = pluginBrowserWindowNavigation.begin(existing.id)");
  const loadHtmlIndex = loadNavigationSource.indexOf("pluginBrowserWindowHtml(nextUrl)");
  assert.ok(loadTokenIndex >= 0 && loadTokenIndex < loadHtmlIndex, "load/reload must reserve its navigation token before awaiting HTML");
  assert.match(loadNavigationSource, /documentGeneration:\s*navigationToken/, "load/reload must use its unique token as the iframe document generation");
  assert.ok(
    [...loadNavigationSource.matchAll(/runCurrentPluginBrowserWindowNavigation\(\s*existing\.id,\s*navigationToken/g)].length >= 4,
    "load/reload must guard HTML, frame readiness, title RPC, and their async boundaries",
  );
  assert.match(
    loadNavigationSource,
    /pluginBrowserWindowNavigation\.assertCurrent\(existing\.id, navigationToken\);\n\s+let updatedWindow/,
    "load/reload must re-check its token immediately before final title/history/loading writeback",
  );
  const historyNavigationSource = componentSource.slice(
    componentSource.indexOf("async function navigatePluginBrowserWindowHistoryToIndex"),
    componentSource.indexOf("async function navigatePluginBrowserWindowHistory("),
  );
  assert.match(
    historyNavigationSource,
    /const navigationToken = pluginBrowserWindowNavigation\.begin\(existing\.id\)/,
    "every history navigation must reserve a new navigation token",
  );
  assert.match(historyNavigationSource, /documentGeneration:\s*navigationToken/, "history navigation must remount with its unique token");
  assert.ok(
    [...historyNavigationSource.matchAll(/runCurrentPluginBrowserWindowNavigation\(\s*existing\.id,\s*navigationToken/g)].length >= 3,
    "history navigation must guard frame readiness and title RPC boundaries",
  );
  assert.match(
    historyNavigationSource,
    /pluginBrowserWindowNavigation\.assertCurrent\(existing\.id, navigationToken\);\n\s+let updatedWindow/,
    "history navigation must re-check its token before final title/history/loading writeback",
  );
  for (const actionName of [
    "webContents.reload",
    "webContents.reloadIgnoringCache",
    "webContents.goBack",
    "webContents.goForward",
    "webContents.navigationHistory.goBack",
    "webContents.navigationHistory.goForward",
    "webContents.navigationHistory.goToIndex",
    "webContents.navigationHistory.goToOffset",
    "reload",
  ]) {
    assert.match(
      componentSource,
      new RegExp(`actionName === ["']${actionName.replaceAll(".", "\\.")}["']`),
      `${actionName} must route through a token-guarded shared navigation path`,
    );
  }
  assert.match(
    componentSource,
    /const deadline = Date\.now\(\) \+ HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS/,
    "frame attachment must use the same bounded timeout as RPC readiness",
  );
  for (const actionName of ["inspectElement", "capturePage", "printToPDF", "savePage"]) {
    assert.match(
      componentSource,
      new RegExp(`hostedBrowserWindowUnsupported\\(\"webContents\\.${actionName}\"\\)`),
      `${actionName} must fail with the shared isolated-host error`,
    );
  }
  assert.match(componentSource, /bindNativeBridgeArgsToSource/);

  const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
  assert.ok(bridgeMatch, "PluginPanel should define the injected uTools bridge");
  const bridgeSource = bridgeMatch[1]
    .replace(/<\\\/script>/g, "</script>")
    .replace(/^\s*<script>\s*/, "")
    .replace(/\s*<\/script>\s*$/, "")
    .replace(/__PLUGIN_ID__/g, JSON.stringify("isolated-rpc-plugin"))
    .replace(/__FEATURE_CODE__/g, JSON.stringify("isolated-rpc-feature"))
    .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
    .replace(/__APP_NAME__/g, JSON.stringify("ATools"))
    .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"))
    .replace("var _atoolsWindowType = 'main';", "var _atoolsWindowType = 'browserWindow';")
    .replace("var _atoolsBrowserWindowId = '';", "var _atoolsBrowserWindowId = 'child-rpc';");

  const messageListeners = [];
  const inputEvents = [];
  const styles = [];
  const body = {
    innerText: "Alpha beta alpha",
    textContent: "Alpha beta alpha",
    getBoundingClientRect: () => ({ left: 2, top: 3, width: 100, height: 40 }),
  };
  const activeElement = {
    dispatchEvent(event) {
      inputEvents.push({ type: event.type, key: event.key });
      return true;
    },
  };
  const documentStub = {
    title: "Opaque RPC Child",
    readyState: "complete",
    body,
    documentElement: { textContent: body.textContent },
    activeElement,
    head: { appendChild(style) { styles.push(style); } },
    addEventListener() {},
    createElement(tagName) {
      return {
        tagName,
        attributes: {},
        textContent: "",
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        remove() { this.removed = true; },
      };
    },
    querySelectorAll() { return styles.filter((style) => !style.removed); },
    elementFromPoint() { return activeElement; },
    getSelection() { return { removeAllRanges() {} }; },
  };
  class EventStub {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  }
  const parentStub = {};
  const windowStub = {
    parent: parentStub,
    top: {},
    addEventListener(type, handler) { if (type === "message") messageListeners.push(handler); },
    dispatchEvent() {},
    matchMedia() { return { matches: false }; },
    KeyboardEvent: EventStub,
    MouseEvent: EventStub,
    WheelEvent: EventStub,
    getSelection() { return documentStub.getSelection(); },
  };
  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0" },
    Event: EventStub,
    KeyboardEvent: EventStub,
    MouseEvent: EventStub,
    WheelEvent: EventStub,
    Error,
    Promise,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    console: { error() {}, warn() {}, log() {} },
    setTimeout(cb) { cb(); return 1; },
    clearTimeout() {},
  });
  vm.runInContext(bridgeSource, context, { filename: "isolated-hosted-browser-window-bridge.vm.js" });

  const wrongChannel = new MessageChannel();
  cleanupWith(() => wrongChannel.port1.close());
  cleanupWith(() => wrongChannel.port2.close());
  messageListeners.forEach((handler) => handler({
    source: {},
    data: { __atools_hosted_browser_window_rpc_init__: true, generation: 1 },
    ports: [wrongChannel.port2],
  }));
  wrongChannel.port1.postMessage({
    __atools_hosted_browser_window_rpc_request__: true,
    generation: 1,
    reqId: 1,
    method: "describe",
    args: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(wrongChannel.port1.listenerCount("message"), 0, "child init must reject non-parent senders");

  const channel = new MessageChannel();
  cleanupWith(() => channel.port1.close());
  cleanupWith(() => channel.port2.close());
  const readyMessage = waitForMessage(channel.port1);
  messageListeners.forEach((handler) => handler({
    source: parentStub,
    data: { __atools_hosted_browser_window_rpc_init__: true, generation: 2 },
    ports: [channel.port2],
  }));
  assert.equal((await readyMessage).__atools_hosted_browser_window_rpc_ready__, true);

  let reqId = 0;
  async function childCall(method, args = {}) {
    const nextReqId = ++reqId;
    const responsePromise = waitForMessage(channel.port1);
    channel.port1.postMessage({
      __atools_hosted_browser_window_rpc_request__: true,
      generation: 2,
      reqId: nextReqId,
      method,
      args,
      windowId: "spoofed-window",
    });
    const response = await responsePromise;
    assert.equal(response.reqId, nextReqId);
    if (response.error) throw new Error(response.error);
    return response.result;
  }

  assert.equal(await childCall("executeJavaScript", { code: "21 * 2" }), 42);
  assert.equal(await childCall("executeJavaScript", { code: "Promise.resolve(42)" }), 42);
  await assert.rejects(childCall("executeJavaScript", { code: "throw new Error('rpc-boom')" }), /rpc-boom/);
  await assert.rejects(childCall("unknownMethod"), /Unsupported hosted BrowserWindow RPC method/);

  const description = await childCall("describe");
  assert.equal(description.title, "Opaque RPC Child");
  assert.equal(description.readyState, "complete");
  assert.equal(description.text, "Alpha beta alpha");

  await childCall("sendInputEvent", { inputEvent: { type: "keyDown", key: "K", code: "KeyK" } });
  assert.deepEqual(inputEvents[0], { type: "keydown", key: "K" });

  const cssKey = await childCall("insertCSS", { key: "child-rpc:css:1", css: "body{color:red}", cssOrigin: "author" });
  assert.equal(cssKey, "child-rpc:css:1");
  assert.equal(styles[0].textContent, "body{color:red}");
  await childCall("removeInsertedCSS", { key: cssKey });
  assert.equal(styles[0].removed, true);

  const findResult = await childCall("findInPage", { text: "alpha", matchCase: false, forward: true, requestId: 7 });
  assert.equal(findResult.matches, 2);
  assert.equal(findResult.requestId, 7);
  assert.equal(await childCall("stopFindInPage", { action: "clearSelection" }), undefined);

} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // Best-effort cleanup must not hide the test failure.
    }
  }
  await rm(outDir, { recursive: true, force: true });
}

console.log("hosted BrowserWindow isolation tests passed");
