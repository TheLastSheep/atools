import { loadProductionPluginBridgeTemplate, readLauncherOwnerSource, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const root = new URL("../", import.meta.url);
const bridgePermissionSource = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/frame-permissions.ts");
const bridgeNativeCallSource = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/native-call-and-node-shims.ts");
const bridgeResponseSource = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/child-window-rpc.ts");
const permissionBodySource = await readPanelHostSource(root, "src/components/PluginPanelBody.svelte");
const permissionControllerSource = await readPanelHostSource(root, "src/lib/pluginPanelPermissionController.ts");
const panelSource = await readPanelHostSource(root, "src/components/PluginPanel.svelte");
const sessionLifecycleSource = await readPanelHostSource(root, "src/lib/pluginPanelSessionLifecycle.ts");
const bridgeCompilerSource = await readPanelHostSource(root, "src/lib/pluginPanelBridgeCompiler.ts");
const permissionStoreSource = await readFile(new URL("src/lib/pluginRuntimePermissions.ts", root), "utf8");
const entryControllerSource = await readFile(new URL("src/lib/pluginPanelEntryController.ts", root), "utf8");
const smokeActionSource = await readLauncherOwnerSource(root, "src/lib/pluginHostSmokeAction.ts");
const typesSource = await readFile(new URL("src/lib/types.ts", root), "utf8");
const permissionQueueSource = await readFile(new URL("src/lib/pluginFramePermissionQueue.ts", root), "utf8");
const identitySource = await readFile(new URL("src/lib/pluginFrameDocumentIdentity.ts", root), "utf8");
const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);

assert.match(typesSource, /plugin_permissions\??:\s*string\[\]/, "FeatureAction should carry manifest plugin_permissions to the runtime host");
assert.match(bridgePermissionSource, /var _atoolsPluginPermissions = null;/, "Bridge should define a legacy-null permissions slot");
assert.match(bridgePermissionSource, /function _requirePluginPermission/, "Bridge should centralize plugin permission checks");
assert.match(bridgePermissionSource, /function _requestPluginPermission/, "Bridge should ask the host before denied runtime permissions");
assert.match(bridgePermissionSource, /__atools_permission_request__/, "Bridge should send runtime permission requests to the host");
assert.match(bridgeResponseSource, /__atools_permission_response__/, "Bridge should receive runtime permission responses from the host");
assert.match(bridgeCompilerSource, /action\.plugin_permissions\s*\?\?\s*\[\]/, "Bridge compiler should inject the manifest permissions instead of the legacy-null default");
assert.match(bridgeNativeCallSource, /function _pluginClipboardCopyPermission\(\)/, "Synchronous clipboard writes should consult the runtime permission gate");
assert.match(permissionBodySource, /plugin-permission-dialog/, "PluginPanel should render an in-host runtime permission prompt");
assert.match(permissionBodySource, /本次会话允许/, "Runtime permission prompt should expose a session approval action");
assert.match(permissionBodySource, /始终允许/, "Runtime permission prompt should expose a persistent approval action");
assert.match(permissionControllerSource, /grantPersistent\(pluginId, permission\)/, "Persistent runtime approvals should be saved for the plugin");
assert.match(panelSource, /createPluginPanelEntryController/, "PluginPanel should use the extracted entry reset controller");
assert.match(panelSource, /loadPersistentPermissions:\s*pluginRuntimePermissionGrantList/, "PluginPanel should connect the entry controller to the production grant store");
assert.match(panelSource, /panelEntryController\.observe\(next\)/, "PluginPanel action changes should reset through the entry controller");
assert.match(panelSource, /panelEntryController\.activate\(next\)/, "Persistent entry activation should force a permission reload");
assert.match(entryControllerSource, /ports\.setPersistentPermissions\(ports\.loadPersistentPermissions\(action\.plugin_id\)\)/,
  "The production entry reset should load grants using the action's plugin identity");
assert.match(permissionStoreSource, /PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT/, "Runtime grants should notify settings and the active plugin panel");
assert.match(sessionLifecycleSource, /ports\.setPersistentPermissions\(ports\.permissionGrants\(ports\.action\(\)\.plugin_id\)\)/,
  "The extracted lifecycle should refresh grants for the currently active plugin when the update event fires");
