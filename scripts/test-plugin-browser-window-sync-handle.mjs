import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { pluginBrowserWindowBridgeFactorySource } from "./lib/plugin-bridge-fixture.mjs";

const root = new URL("../", import.meta.url);
const factorySource = await pluginBrowserWindowBridgeFactorySource();
const panelSource = await readFile(new URL("../src/components/PluginPanel.svelte", import.meta.url), "utf8");
const messageHostSource = await readFile(new URL("../src/lib/pluginPanelMessageHost.ts", import.meta.url), "utf8");
const authenticatedMessageSource = await readFile(new URL("../src/lib/authenticatedPluginMessageHandler.ts", import.meta.url), "utf8");
const browserWindowStateSource = await readFile(new URL("../src/lib/pluginPanelBrowserWindowState.svelte.ts", import.meta.url), "utf8");
const browserWindowTypesSource = await readFile(new URL("../src/lib/pluginBrowserWindowTypes.ts", import.meta.url), "utf8");
const frameMountSource = await readFile(new URL("../src/lib/pluginPanelFrameMount.ts", import.meta.url), "utf8");
const frameMountHostSource = await readFile(new URL("../src/lib/pluginPanelFrameMountHost.ts", import.meta.url), "utf8");
const readyHelperSource = await readFile(new URL("../src/lib/pluginBrowserWindowReady.ts", import.meta.url), "utf8");
const readyHelperCompiled = transpileModule(readyHelperSource, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
}).outputText;
const readyHelper = await import("data:text/javascript;base64," + Buffer.from(readyHelperCompiled).toString("base64"));
const tipsPath = new URL("ZTools-plugins/plugins/pomodoro-timer/page/index/js/tipsWindow.js", root);
const tipsSource = await readFile(tipsPath, "utf8");
const tipsHash = createHash("sha256").update(tipsSource).digest("hex");
assert.equal(tipsHash, "c30d5d96251165fcb63b01104c3f50b17cffd6049f937fbe0c8219ba60fb3909", "TipsWindow test source must remain fixed to the reviewed original class");

function createWindowContext() {
  const listeners = new Map();
  const parent = {};
  const window = {
    parent,
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener));
    },
    dispatch(type, data) {
      for (const listener of [...(listeners.get(type) || [])]) listener({ type, source: parent, data });
    },
  };
  const context = vm.createContext({ window, console, queueMicrotask, Promise });
  const createBridge = vm.runInContext(`(${factorySource})`, context);
  return { window, createBridge };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function resolvedHandle(record, calls) {
  const listeners = new Map();
  const webContents = { getOwnerBrowserWindow() { return handle; } };
  const handle = {
    id: record.id,
    type: "browserWindow",
    windowType: "browserWindow",
    url: record.url,
    title: record.title,
    webContents,
    on(event, listener) {
      const current = listeners.get(event) || [];
      current.push(listener);
      listeners.set(event, current);
      return handle;
    },
    setAlwaysOnTop(...args) { calls.push(["setAlwaysOnTop", ...args]); return Promise.resolve(); },
    setFullScreen(...args) { calls.push(["setFullScreen", ...args]); return Promise.resolve(); },
    setSkipTaskbar(...args) { calls.push(["setSkipTaskbar", ...args]); return Promise.resolve(); },
    close(...args) {
      calls.push(["close", ...args]);
      for (const listener of listeners.get("closed") || []) listener();
      return Promise.resolve({ closed: true });
    },
  };
  return handle;
}

const { window, createBridge } = createWindowContext();
const createRequest = deferred();
const requests = [];
const calls = [];
let callbackCount = 0;
const bridge = createBridge(window, {
  invoke(method, args) {
    requests.push({ method, args });
    return createRequest.promise;
  },
  createResolvedHandle: (record) => resolvedHandle(record, calls),
  maxPendingCreates: 2,
  maxQueuedOperations: 2,
});

