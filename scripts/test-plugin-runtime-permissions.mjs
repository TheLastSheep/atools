import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const appSource = await readFile(new URL("src/App.svelte", root), "utf8");
const typesSource = await readFile(new URL("src/lib/types.ts", root), "utf8");

assert.match(typesSource, /plugin_permissions\??:\s*string\[\]/, "FeatureAction should carry manifest plugin_permissions to the runtime host");
assert.match(componentSource, /var _atoolsPluginPermissions = null;/, "Bridge should define a legacy-null permissions slot");
assert.match(componentSource, /function _requirePluginPermission/, "Bridge should centralize plugin permission checks");
assert.match(componentSource, /function _requestPluginPermission/, "Bridge should ask the host before denied runtime permissions");
assert.match(componentSource, /__atools_permission_request__/, "Bridge should send runtime permission requests to the host");
assert.match(componentSource, /__atools_permission_response__/, "Bridge should receive runtime permission responses from the host");
assert.match(componentSource, /plugin-permission-dialog/, "PluginPanel should render an in-host runtime permission prompt");
assert.match(componentSource, /本次会话允许/, "Runtime permission prompt should expose a session approval action");
assert.match(componentSource, /始终允许/, "Runtime permission prompt should expose a persistent approval action");
assert.match(componentSource, /grantPluginRuntimePermission/, "Persistent runtime approvals should be saved for the plugin");
assert.match(componentSource, /pluginRuntimePermissionGrantList\(action\.plugin_id/, "PluginPanel should load persistent runtime grants for the active plugin");
assert.match(componentSource, /PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT/, "PluginPanel should observe runtime grant changes made from Settings");
assert.match(componentSource, /try\s*{\s*request\.source\?\.postMessage/, "Runtime permission responses should tolerate postMessage failures");
assert.match(appSource, /pluginHostSmoke\s*===\s*"permissionPrompt"/, "Web preview smoke should expose a runtime permission prompt scenario");
assert.match(appSource, /plugin_permissions:\s*permissionPromptSmoke\s*\?\s*\[\]\s*:/, "Runtime permission prompt smoke should start with no manifest permissions");
assert.match(appSource, /copyText\('permission prompt smoke'\)/, "Runtime permission prompt smoke should request clipboard.write through copyText");
assert.match(appSource, /iframeContextSmoke\s*\|\|\s*browserWindowSmoke\s*\|\|\s*permissionPromptSmoke\s*\?\s*\[\]\s*:/, "Runtime permission prompt smoke should render the iframe runtime instead of output rows");

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

function bridgeSourceFor(permissions) {
  return bridgeMatch[1]
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

function createBridgeRuntime(permissions) {
  const listeners = new Map();
  const postedMessages = [];
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

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0" },
    Event: EventStub,
    console: { error() {}, warn() {}, log() {} },
    Date,
    Math,
    Number,
    Promise,
    decodeURIComponent,
    encodeURIComponent,
    setTimeout(cb) {
      cb();
      return 1;
    },
    clearTimeout() {},
  });

  vm.runInContext(bridgeSourceFor(permissions), context, { filename: "UTOOLS_BRIDGE.permissions.vm.js" });
  return {
    windowStub,
    postedMessages,
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

const approved = createBridgeRuntime([]);
const approvedCopyCall = approved.windowStub.utools.copyText("secret");
const approvedCopyRequest = approved.postedMessages.find((message) => message.__atools_permission_request__);
assert.equal(approvedCopyRequest?.permission, "clipboard.write", "missing copyText permission should request clipboard.write");
approved.sendMessage({
  __atools_permission_response__: true,
  reqId: approvedCopyRequest.reqId,
  permission: "clipboard.write",
  allowed: true,
});
await Promise.resolve();
assert.ok(
  approved.postedMessages.some((message) => message.__ipc_call__ && message.cmd === "copy_text"),
  "approved runtime copyText permission should reach copy_text",
);
assert.equal(await stateOf(approvedCopyCall), "pending", "approved copyText should now be waiting for the host invoke response");

approved.windowStub.utools.copyText("second");
assert.equal(
  approved.postedMessages.filter((message) => message.__atools_permission_request__ && message.permission === "clipboard.write").length,
  1,
  "session-approved runtime permission should not prompt again for the same API",
);

const allowed = createBridgeRuntime(["shell.openExternal", "clipboard.write", "data", "screen.capture"]);
allowed.windowStub.utools.shellOpenExternal("https://example.com");
allowed.windowStub.utools.copyText("hello");
allowed.windowStub.utools.db.put({ _id: "doc", value: 1 });
allowed.windowStub.utools.screenCapture();

assert.ok(
  allowed.postedMessages.some((message) => message.__ipc_call__ && message.cmd === "shell_open"),
  "allowed shellOpenExternal should reach the host shell_open command",
);
assert.ok(
  allowed.postedMessages.some((message) => message.__ipc_call__ && message.cmd === "copy_text"),
  "allowed copyText should reach the host copy_text command",
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
grouped.windowStub.utools.copyImage("data:image/png;base64,AAAA");
grouped.windowStub.utools.desktopCaptureSources({ types: ["screen"] });
grouped.windowStub.utools.db.allDocs();
assert.ok(grouped.postedMessages.some((message) => message.method === "shellTrashItem"), "shell group should allow shellTrashItem");
assert.ok(grouped.postedMessages.some((message) => message.method === "copyImage"), "clipboard group should allow copyImage");
assert.ok(grouped.postedMessages.some((message) => message.method === "desktopCaptureSources"), "screen group should allow desktopCaptureSources");
assert.ok(grouped.postedMessages.some((message) => message.cmd === "get_plugin_data"), "data group should allow db.allDocs");