assert.match(panelSource, /persistentGrantsUpdatedEvent:\s*PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT/,
  "PluginPanel should connect the grant update event to its extracted lifecycle");
assert.match(panelSource, /permissionGrants:\s*pluginRuntimePermissionGrantList/,
  "PluginPanel should connect lifecycle grant refreshes to the production grant store");
assert.match(permissionControllerSource, /createPluginFramePermissionQueue/, "Panel permission controller delegates replies to the captured document queue");
assert.match(permissionQueueSource, /options\.sources\.reply\(request\.source, request\.identity/, "Permission replies retain captured source and identity");
assert.match(identitySource, /try\s*{\s*target\.postMessage[\s\S]*catch\s*{\s*return false;/, "Document replies tolerate postMessage failures");
assert.match(smokeActionSource, /pluginHostSmoke\s*===\s*"permissionPrompt"/, "Web preview smoke should expose a runtime permission prompt scenario");
assert.match(smokeActionSource, /plugin_permissions:\s*permissionPromptSmoke\s*\?\s*\[\]\s*:/, "Runtime permission prompt smoke should start with no manifest permissions");
assert.match(smokeActionSource, /copyText\('permission prompt smoke'\)/, "Runtime permission prompt smoke should request clipboard.write through copyText");
assert.match(smokeActionSource, /iframeContextSmoke\s*\|\|\s*browserWindowSmoke\s*\|\|\s*permissionPromptSmoke\s*\?\s*\[\]\s*:/, "Runtime permission prompt smoke should render the iframe runtime instead of output rows");

const hostClipboardEndpoint = "http://127.0.0.1:43123/host/" + "a".repeat(64);
const hostClipboardScript = await loadProductionHostClipboardScript({
  instanceId: "runtime-permission-host-fixture",
  endpoints: { write: hostClipboardEndpoint },
});
const hostClipboardScriptBody = hostClipboardScript.match(/^<script[^>]*>([\s\S]*)<\/script>$/)?.[1];
assert.ok(hostClipboardScriptBody, "production HostClipboard factory should generate an executable script");

function moduleDataUrl(source) {
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}

function transpileSource(source, fileName) {
  return transpileModule(source, {
    fileName,
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
  }).outputText;
}

async function importProductionModule(relativePath, dependencies = []) {
  const url = new URL(relativePath, root);
  let source = transpileSource(await readFile(url, "utf8"), url.pathname);
  for (const [specifier, dependencyUrl] of dependencies) {
    const importStatement = `from ${JSON.stringify(specifier)}`;
    assert.ok(source.includes(importStatement), `production module dependency should remain explicit: ${relativePath} -> ${specifier}`);
    source = source.replaceAll(importStatement, `from ${JSON.stringify(dependencyUrl)}`);
  }
  return import(moduleDataUrl(source));
}

async function loadProductionHostClipboardScript(config) {
  const imageModuleUrl = moduleDataUrl(transpileSource(
    await readFile(new URL("src/lib/pluginNativeImage.ts", root), "utf8"),
    new URL("src/lib/pluginNativeImage.ts", root).pathname,
  ));
  const historyModuleUrl = moduleDataUrl(transpileSource(
    await readFile(new URL("src/lib/hostClipboardHistory.ts", root), "utf8"),
    new URL("src/lib/hostClipboardHistory.ts", root).pathname,
  ));
  const module = await importProductionModule("src/lib/hostClipboardBridge.ts", [
    ["./pluginNativeImage", imageModuleUrl], ["./hostClipboardHistory", historyModuleUrl],
  ]);
  assert.equal(typeof module.hostClipboardBridgeScript, "function", "production HostClipboard script factory should be exported");
  return module.hostClipboardBridgeScript(config);
}

async function verifyProductionPanelGrantLifecycle() {
  const subInputUrl = new URL("src/lib/pluginSubInputState.ts", root);
  const subInputModuleUrl = moduleDataUrl(transpileSource(await readFile(subInputUrl, "utf8"), subInputUrl.pathname));
  const [entryController, permissionStore, sessionLifecycle] = await Promise.all([
    importProductionModule("src/lib/pluginPanelEntryController.ts", [
      ["./pluginSubInputState", subInputModuleUrl],
    ]),
    importProductionModule("src/lib/pluginRuntimePermissions.ts"),
    importProductionModule("src/lib/pluginPanelSessionLifecycle.ts"),
  ]);
  assert.equal(typeof entryController.createPluginPanelEntryController, "function", "production entry reset controller should be executable");
  assert.equal(typeof sessionLifecycle.createPluginPanelSessionLifecycle, "function", "production panel lifecycle should be executable");

  const previousGlobals = { window: globalThis.window, localStorage: globalThis.localStorage, CustomEvent: globalThis.CustomEvent };
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const listeners = new Map();
  const testWindow = {
    addEventListener(type, listener) {
      const group = listeners.get(type) ?? new Set();
      group.add(listener); listeners.set(type, group);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
  };
  globalThis.window = testWindow;
  globalThis.localStorage = storage;
  globalThis.CustomEvent = class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };

  try {
    assert.equal(permissionStore.grantPluginRuntimePermission("grant-plugin-a", "clipboard.write"), true);
    assert.equal(permissionStore.grantPluginRuntimePermission("grant-plugin-b", "shell.openExternal"), true);
    const state = {
      subInput: { sequence: 4, generation: 2, epoch: 9 }, persistent: [], approved: ["stale"],
      dynamic: ["stale"], tools: ["stale"], items: ["stale"], selected: 3, featureList: { stale: true },
      requestedHeight: 40, outDispatched: true, detachDispatched: true, contextMenuCleared: 0,
      lastBrowserMessage: "stale", probe: "stale", permissionRequestsCleared: 0,
    };
    const loads = [];
    const panelEntry = entryController.createPluginPanelEntryController({
      subInput: () => state.subInput, setSubInput: value => { state.subInput = value; },
      dynamicFeatures: () => state.dynamic, setDynamicFeatures: value => { state.dynamic = value; },
      registeredTools: () => state.tools, setRegisteredTools: value => { state.tools = value; },
      setRequestedHeight: value => { state.requestedHeight = value; }, setOutDispatched: value => { state.outDispatched = value; },
      setDetachDispatched: value => { state.detachDispatched = value; }, clearContextMenu: () => { state.contextMenuCleared += 1; },
      setLastBrowserWindowMessage: value => { state.lastBrowserMessage = value; }, setProbeResult: value => { state.probe = value; },
      clearPermissionRequests: () => { state.permissionRequestsCleared += 1; },
      setApprovedPermissions: value => { state.approved = value; }, setPersistentPermissions: value => { state.persistent = value; },
      loadPersistentPermissions: pluginId => {
        loads.push(pluginId);
        return permissionStore.pluginRuntimePermissionGrantList(pluginId);
      },
      setPluginItems: value => { state.items = value; }, setSelectedIndex: value => { state.selected = value; },
      setFeatureList: value => { state.featureList = value; },
      emptyFeatureList: featureList => ({ mode: "empty", generation: featureList }), generation: () => 12,
    });
    const action = (plugin_id, feature_code = "entry") => ({ plugin_id, feature_code });
    assert.equal(panelEntry.observe(action("grant-plugin-a")), true);
    assert.deepEqual(state.persistent, ["clipboard.write"], "entry reset should load only plugin A's saved permissions");
    assert.deepEqual(state.approved, [], "entry reset should clear previous session-only approvals");
    assert.equal(state.requestedHeight, 0, "entry reset should clear the previous plugin's requested height");
    assert.equal(panelEntry.observe(action("grant-plugin-a")), false, "observing the same entry should avoid redundant reloads");
    assert.deepEqual(loads, ["grant-plugin-a"], "same-entry observation should not reload grants");
    assert.equal(panelEntry.observe(action("grant-plugin-b")), true);
    assert.deepEqual(state.persistent, ["shell.openExternal"], "switching entries should load plugin B's isolated grant list");
    assert.equal(panelEntry.activate(action("grant-plugin-b")), true);
    assert.deepEqual(loads, ["grant-plugin-a", "grant-plugin-b", "grant-plugin-b"], "forced activation should reload the active plugin's grants");

    let activeAction = action("grant-plugin-a");
    panelEntry.observe(activeAction);
    const lifecycle = sessionLifecycle.createPluginPanelSessionLifecycle({
      action: () => activeAction,
      persistentGrantsUpdatedEvent: permissionStore.PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT,
      permissionGrants: permissionStore.pluginRuntimePermissionGrantList,
      setPersistentPermissions: value => { state.persistent = value; },
      handlePanelKeydown() {},
    });
    state.persistent = permissionStore.pluginRuntimePermissionGrantList(activeAction.plugin_id);
    const unmount = lifecycle.mount();
    assert.equal(permissionStore.grantPluginRuntimePermission("grant-plugin-b", "data"), true);
    assert.deepEqual(state.persistent, ["clipboard.write"], "another plugin's update event must not leak its permissions into active plugin A");
    assert.equal(permissionStore.grantPluginRuntimePermission("grant-plugin-a", "shell.openExternal"), true);
    assert.deepEqual(state.persistent, ["clipboard.write", "shell.openExternal"], "active plugin A should reload grants after the update event");
    activeAction = action("grant-plugin-b");
    panelEntry.observe(activeAction);
    assert.deepEqual(state.persistent, ["shell.openExternal", "data"], "switching to plugin B should load B's complete saved grants");
    assert.equal(permissionStore.grantPluginRuntimePermission("grant-plugin-a", "screen.capture"), true);
    assert.deepEqual(state.persistent, ["shell.openExternal", "data"], "plugin A's update should leave active plugin B isolated");
    assert.equal(permissionStore.grantPluginRuntimePermission("grant-plugin-b", "clipboard.write"), true);
    assert.deepEqual(state.persistent, ["shell.openExternal", "data", "clipboard.write"], "active plugin B should reload after its own update event");
    unmount();
    assert.equal(listeners.get(permissionStore.PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT)?.size ?? 0, 0,
      "unmount should remove the persistent-grant update listener");
  } finally {
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

await verifyProductionPanelGrantLifecycle();

function bridgeSourceFor(permissions) {
  return bridgeTemplate
    .replace(/<\\\/script>/g, "</script>")
    .replace(/^\s*<script>\s*/, "")
    .replace(/\s*<\/script>\s*$/, "")
    .replace(/__PLUGIN_ID__/g, JSON.stringify("runtime-permission-test-plugin"))
    .replace(/__FEATURE_CODE__/g, JSON.stringify("runtime-permission-test-feature"))
    .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
    .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
    .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"))
    .replace("var _atoolsPluginPermissions = null;", `var _atoolsPluginPermissions = ${JSON.stringify(permissions)};`);
}

function createBridgeRuntime(permissions, hostClipboardStatus = 200) {
  const listeners = new Map();
  const postedMessages = [];
  const synchronousWrites = [];
  const windowStub = {
    parent: {
      postMessage(message) {
        postedMessages.push(message);
      },
    },
    top: {},
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    addEventListener(type, cb) {
      const list = listeners.get(type) || [];
      list.push(cb);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      const list = listeners.get(event.type) || [];
      list.forEach((cb) => cb(event));
    },
    matchMedia() {
      return { matches: false };
    },
  };
  const documentStub = {
    readyState: "complete",
    addEventListener(type, cb) {
      const list = listeners.get(`document:${type}`) || [];
      list.push(cb);
      listeners.set(`document:${type}`, list);
    },
  };
  class EventStub {
    constructor(type) {
      this.type = type;
    }
  }
  class CustomEventStub extends EventStub {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  }
  class XMLHttpRequestStub {
    open(method, endpoint, async = true) {
      this.method = method;
      this.endpoint = endpoint;
      this.async = async;
    }
    setRequestHeader() {}
    send(rawBody) {
      synchronousWrites.push({ method: this.method, endpoint: this.endpoint, async: this.async,
        body: JSON.parse(rawBody), status: hostClipboardStatus });
      this.status = hostClipboardStatus;
      this.responseText = JSON.stringify(hostClipboardStatus === 200
        ? { ok: true, result: null }
        : { ok: false, error: { message: "controlled clipboard host failure" } });
    }
  }

  const context = vm.createContext({
    window: windowStub,
    parent: windowStub.parent,
    addEventListener: windowStub.addEventListener.bind(windowStub),
    document: documentStub,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0" },
    Event: EventStub,
    CustomEvent: CustomEventStub,
    console: { error() {}, warn() {}, log() {} },
    Date,
    Math,
    Number,
    Promise,
    TextEncoder,
    XMLHttpRequest: XMLHttpRequestStub,
    decodeURIComponent,
    encodeURIComponent,
    setTimeout(cb) {
      cb();
      return 1;
    },
    clearTimeout() {},
  });

  vm.runInContext(bridgeSourceFor(permissions), context, { filename: "UTOOLS_BRIDGE.permissions.vm.js" });
  vm.runInContext(hostClipboardScriptBody, context, { filename: "HostClipboard.production.vm.js" });
  return {
    windowStub,
    postedMessages,
    synchronousWrites,
    sendMessage(data) {
      const list = listeners.get("message") || [];
      list.forEach((cb) => cb({ data }));
    },
  };
}

async function stateOf(promise) {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error) => `rejected:${error && typeof error.message === "string" ? error.message : String(error)}`,
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
}

const denied = createBridgeRuntime([]);
const deniedShellCall = denied.windowStub.utools.shellOpenExternal("https://example.com");
assert.equal(await stateOf(deniedShellCall), "pending", "missing shellOpenExternal permission should wait for a user decision");
const deniedShellRequest = denied.postedMessages.find((message) => message.__atools_permission_request__);
assert.deepEqual(
  [deniedShellRequest?.permission, deniedShellRequest?.pluginId, deniedShellRequest?.featureCode],
  ["shell.openExternal", "runtime-permission-test-plugin", "runtime-permission-test-feature"],
  "missing shellOpenExternal permission should request a runtime approval from the host",
);
assert.equal(
  denied.postedMessages.some((message) => message.__ipc_call__ || message.__atools_native_call__),
  false,
  "runtime permission prompts must not touch host commands before a decision",
);
denied.sendMessage({
  __atools_permission_response__: true,
  reqId: deniedShellRequest.reqId,
  permission: "shell.openExternal",
  allowed: false,
});
assert.equal(
  await stateOf(deniedShellCall),
  "rejected:Plugin permission denied: shell.openExternal",
  "denied runtime shellOpenExternal permission should reject the original bridge call",
);
assert.equal(
  denied.postedMessages.some((message) => message.__ipc_call__ && message.cmd === "shell_open"),
  false,
  "denied runtime shellOpenExternal permission must not reach shell_open",
);

const deniedCopy = createBridgeRuntime([]);
assert.equal(deniedCopy.windowStub.utools.copyText("secret"), false, "copyText should fail closed while clipboard.write is unapproved");
const deniedCopyRequest = deniedCopy.postedMessages.find((message) => message.__atools_permission_request__);
assert.ok(deniedCopyRequest, "copyText should request the missing clipboard.write permission");
deniedCopy.sendMessage({ __atools_permission_response__: true, reqId: deniedCopyRequest.reqId,
  permission: "clipboard.write", allowed: false });
await Promise.resolve();
assert.equal(deniedCopy.windowStub.utools.copyText("secret retry"), false,
  "a denied runtime permission must not be bypassed by retrying the public API");
assert.equal(deniedCopy.synchronousWrites.length, 0, "denied clipboard writes must never reach the HostClipboard endpoint");
assert.equal(deniedCopy.postedMessages.some((message) => message.__ipc_call__ || message.__atools_native_call__), false,
  "denied clipboard writes must not fall back to asynchronous IPC");
const secondDenial = deniedCopy.postedMessages.filter(message => message.__atools_permission_request__).at(-1);
deniedCopy.sendMessage({ __atools_permission_response__: true, reqId: secondDenial.reqId,
  permission: "clipboard.write", allowed: false });

const approved = createBridgeRuntime([]);
const initialCopyAttempt = approved.windowStub.utools.copyText("not replayed after approval");
assert.equal(typeof initialCopyAttempt, "boolean", "copyText should remain a synchronous legacy boolean");
assert.equal(initialCopyAttempt, false, "copyText without clipboard.write permission should fail closed immediately");
const approvedCopyRequest = approved.postedMessages.find((message) => message.__atools_permission_request__);
assert.equal(approvedCopyRequest?.permission, "clipboard.write", "missing copyText permission should request clipboard.write");
assert.equal(approved.synchronousWrites.length, 0, "a denied first attempt must not reach HostClipboard before permission approval");
assert.equal(approved.postedMessages.some((message) => message.__ipc_call__ || message.__atools_native_call__), false,
  "a missing permission must not bypass the explicit runtime permission prompt");
approved.sendMessage({
  __atools_permission_response__: true,
  reqId: approvedCopyRequest.reqId,
  permission: "clipboard.write",
  allowed: true,
});
await Promise.resolve();
assert.equal(approved.synchronousWrites.length, 0, "permission approval must not replay the rejected copy attempt");
const approvedRetry = approved.windowStub.utools.copyText("explicit retry after approval");
assert.equal(approvedRetry, true, "an explicit retry after approval should return synchronous host success");
assert.deepEqual(approved.synchronousWrites, [{ method: "POST", endpoint: hostClipboardEndpoint, async: false,
  body: { text: "explicit retry after approval" }, status: 200 }],
"copyText retry should use the production HostClipboard factory and synchronous transport");
assert.equal(approved.postedMessages.some((message) => message.__ipc_call__ || message.__atools_native_call__), false,
  "clipboard writes should not fall back to asynchronous bridge IPC");
approved.windowStub.utools.copyText("second");
assert.equal(
  approved.postedMessages.filter((message) => message.__atools_permission_request__ && message.permission === "clipboard.write").length,
  1,
  "session-approved runtime permission should not prompt again for the same API",
);
assert.equal(approved.synchronousWrites.length, 2, "subsequent session-approved copies should remain synchronous");

const hostFailure = createBridgeRuntime(["clipboard.write"], 503);
assert.equal(hostFailure.windowStub.utools.copyText("host failure"), false,
  "manifest permission does not turn a failed synchronous HostClipboard write into success");
assert.deepEqual(hostFailure.synchronousWrites.map((request) => [request.async, request.status]), [[false, 503]]);

const allowed = createBridgeRuntime(["shell.openExternal", "clipboard.write", "data", "screen.capture"]);
allowed.windowStub.utools.shellOpenExternal("https://example.com");
assert.equal(allowed.windowStub.utools.copyText("hello"), true, "manifest clipboard.write should grant the synchronous copy path");
allowed.windowStub.utools.db.put({ _id: "doc", value: 1 });
allowed.windowStub.utools.screenCapture();

assert.ok(
  allowed.postedMessages.some((message) => message.__ipc_call__ && message.cmd === "shell_open"),
  "allowed shellOpenExternal should reach the host shell_open command",
);
assert.ok(
  allowed.synchronousWrites.some((request) => request.async === false && request.body.text === "hello"),
  "manifest-authorized copyText should reach the synchronous HostClipboard endpoint",
);
assert.ok(
  allowed.postedMessages.some((message) => message.__ipc_call__ && message.cmd === "put_plugin_data"),
  "allowed db.put should reach the host plugin data command",
);
assert.ok(
  allowed.postedMessages.some((message) => message.__atools_native_call__ && message.method === "screenCapture"),
  "allowed screenCapture should reach the native bridge",
);

const grouped = createBridgeRuntime(["shell", "clipboard", "screen", "data"]);
grouped.windowStub.utools.shellTrashItem("/tmp/remove-me.txt");
assert.equal(grouped.windowStub.utools.copyText("clipboard group"), true,
  "the clipboard permission group should authorize copyText through HostClipboard");
grouped.windowStub.utools.desktopCaptureSources({ types: ["screen"] });
grouped.windowStub.utools.db.allDocs();
assert.ok(grouped.postedMessages.some((message) => message.method === "shellTrashItem"), "shell group should allow shellTrashItem");
assert.deepEqual(grouped.synchronousWrites.map((request) => request.body), [{ text: "clipboard group" }],
  "clipboard group writes should not escape to an async native or IPC copy command");
assert.ok(grouped.postedMessages.some((message) => message.method === "desktopCaptureSources"), "screen group should allow desktopCaptureSources");
assert.ok(grouped.postedMessages.some((message) => message.cmd === "get_plugin_data"), "data group should allow db.allDocs");