const handle = bridge.createBrowserWindow("Tips.html", { show: false }, () => { callbackCount += 1; });
assert.equal(handle.isDestroyed(), false, "isDestroyed must synchronously report the known pending lifetime");
assert.equal(handle.then, undefined, "handle must not become a self-resolving thenable");
assert.equal(await handle, handle, "awaiting the facade remains immediate and does not imply child readiness");
assert.throws(() => handle.getBackgroundColor(), /ERR_ATOOLS_BROWSER_WINDOW_NOT_READY/, "native sync getters must reject while no native state exists");
const fullScreenCall = handle.setFullScreen(true);
const taskbarCall = handle.setSkipTaskbar(true);
await assert.rejects(handle.setAlwaysOnTop(true), /ERR_ATOOLS_BROWSER_WINDOW_QUEUE_LIMIT/, "pending operation queue must stay bounded");
await flushMicrotasks();
assert.equal(requests.length, 1, "create should dispatch once through the structured native bridge");
const clientCreateId = requests[0].args.clientCreateId;
window.dispatch("message", { __atools_browser_window_ready__: true, windowId: "tips-1", clientCreateId: "unrelated-token" });
assert.equal(callbackCount, 0, "unrelated early ready notifications must be ignored");
window.dispatch("message", { __atools_browser_window_ready__: true, windowId: "tips-1", clientCreateId });
createRequest.resolve({ id: "tips-1", clientCreateId, url: "Tips.html", title: "Tips" });
await Promise.all([fullScreenCall, taskbarCall]);
assert.equal(await handle.ready, handle, "an exact early ready notification should be joined to its pending create");
assert.equal(callbackCount, 1, "create callback should run once after the correlated child readiness signal");
assert.deepEqual(calls, [["setFullScreen", true], ["setSkipTaskbar", true]], "queued operations should flush in call order after native creation");
window.dispatch("message", { __atools_browser_window_ready__: true, windowId: "tips-1", clientCreateId });
assert.equal(callbackCount, 1, "duplicate readiness signals must not re-run the callback");
assert.deepEqual(await handle.destroy(), { closed: true }, "destroy should map to actual hosted close");
assert.equal(handle.isDestroyed(), true, "destroy should synchronously transition to destroyed after native close completes");
assert.deepEqual(calls.at(-1), ["close"], "destroy must invoke the real close operation");

const queueContext = createWindowContext();
const queueCreate = deferred();
const orderedCalls = [];
let orderedHandle;
let orderedClientCreateId;
let orderedCallbackOperation = Promise.resolve();
const queueBridge = queueContext.createBridge(queueContext.window, {
  invoke(_method, args) { orderedClientCreateId = args.clientCreateId; return queueCreate.promise; },
  createResolvedHandle(record) {
    const base = resolvedHandle(record, orderedCalls);
    base.setAlwaysOnTop = (value) => {
      orderedCalls.push(["setAlwaysOnTop", value]);
      return Promise.resolve();
    };
    return base;
  },
});
orderedHandle = queueBridge.createBrowserWindow("ordered.html", {}, () => {
  orderedCallbackOperation = orderedHandle.setAlwaysOnTop(true);
});
const priorSetter = orderedHandle.setAlwaysOnTop(false);
await flushMicrotasks();
queueContext.window.dispatch("message", {
  __atools_browser_window_ready__: true,
  windowId: "ordered-1",
  clientCreateId: orderedClientCreateId,
});
queueCreate.resolve({ id: "ordered-1", url: "ordered.html" });
await priorSetter;
await orderedHandle.ready;
await orderedCallbackOperation;
assert.deepEqual(orderedCalls, [["setAlwaysOnTop", false], ["setAlwaysOnTop", true]],
  "readiness callback setters must run after earlier queued setter calls");

