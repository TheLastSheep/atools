import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { pluginBrowserWorkerBridgeFactorySource } from "./lib/plugin-bridge-fixture.mjs";
import { createPluginWorkerFixture, createServiceWorkerContainerFixture } from "./lib/plugin-worker-fixture.mjs";

const root = new URL("../", import.meta.url);
const panelSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const documentSourceHostSource = await readFile(new URL("src/lib/pluginPanelDocumentSourceHost.ts", root), "utf8");
const bridgeCompilerSource = await readFile(new URL("src/lib/pluginPanelBridgeCompiler.ts", root), "utf8");
const loadControllerSource = await readFile(new URL("src/lib/pluginPanelLoadController.ts", root), "utf8");
const nativeShimSource = await readFile(new URL("src/lib/pluginUtoolsBridgeSource/native-call-and-node-shims.ts", root), "utf8");
const fixtureFactorySource = await readFile(new URL("scripts/lib/plugin-bridge-fixture.mjs", root), "utf8");

assert.match(panelSource, /import \{ createPluginPanelDocumentSourceHost \} from "\.\.\/lib\/pluginPanelDocumentSourceHost"/,
  "PluginPanel should own the document source host that assembles its plugin bridge");
assert.match(panelSource, /const pluginPanelDocumentSourceHost = createPluginPanelDocumentSourceHost\(\{/,
  "PluginPanel should instantiate the production document source host");
assert.match(panelSource, /const \{ injectBridge: injectPluginBridge,[\s\S]*?\} = pluginPanelDocumentSourceHost/,
  "PluginPanel should route bridge injection through the production document source host");
assert.match(panelSource, /injectPluginBridge:\s*\(html, windowType, browserWindowId, preloadScript, geometrySnapshot, entryMode\)\s*=>\s*injectPluginBridge\(html, windowType, browserWindowId, preloadScript, geometrySnapshot, undefined, entryMode\)/,
  "PluginPanel should pass its production bridge injector to the load controller");
assert.match(panelSource, /injectBridge:\s*injectPluginBridge,\s*mountNativeFrame:/,
  "the PluginPanel frame mount path should use the same production bridge injector");
assert.match(loadControllerSource, /ports\.injectPluginBridge\(html,\s*"main",\s*"",\s*preloadScript/,
  "plugin document loading should call the injected production bridge path");

assert.match(documentSourceHostSource, /import \{ createPluginBridgeDocument, injectPluginBridgeHtml,[^\n]*from "\.\/pluginPanelBridgeCompiler"/,
  "the document source host should use the production bridge compiler");
assert.match(documentSourceHostSource, /return createPluginBridgeDocument\(\{[\s\S]*?workerScope,/,
  "the document source host should pass the per-document worker scope into bridge assembly");
assert.match(bridgeCompilerSource, /import \{ createPluginBrowserWorkerBridge \} from "\.\/pluginBrowserWorkerBridge"/,
  "the production compiler should import the isolated browser worker factory");
assert.match(bridgeCompilerSource, /\.replace\("__ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__",\s*\(\)\s*=>\s*createPluginBrowserWorkerBridge\.toString\(\)\)/,
  "the production compiler should serialize the worker factory into the bridge placeholder");
assert.match(nativeShimSource, /\(__ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__\)\(window,\s*__ATOOLS_WORKER_SCOPE__\);/,
  "the serialized factory should execute in the plugin window with its injected worker scope");
assert.match(fixtureFactorySource,
  /\["__ATOOLS_BROWSER_WORKER_BRIDGE_FACTORY__",\s*"pluginBrowserWorkerBridge\.ts",\s*"createPluginBrowserWorkerBridge"\]/,
  "the VM behavior fixture should resolve the same production factory module and export");
assert.match(fixtureFactorySource, /module\[exportName\]\.toString\(\)/,
  "the VM behavior fixture should execute serialized production source rather than a substitute");

const factorySource = await pluginBrowserWorkerBridgeFactorySource();
const workerFixture = createPluginWorkerFixture();
const serviceWorkerFixture = createServiceWorkerContainerFixture();
const document = { baseURI: "asset://localhost/plugins/sample/index.html" };
function events() {
  const listeners = new Map();
  return { addEventListener: (kind, listener) => listeners.set(kind, listener),
    removeEventListener: kind => listeners.delete(kind), dispatch: (kind, event) => listeners.get(kind)?.(event),
    dispatchEvent: event => { listeners.get(event.type)?.(event); return true; },
    listenerCount: () => listeners.size };
}
const windowEvents = events();
const pluginWindow = {
  ...windowEvents,
  Worker: workerFixture.NativeWorkerStub,
  URL: workerFixture.WorkerUrlStub,
  Blob: workerFixture.WorkerBlobStub,
  document,
  location: { host: "plugin.local" },
  navigator: { serviceWorker: serviceWorkerFixture.nativeServiceWorker },
};
vm.runInNewContext(`(${factorySource})(window);`, { window: pluginWindow });

const classicOptions = { name: "classic plugin worker", credentials: "omit" };
const classicWorker = new pluginWindow.Worker("asset://localhost/plugins/sample/worker.js?mode=1", classicOptions);
assert.equal(classicWorker.options, classicOptions, "classic local Worker should preserve the caller's options object");
assert.equal(classicWorker.url, "blob:worker-fixture-0", "classic local Worker should keep its Blob bootstrap URL");
assert.match(workerFixture.createdBlobs[0].parts[0], /importScripts\("asset:\/\/localhost\/plugins\/sample\/worker\.js\?mode=1"\)/,
  "classic Worker bootstrap should import the parsed plugin resource URL");
assert.equal(pluginWindow.Worker.prototype, workerFixture.NativeWorkerStub.prototype,
  "wrapped Worker should preserve the native prototype");
classicWorker.terminate();
assert.equal(classicWorker.terminated, true, "wrapped terminate should delegate to native Worker");
assert.deepEqual(workerFixture.revokedWorkerUrls, ["blob:worker-fixture-0"],
  "terminate should release the bootstrap Blob URL");

const workerBeforeError = new pluginWindow.Worker("tauri://localhost/plugins/sample/error-worker.js");
workerBeforeError.dispatch("error");
assert.deepEqual(workerFixture.revokedWorkerUrls, ["blob:worker-fixture-0", "blob:worker-fixture-1"],
  "Worker error should release its bootstrap Blob URL");
workerBeforeError.terminate();
assert.equal(workerFixture.revokedWorkerUrls.length, 2, "later terminate should not revoke an errored worker URL twice");

const moduleOptions = { type: "module", name: "module worker" };
const moduleWorker = new pluginWindow.Worker("asset://localhost/plugins/sample/module-worker.js", moduleOptions);
assert.equal(moduleWorker.url, "asset://localhost/plugins/sample/module-worker.js",
  "module Worker should retain native URL handling under worker-src CSP");
assert.equal(moduleWorker.options, moduleOptions, "module Worker should preserve native options");
const externalWorker = new pluginWindow.Worker("https://other.example/worker.js", classicOptions);
assert.equal(externalWorker.url, "https://other.example/worker.js", "external Worker should retain native URL handling");
assert.equal(externalWorker.options, classicOptions);

workerFixture.failWorkerConstruction(true);
assert.throws(() => new pluginWindow.Worker("asset://localhost/plugins/sample/throw-worker.js"), /worker construction failed/);
workerFixture.failWorkerConstruction(false);
assert.equal(workerFixture.revokedWorkerUrls.at(-1), "blob:worker-fixture-2",
  "failed native construction should release its unused Blob URL");

await assert.rejects(pluginWindow.navigator.serviceWorker.register("https://private.example/sw.js"), (error) => {
  assert.equal(error.name, "NotSupportedError");
  assert.equal(error.code, "ERR_ATOOLS_SERVICE_WORKER_UNSUPPORTED");
  assert.doesNotMatch(error.message, /private\.example|sw\.js/, "unsupported diagnostics should not disclose the URL");
  return true;
});
assert.deepEqual(await pluginWindow.navigator.serviceWorker.getRegistrations(), ["native-registration-query"],
  "ServiceWorkerContainer query methods should preserve native behavior");
const controllerChangeHandler = () => {};
pluginWindow.navigator.serviceWorker.oncontrollerchange = controllerChangeHandler;
assert.equal(serviceWorkerFixture.setterReceiver, serviceWorkerFixture.nativeServiceWorker,
  "ServiceWorkerContainer setters should receive the native branded container");
assert.equal(serviceWorkerFixture.nativeServiceWorker.oncontrollerchange, controllerChangeHandler,
  "controllerchange handler should be assigned to the native container");

const opaqueWindow = {
  ...events(),
  Worker: workerFixture.NativeWorkerStub,
  URL: workerFixture.WorkerUrlStub,
  Blob: workerFixture.WorkerBlobStub,
  document,
  location: { host: "plugin.local" },
  get navigator() { throw new DOMException("ServiceWorker is unavailable for opaque origins", "SecurityError"); },
};
vm.runInNewContext(`(${factorySource})(window);`, { window: opaqueWindow });
assert.equal(opaqueWindow.__atoolsNativeWorker, workerFixture.NativeWorkerStub,
  "opaque navigator.serviceWorker getter errors should not stop Worker wrapping");
assert.throws(() => opaqueWindow.navigator, { name: "SecurityError" }, "opaque navigator getter should remain untouched");
const opaqueWorker = new opaqueWindow.Worker("asset://localhost/plugins/sample/opaque-worker.js");
assert.equal(opaqueWorker.url, "blob:worker-fixture-3", "Worker bridge should remain active when Service Worker access throws");

const leased = new pluginWindow.Worker("atools-plugin://localhost/4ab79ff7-d8bb-4a4e-a506-81e94bc7ebf4/json.worker.js", { name: "json" });
assert.match(workerFixture.createdBlobs.at(-1).parts[0], /^importScripts\("atools-plugin:\/\/localhost\//);
const windowsLeased = new pluginWindow.Worker("http://atools-plugin.localhost/4ab79ff7-d8bb-4a4e-a506-81e94bc7ebf4/json.worker.js");
assert.match(workerFixture.createdBlobs.at(-1).parts[0], /^importScripts\("http:\/\/atools-plugin\.localhost\//);
assert.throws(() => pluginWindow.Worker("worker.js"), /requires new/);
const owned = [moduleWorker, externalWorker, leased, windowsLeased];
while (owned.length < 8) owned.push(new pluginWindow.Worker("blob:existing-plugin-worker"));
assert.throws(() => new pluginWindow.Worker("worker.js"), error => error.name === "QuotaExceededError");
owned[0].terminate();
const replacement = new pluginWindow.Worker("worker.js");
replacement.terminate = () => { throw Error("plugin replaced terminate"); };
windowEvents.dispatch("atools-plugin-out");
assert.ok([...owned, replacement].every(worker => worker.terminated), "plugin exit explicitly terminates every owned Worker");
assert.throws(() => new pluginWindow.Worker("worker.js"), error => error.name === "InvalidStateError");
windowEvents.dispatch("pagehide");
const revokedCount = workerFixture.revokedWorkerUrls.length;
classicWorker.terminate();
assert.equal(workerFixture.revokedWorkerUrls.length, revokedCount, "teardown and later terminate revoke URLs once");
const pageEvents = events();
const pageWindow = { ...pluginWindow, ...pageEvents, Worker: workerFixture.NativeWorkerStub, __atoolsNativeWorker: undefined };
vm.runInNewContext(`(${factorySource})(window);`, { window: pageWindow });
const pageWorker = new pageWindow.Worker("blob:caller-created");
class PluginWorkerSubclass extends pageWindow.Worker {
  terminate() { throw Error("subclass must not block host cleanup"); }
}
const subclass = new PluginWorkerSubclass("blob:subclass");
assert.ok(subclass instanceof PluginWorkerSubclass);
assert.ok(subclass instanceof workerFixture.NativeWorkerStub);
workerFixture.WorkerUrlStub.revokeObjectURL = () => { throw Error("plugin overwrote URL cleanup"); };
const localPageWorker = new pageWindow.Worker("asset://localhost/plugins/sample/worker.js");
pageEvents.dispatch("pagehide");
assert.equal(pageWorker.terminated, true, "pagehide explicitly terminates a caller-created Blob worker too");
assert.equal(subclass.terminated, true);
assert.equal(localPageWorker.terminated, true);
assert.throws(() => new pageWindow.Worker("worker.js"), error => error.name === "InvalidStateError");

const unavailableWindow = {
  Worker: undefined,
  navigator: {},
};
vm.runInNewContext(`(${factorySource})(window);`, { window: unavailableWindow });
assert.equal("serviceWorker" in unavailableWindow.navigator, false,
  "factory should not invent a ServiceWorkerContainer when the browser does not provide one");

const scope = "12345678-1234-4abc-8abc-123456789abc";
const otherScope = "87654321-4321-4abc-8abc-123456789abc";
const requestId = "abcdefff-1234-4abc-8abc-123456789abc";
const shutdownRequest = (scopeId = scope, request = requestId) => ({ __atools_worker_shutdown__: true,
  requestId: request, scopeId });
function shutdownFixture({ hasWorker = true, ownsWorker = true, scopeId = scope, failsTermination = false } = {}) {
  const fixture = createPluginWorkerFixture(), frameEvents = events(), sent = [], sequence = [];
  const hooks = {};
  class NativeWorker extends fixture.NativeWorkerStub {
    constructor(url, options) { super(url, options); hooks.constructed?.(this); }
    terminate() {
      this.terminationCalls = (this.terminationCalls || 0) + 1;
      if (this.failTermination) throw Error("synthetic native termination failure");
      super.terminate();
    }
  }
  const parent = { postMessage: message => { sequence.push("ack"); sent.push(message); } };
  const frame = { ...frameEvents, Worker: hasWorker ? NativeWorker : undefined, URL: fixture.WorkerUrlStub,
    Blob: fixture.WorkerBlobStub, document, location: { host: "plugin.local" }, navigator: {}, parent };
  vm.runInNewContext(`(${factorySource})(window, scopeId);`, { window: frame, scopeId, Event });
  frameEvents.addEventListener("atools-workers-disposed", () => sequence.push("disposed"));
  const worker = hasWorker && ownsWorker ? new frame.Worker("blob:scope-owned") : undefined;
  if (worker) worker.failTermination = failsTermination;
  const receive = (data, source = parent) => frameEvents.dispatch("message", { data, source });
  return { frame, frameEvents, sent, sequence, worker, parent, receive, fixture, hooks };
}

const shutdown = shutdownFixture();
shutdown.receive(shutdownRequest(), {});
shutdown.receive(shutdownRequest(otherScope));
shutdown.receive(shutdownRequest(scope, "not-a-uuid"));
shutdown.receive({ ...shutdownRequest(), __atools_worker_shutdown__: false });
assert.equal(shutdown.sent.length, 0, "foreign source, old scope and malformed request cannot trigger shutdown");
assert.equal(shutdown.worker.terminated, false);
shutdown.receive(shutdownRequest());
assert.equal(shutdown.worker.terminated, true);
assert.deepEqual(shutdown.sequence, ["disposed", "ack"], "disposal observation is dispatched before ACK");
assert.deepEqual(JSON.parse(JSON.stringify(shutdown.sent[0])), { __atools_worker_shutdown_ack__: true,
  requestId, scopeId: scope, remaining: 0 });
assert.throws(() => new shutdown.frame.Worker("blob:after-shutdown"), error => error.name === "InvalidStateError");
shutdown.receive(shutdownRequest());
assert.equal(shutdown.sent.length, 2, "duplicate matching-scope requests still receive ACK");
assert.equal(shutdown.worker.terminationCalls, 1, "idempotent ACK does not repeat a successful native terminate");
assert.equal(shutdown.sent[1].remaining, 0);
assert.equal(shutdown.frameEvents.listenerCount(), 2, "only the persistent shutdown listener and fixture observer remain");

const failedShutdown = shutdownFixture({ failsTermination: true });
const healthy = new failedShutdown.frame.Worker("blob:another-owned");
failedShutdown.receive(shutdownRequest());
assert.equal(failedShutdown.worker.terminated, false);
assert.equal(healthy.terminated, true, "one failed native termination does not block the other owned workers");
assert.equal(failedShutdown.sent[0].remaining, 1, "failed native termination cannot be reported as successful cleanup");
failedShutdown.worker.failTermination = false;
failedShutdown.receive(shutdownRequest());
assert.equal(failedShutdown.worker.terminated, true);
assert.equal(failedShutdown.sent[1].remaining, 0, "a duplicate request can retry remaining native terminations");

const nextDocument = shutdownFixture({ scopeId: otherScope });
nextDocument.receive(shutdownRequest(scope));
assert.equal(nextDocument.worker.terminated, false, "a delayed request from an older document cannot close the new scope");
assert.equal(nextDocument.sent.length, 0);
nextDocument.receive(shutdownRequest(otherScope));
assert.equal(nextDocument.worker.terminated, true);
assert.equal(nextDocument.sent[0].scopeId, otherScope);
shutdown.receive({ __atools_worker_shutdown_ack__: true, requestId, scopeId: scope, remaining: 0 });
assert.equal(shutdown.sent.length, 2, "ACK-shaped messages do not trigger another ACK");

const unsupported = shutdownFixture({ hasWorker: false });
unsupported.receive(shutdownRequest());
assert.equal(unsupported.sent[0].remaining, 0, "a document without Worker support can acknowledge its empty scope");
const empty = shutdownFixture({ ownsWorker: false });
empty.receive(shutdownRequest());
assert.equal(empty.sent[0].remaining, 0, "an available but unused Worker API has an empty scope too");
const invalidScope = shutdownFixture({ scopeId: "not-a-scope" });
invalidScope.receive(shutdownRequest());
assert.equal(invalidScope.sent.length, 0, "invalid injected scopes do not install a shutdown endpoint");
const duplicateBridge = shutdownFixture();
vm.runInNewContext(`(${factorySource})(window, scopeId);`, { window: duplicateBridge.frame, scopeId: otherScope, Event });
duplicateBridge.receive(shutdownRequest(otherScope));
assert.equal(duplicateBridge.sent.length, 0, "a repeated factory must not ACK from a new empty ownership map");
assert.equal(duplicateBridge.worker.terminated, false);
duplicateBridge.receive(shutdownRequest());
assert.equal(duplicateBridge.worker.terminated, true, "the originally installed scope retains its real Worker ownership");

for (const entryPoint of ["coercion", "options", "native"]) {
  const nested = shutdownFixture({ ownsWorker: false });
  let entered = false, denied = 0;
  const fillSlots = () => {
    if (entered) return;
    entered = true;
    for (let index = 0; index < 8; index++) {
      try { new nested.frame.Worker("blob:nested-" + index); }
      catch (error) { assert.equal(error.name, "QuotaExceededError"); denied++; }
    }
  };
  let url = "asset://localhost/plugins/sample/outer.js", options;
  if (entryPoint === "coercion") url = { toString() { fillSlots(); return "blob:coerced"; } };
  if (entryPoint === "options") options = { get type() { fillSlots(); return "classic"; } };
  if (entryPoint === "native") nested.hooks.constructed = fillSlots;
  new nested.frame.Worker(url, options);
  assert.equal(denied, 1, `${entryPoint} reentrancy accounts for the outer reservation`);
  assert.equal(nested.fixture.createdWorkers.length, 8, `${entryPoint} cannot construct a ninth Worker`);
  assert.throws(() => new nested.frame.Worker("blob:ninth"), error => error.name === "QuotaExceededError");
  nested.receive(shutdownRequest());
  assert.equal(nested.sent[0].remaining, 0);
  assert(nested.fixture.createdWorkers.every(worker => worker.terminated));
}

for (const nativeFailure of [false, true]) {
  const closing = shutdownFixture({ ownsWorker: false });
  closing.hooks.constructed = worker => {
    worker.failTermination = nativeFailure;
    closing.receive(shutdownRequest());
  };
  assert.throws(() => new closing.frame.Worker("blob:closing-during-native"),
    error => nativeFailure ? /native termination failure/.test(error.message) : error.name === "InvalidStateError");
  assert.equal(closing.sent[0].remaining, 1, "a construction in progress cannot ACK a false zero");
  assert.equal(closing.fixture.createdWorkers[0].terminated, !nativeFailure);
  closing.hooks.constructed = undefined;
  closing.receive(shutdownRequest());
  assert.equal(closing.sent[1].remaining, nativeFailure ? 1 : 0,
    "a failed post-close native termination stays owned after the constructor exits");
  if (nativeFailure) {
    closing.fixture.createdWorkers[0].failTermination = false;
    closing.receive(shutdownRequest());
    assert.equal(closing.sent[2].remaining, 0);
  }
}

const failedReservation = shutdownFixture({ ownsWorker: false });
assert.throws(() => new failedReservation.frame.Worker({ toString() { throw Error("coercion failed"); } }), /coercion failed/);
failedReservation.fixture.failWorkerConstruction(true);
assert.throws(() => new failedReservation.frame.Worker("blob:native-failure"), /worker construction failed/);
failedReservation.fixture.failWorkerConstruction(false);
for (let index = 0; index < 8; index++) new failedReservation.frame.Worker("blob:after-failed-reservation-" + index);
assert.equal(failedReservation.fixture.createdWorkers.length, 8, "failed coercion/native construction releases its reservation");
failedReservation.receive(shutdownRequest());
assert.equal(failedReservation.sent[0].remaining, 0);

const nativeListenerScope = shutdownFixture({ ownsWorker: false });
let subclassListenerCalls = 0;
class CustomListenerWorker extends nativeListenerScope.frame.Worker {
  addEventListener() { subclassListenerCalls++; throw Error("subclass listener must not orphan a constructed Worker"); }
}
for (let index = 0; index < 8; index++) new CustomListenerWorker("asset://localhost/plugins/sample/listener-" + index + ".js");
assert.equal(subclassListenerCalls, 0, "host resource cleanup attaches through the captured native listener API");
assert.equal(nativeListenerScope.fixture.createdWorkers.length, 8);
assert.throws(() => new CustomListenerWorker("blob:ninth-listener"), error => error.name === "QuotaExceededError");
nativeListenerScope.receive(shutdownRequest());
assert.equal(nativeListenerScope.sent[0].remaining, 0);
assert(nativeListenerScope.fixture.createdWorkers.every(worker => worker.terminated));

const setterCloseScope = shutdownFixture({ ownsWorker: false });
class ClosingSetterWorker extends setterCloseScope.frame.Worker {
  set terminate(_value) { setterCloseScope.receive(shutdownRequest()); }
}
assert.throws(() => new ClosingSetterWorker("blob:setter-shutdown"), error => error.name === "InvalidStateError");
assert.equal(setterCloseScope.sent[0].remaining, 0, "registered ownership replaces its construction slot before the setter can dispose it");
assert.equal(setterCloseScope.fixture.createdWorkers[0].terminated, true);
assert.equal(setterCloseScope.fixture.createdWorkers[0].terminationCalls, 1);
setterCloseScope.receive(shutdownRequest());
assert.equal(setterCloseScope.sent[1].remaining, 0);