const cancelContext = createWindowContext();
const lateCreate = deferred();
const cancelCalls = [];
const cancelBridge = cancelContext.createBridge(cancelContext.window, {
  invoke(_method, args) { return lateCreate.promise.then((record) => ({ ...record, clientCreateId: args.clientCreateId })); },
  createResolvedHandle: (record) => resolvedHandle(record, cancelCalls),
});
const cancelled = cancelBridge.createBrowserWindow("late.html", {});
await flushMicrotasks();
const lateClose = cancelled.close();
lateCreate.resolve({ id: "late-1", url: "late.html" });
await lateClose;
assert.equal(cancelled.isDestroyed(), true, "closing while creation is in flight should close a late native child");
assert.deepEqual(cancelCalls, [["close"]], "late create must be cleaned up with a real native close");

const rejectedContext = createWindowContext();
const rejectedBridge = rejectedContext.createBridge(rejectedContext.window, {
  invoke() { return Promise.reject(new Error("permission denied")); },
  createResolvedHandle: () => { throw new Error("a rejected create must not fabricate a handle"); },
});
const rejected = rejectedBridge.createBrowserWindow("denied.html", {});
await assert.rejects(rejected.ready, /permission denied/);
assert.equal(rejected.isDestroyed(), true, "rejected creation must release its pending facade");

const disposalContext = createWindowContext();
const disposeCreate = deferred();
const disposalCalls = [];
const disposalBridge = disposalContext.createBridge(disposalContext.window, {
  invoke(_method, args) { return disposeCreate.promise.then((record) => ({ ...record, clientCreateId: args.clientCreateId })); },
  createResolvedHandle: (record) => resolvedHandle(record, disposalCalls),
});
const disposed = disposalBridge.createBrowserWindow("dispose-late.html", {});
await flushMicrotasks();
disposalContext.window.dispatch("pagehide");
disposeCreate.resolve({ id: "dispose-late-1", url: "dispose-late.html" });
await assert.rejects(disposed.ready, /CLOSED/);
await flushMicrotasks();
assert.deepEqual(disposalCalls, [["close"]], "pagehide must close a native child created after the parent disappeared");

const readyRegistrations = new Map();
const readySources = { isCurrent(source, identity) { return readyRegistrations.get(source) === identity.generation; } };
const mainCreatorSource = {};
const childCreatorSource = {};
const peerSource = {};
const mainCreatorIdentity = { kind: "main", generation: 4 };
const childCreatorIdentity = { kind: "child", windowId: "outer", generation: 7 };
readyRegistrations.set(mainCreatorSource, mainCreatorIdentity.generation);
readyRegistrations.set(childCreatorSource, childCreatorIdentity.generation);
readyRegistrations.set(peerSource, 9);
const routed = [];
const postReady = (creator, message) => readyHelper.postPluginBrowserWindowReadiness({
  creator,
  sources: readySources,
  message,
  post(source, payload, identity) { routed.push({ source, payload, identity }); return true; },
});
assert.equal(postReady({ source: childCreatorSource, identity: childCreatorIdentity }, { ready: true }), true);
assert.equal(routed[0].source, childCreatorSource, "nested readiness must return to the exact requesting child frame");
assert.equal(routed[0].identity, childCreatorIdentity, "nested readiness must use the captured creator generation");
assert.equal(postReady({ source: mainCreatorSource, identity: mainCreatorIdentity }, { ready: true }), true);
assert.equal(routed[1].source, mainCreatorSource, "main-frame readiness remains routed to its own source");
readyRegistrations.set(childCreatorSource, childCreatorIdentity.generation + 1);
assert.equal(postReady({ source: childCreatorSource, identity: childCreatorIdentity }, { ready: true }), false,
  "a late ready event from a retired creator must not be delivered to a reused WindowProxy");

const ownedWindows = [
  { id: "outer" },
  { id: "grandchild" },
  { id: "peer-child" },
];
const ownedCreators = new Map([
  ["outer", { source: mainCreatorSource, identity: mainCreatorIdentity }],
  ["grandchild", { source: childCreatorSource, identity: childCreatorIdentity }],
  ["peer-child", { source: peerSource, identity: { kind: "main", generation: 9 } }],
]);
assert.equal(readyHelper.isPluginBrowserWindowTargetOwned({ targetId: "grandchild", source: childCreatorSource,
  identity: childCreatorIdentity, sources: readySources, windows: ownedWindows, creatorFor: (id) => ownedCreators.get(id) }), false,
  "a child target is denied after its creator generation changes");
readyRegistrations.set(childCreatorSource, childCreatorIdentity.generation);
assert.equal(readyHelper.isPluginBrowserWindowTargetOwned({ targetId: "outer", source: childCreatorSource,
  identity: childCreatorIdentity, sources: readySources, windows: ownedWindows, creatorFor: (id) => ownedCreators.get(id) }), true,
  "a child frame may control its own hosted window");
assert.equal(readyHelper.isPluginBrowserWindowTargetOwned({ targetId: "grandchild", source: childCreatorSource,
  identity: childCreatorIdentity, sources: readySources, windows: ownedWindows, creatorFor: (id) => ownedCreators.get(id) }), true,
  "a child frame may control only a direct child it created");
assert.equal(readyHelper.isPluginBrowserWindowTargetOwned({ targetId: "peer-child", source: childCreatorSource,
  identity: childCreatorIdentity, sources: readySources, windows: ownedWindows, creatorFor: (id) => ownedCreators.get(id) }), false,
  "a child frame must not control peer or ancestor windows");

const deferredHtml = deferred();
let hostGeneration = 12;
let lateChildRegistered = false;
const lateCreateCheck = deferredHtml.promise.then(() => {
  if (!readyHelper.isPluginBrowserWindowCreateCurrent({
    capturedGeneration: 12,
    currentGeneration: hostGeneration,
    creator: { source: mainCreatorSource, identity: mainCreatorIdentity },
    sources: readySources,
  })) throw new Error("creator source changed before child registration");
  lateChildRegistered = true;
});
hostGeneration += 1; // The parent outPlugin event invalidates pending child creation synchronously.
deferredHtml.resolve("late child page");
await assert.rejects(lateCreateCheck, /creator source changed/);
assert.equal(lateChildRegistered, false, "an outPlugin during deferred resource read must prevent late child insertion");
assert.match(authenticatedMessageSource,
  /if \(sourceIdentity\.kind === "main" && ports\.pluginItems\.length > 0\) \{\s*ports\.invalidateBrowserWindows\(\);\s*ports\.hostedIpc\.invalidate\(\{ kind: "main" \}\);\s*ports\.sources\.unregisterMain\(e\.source\);\s*\}/,
  "non-empty main output must synchronously invalidate pending creates, expire its document lease, and retire its source identity");
assert.match(messageHostSource,
  /const authenticated = createAuthenticatedPluginMessageHandler\(\{[\s\S]*?invalidateBrowserWindows: ports\.invalidateBrowserWindows[\s\S]*?\}\);[\s\S]*?dispatchAuthenticated:\s*\(event, data, identity\)\s*=>\s*\{\s*if\s*\(!broadcastChannels\.dispatch\(event\.source, identity, data, event\.origin\)\)\s*authenticated\(event, data, identity\);\s*\}/,
  "the message host must try the authenticated BroadcastChannel wrapper before the normal authenticated handler");
assert.match(panelSource, /invalidateBrowserWindows: invalidatePluginBrowserWindows/,
  "the panel must connect BrowserWindow invalidation to its current runtime");
assert.match(browserWindowStateSource, /const creators = new Map<string, PluginBrowserWindowCreator>\(\)/,
  "opaque creator WindowProxy references must stay outside Svelte's deep reactive state");
const browserWindowStateType = browserWindowTypesSource.match(/export type PluginBrowserWindowState = \{([\s\S]*?)^\s*\};/m)?.[1];
assert.ok(browserWindowStateType, "the reactive BrowserWindow record type must remain explicit");
assert.doesNotMatch(browserWindowStateType, /\bcreator\??\s*:/, "reactive BrowserWindow records must not retain opaque creator WindowProxy references");
assert.match(frameMountSource, /creator: ports\.creators\.get\(readyWindowId\)[\s\S]*?ports\.postReadiness/,
  "hosted child readiness must use the non-reactive creator registry");
assert.match(frameMountHostSource, /postReadiness: postPluginBrowserWindowReadiness/,
  "the frame-mount adapter must keep readiness routed through creator source validation");
assert.match(panelSource, /creatorFor: id => browserWindowPanelState\.creators\.get\(id\)/,
  "target ownership must resolve creator identity outside Svelte's reactive state");

const callbackCloseContext = createWindowContext();
const callbackCloseCalls = [];
let callbackCloseHandle;
let callbackCloseCreateId;
let callbackClosePromise = Promise.resolve();
let callbackCloseListenerCount = 0;
const callbackCloseBridge = callbackCloseContext.createBridge(callbackCloseContext.window, {
  invoke(_method, args) {
    callbackCloseCreateId = args.clientCreateId;
    return Promise.resolve({ id: "callback-close", url: "callback.html", clientCreateId: args.clientCreateId });
  },
  createResolvedHandle: (record) => resolvedHandle(record, callbackCloseCalls),
});
callbackCloseHandle = callbackCloseBridge.createBrowserWindow("callback.html", {}, () => { callbackClosePromise = callbackCloseHandle.close(); });
await flushMicrotasks();
callbackCloseHandle.onReady(() => { callbackCloseListenerCount += 1; });
callbackCloseContext.window.dispatch("message", {
  __atools_browser_window_ready__: true,
  windowId: "callback-close",
  clientCreateId: callbackCloseCreateId,
});
await callbackCloseHandle.ready;
await callbackClosePromise;
assert.equal(callbackCloseHandle.isDestroyed(), true);
assert.equal(callbackCloseListenerCount, 0,
  "a ready callback that closes or disposes the bridge must suppress later queued ready listeners");

for (const closeMode of ["close", "dispose"]) {
  const context = createWindowContext();
  const closeCalls = [];
  let createId;
  const callbackBridge = context.createBridge(context.window, {
    invoke(_method, args) {
      createId = args.clientCreateId;
      return Promise.resolve({ id: `ready-listener-${closeMode}`, url: "ready.html", clientCreateId: args.clientCreateId });
    },
    createResolvedHandle: (record) => resolvedHandle(record, closeCalls),
  });
  const listenerHandle = callbackBridge.createBrowserWindow("ready.html", {});
  await flushMicrotasks();
  context.window.dispatch("message", {
    __atools_browser_window_ready__: true,
    windowId: `ready-listener-${closeMode}`,
    clientCreateId: createId,
  });
  await listenerHandle.ready;
  let listenerCount = 0;
  listenerHandle.onReady(() => { listenerCount += 1; });
  if (closeMode === "close") await listenerHandle.close();
  else context.window.dispatch("pagehide");
  await flushMicrotasks();
  assert.equal(listenerCount, 0, `queued onReady callback must not fire after ${closeMode}`);
}

const readyBoundContext = createWindowContext();
const readyBoundHandle = readyBoundContext.createBridge(readyBoundContext.window, {
  invoke() { return new Promise(() => {}); },
  createResolvedHandle: () => { throw new Error("never-created ready-bound handle"); },
}).createBrowserWindow("ready-bound.html", {});
for (let index = 0; index < 32; index += 1) readyBoundHandle.onReady(() => {});
assert.throws(() => readyBoundHandle.onReady(() => {}), /ERR_ATOOLS_BROWSER_WINDOW_QUEUE_LIMIT/,
  "pending ready callbacks must have an explicit per-window budget");
void readyBoundHandle.close();
assert.throws(() => readyBoundHandle.onReady(() => {}), /CLOSED/, "registering a readiness listener after close must be rejected");

const pendingCloseContext = createWindowContext();
const pendingCloseCreate = deferred();
let pendingCloseAttempts = 0;
const pendingCloseBridge = pendingCloseContext.createBridge(pendingCloseContext.window, {
  invoke(_method, args) { return pendingCloseCreate.promise.then((record) => ({ ...record, clientCreateId: args.clientCreateId })); },
  createResolvedHandle(record) {
    return {
      ...resolvedHandle(record, []),
      close() {
        pendingCloseAttempts += 1;
        if (pendingCloseAttempts === 1) return Promise.reject(new Error("native close failed"));
        return Promise.resolve({ closed: true });
      },
    };
  },
});
const pendingCloseHandle = pendingCloseBridge.createBrowserWindow("pending-close.html", {});
await flushMicrotasks();
const rejectedPendingClose = pendingCloseHandle.close();
pendingCloseCreate.resolve({ id: "pending-close-1", url: "pending-close.html" });
await assert.rejects(rejectedPendingClose, /native close failed/);
assert.equal(pendingCloseHandle.isDestroyed(), false,
  "a rejected late native close must preserve the live handle and allow retry");
assert.deepEqual(await pendingCloseHandle.close(), { closed: true });
assert.equal(pendingCloseHandle.isDestroyed(), true);

for (const closeFailure of ["reject", "false-ack"]) {
  const context = createWindowContext();
  const create = deferred();
  let createId;
  let closeAttempts = 0;
  const bridge = context.createBridge(context.window, {
    invoke(_method, args) { createId = args.clientCreateId; return create.promise; },
    createResolvedHandle: (record) => ({
      ...resolvedHandle(record, []),
      close() {
        closeAttempts += 1;
        if (closeAttempts === 1 && closeFailure === "reject") return Promise.reject(new Error("late cleanup rejected"));
        if (closeAttempts === 1) return Promise.resolve({ closed: false });
        return Promise.resolve({ closed: true });
      },
    }),
  });
  const handle = bridge.createBrowserWindow("failed-before-create.html", {});
  await flushMicrotasks();
  context.window.dispatch("message", {
    __atools_browser_window_failed__: true,
    windowId: "awaiting-native-id",
    clientCreateId: createId,
    error: "child load failed",
  });
  await assert.rejects(handle.ready, /child load failed/);
  create.resolve({ id: `failed-late-${closeFailure}`, url: "failed-before-create.html" });
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closeAttempts, 1, "early failure must automatically close the native child when creation resolves");
  assert.equal(handle.isDestroyed(), false, `late failed cleanup (${closeFailure}) must preserve its live host handle`);
  await handle.close();
  assert.equal(handle.isDestroyed(), true);
}

const pendingFalseContext = createWindowContext();
const pendingFalseCreate = deferred();
let pendingFalseAttempt = 0;
const pendingFalseBridge = pendingFalseContext.createBridge(pendingFalseContext.window, {
  invoke() { return pendingFalseCreate.promise; },
  createResolvedHandle: (record) => ({
    ...resolvedHandle(record, []),
    close() { return Promise.resolve(++pendingFalseAttempt === 1 ? { closed: false } : { closed: true }); },
  }),
});
const pendingFalseHandle = pendingFalseBridge.createBrowserWindow("pending-false.html", {});
await flushMicrotasks();
const unconfirmedPendingClose = pendingFalseHandle.close();
pendingFalseCreate.resolve({ id: "pending-false-1", url: "pending-false.html" });
await assert.rejects(unconfirmedPendingClose, /CLOSE_UNCONFIRMED/);
assert.equal(pendingFalseHandle.isDestroyed(), false,
  "a late pending close without closed=true must keep the real hosted handle live");
await pendingFalseHandle.close();
assert.equal(pendingFalseHandle.isDestroyed(), true);

const unconfirmedCloseContext = createWindowContext();
let unconfirmedCreateId;
let unconfirmedAttempts = 0;
const unconfirmedBridge = unconfirmedCloseContext.createBridge(unconfirmedCloseContext.window, {
  invoke(_method, args) {
    unconfirmedCreateId = args.clientCreateId;
    return Promise.resolve({ id: "unconfirmed-close", url: "close.html", clientCreateId: args.clientCreateId });
  },
  createResolvedHandle(record) {
    const handle = resolvedHandle(record, []);
    handle.close = () => Promise.resolve(++unconfirmedAttempts === 1 ? false : { closed: true });
    return handle;
  },
});
const unconfirmedHandle = unconfirmedBridge.createBrowserWindow("close.html", {});
await flushMicrotasks();
unconfirmedCloseContext.window.dispatch("message", {
  __atools_browser_window_ready__: true,
  windowId: "unconfirmed-close",
  clientCreateId: unconfirmedCreateId,
});
await unconfirmedHandle.ready;
await assert.rejects(unconfirmedHandle.close(), /CLOSE_UNCONFIRMED/);
assert.equal(unconfirmedHandle.isDestroyed(), false, "a false close acknowledgement must not fake destruction");
await unconfirmedHandle.close();
assert.equal(unconfirmedHandle.isDestroyed(), true);

// Execute only the fixed-hash original TipsWindow class. No plugin page, preload, Node module, or GUI is run.
const actualContext = createWindowContext();
const actualCreate = deferred();
const actualCalls = [];
const actualRequests = [];
const actualBridge = actualContext.createBridge(actualContext.window, {
  invoke(_method, args) {
    actualRequests.push(args);
    return actualCreate.promise.then((record) => ({ ...record, clientCreateId: args.clientCreateId }));
  },
  createResolvedHandle: (record) => resolvedHandle(record, actualCalls),
});
const tipsVm = vm.createContext({ utools: { createBrowserWindow: actualBridge.createBrowserWindow }, encodeURIComponent, Promise });
vm.runInContext(`${tipsSource}\nthis.TipsWindow = TipsWindow;`, tipsVm, { filename: "fixed-hash-TipsWindow.js" });
const tips = new tipsVm.TipsWindow();
const createResult = tips.create("success");
assert.equal(typeof tips.tipsWindow.isDestroyed, "function", "original class must receive an immediate usable handle");
assert.equal(tips.tipsWindow.isDestroyed(), false, "original class's synchronous lifecycle check must work before creation resolves");
await createResult;
await flushMicrotasks();
assert.equal(actualCalls.length, 0, "original callback must wait until child page and RPC are ready");
assert.equal(actualBridge.getPendingCreateCount(), 1, "creating count should remain reserved until the native create response arrives");
const actualHandle = tips.tipsWindow;
const actualCreateId = actualRequests[0].clientCreateId;
actualCreate.resolve({ id: "original-tips-window", url: "page/Tips/successTips.html?type=success", title: "Tips" });
await flushMicrotasks();
assert.equal(actualHandle.isDestroyed(), false, "the original TipsWindow handle should remain live after host creation");
assert.deepEqual(actualCalls, [], "fixed-hash TipsWindow callback must not run before the child handshake");
actualContext.window.dispatch("message", {
  __atools_browser_window_ready__: true,
  windowId: "original-tips-window",
  clientCreateId: actualCreateId,
});
await actualHandle.ready;
await flushMicrotasks();
assert.deepEqual(actualCalls, [["setSkipTaskbar", true], ["setAlwaysOnTop", true, "status"]], "original TipsWindow callback must execute its real synchronous handle methods after readiness");
await tips.close();
assert.equal(tips.tipsWindow, null, "original TipsWindow.close() should clear its reference after destroy");
assert.deepEqual(actualCalls.at(-1), ["close"], "original TipsWindow.destroy() should map to hosted native close");
