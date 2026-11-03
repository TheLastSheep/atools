import { loadProductionPluginBridgeTemplate, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const bridgeApiSource = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/providers-and-entry-lifecycle.ts");
const nativeRouterSource = await readPanelHostSource(root, "src/lib/pluginPanelNativeBridgeRouter.ts");
const systemClipboardSource = await readPanelHostSource(root, "src/lib/pluginPanelSystemClipboard.ts");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");
const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);

const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("input-bridge-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("input-bridge-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"))
  .replace("var _atoolsPluginPermissions = null;", 'var _atoolsPluginPermissions = ["clipboard.write", "input.keyboard"];');

const listeners = new Map();
const postedMessages = [];

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const windowStub = {
  parent: {
    postMessage(message) {
      postedMessages.push(message);
    },
  },
  top: {},
  screen: {
    width: 1440,
    height: 900,
  },
  devicePixelRatio: 1,
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
  navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
  Event: EventStub,
  console: {
    error() {},
    warn() {},
    log() {},
  },
  Date,
  Math,
  Number,
  Promise,
  TextEncoder,
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});
context.CustomEvent = EventStub;

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

function respondToNativeCall(call, payload) {
  const handlers = listeners.get("message") || [];
  handlers.forEach((handler) => handler({
    data: {
      __atools_native_response__: true,
      reqId: call.reqId,
      ...payload,
    },
  }));
}

assert.equal(typeof windowStub.utools.hideMainWindowPasteText, "function", "hideMainWindowPasteText should be exposed");
assert.equal(typeof windowStub.utools.hideMainWindowPasteImage, "function", "hideMainWindowPasteImage should be exposed");
assert.equal(typeof windowStub.utools.hideMainWindowPasteFile, "function", "hideMainWindowPasteFile should be exposed");
assert.equal(typeof windowStub.utools.hideMainWindowTypeString, "function", "hideMainWindowTypeString should be exposed");

const textPromise = windowStub.utools.hideMainWindowPasteText("Hello World");
const textCall = postedMessages.find((message) => message.method === "hideMainWindowPasteText");
assert.ok(textCall, "hideMainWindowPasteText should route through the native bridge");
assert.deepEqual(plain(textCall.args), { text: "Hello World" });
respondToNativeCall(textCall, { error: "hideMainWindowPasteText unsupported: external paste automation is not available" });
await assert.rejects(textPromise, /hideMainWindowPasteText unsupported/);

windowStub.utools.hideMainWindowPasteImage("data:image/png;base64,abc123");
const imageCall = postedMessages.find((message) => message.method === "hideMainWindowPasteImage");
assert.ok(imageCall, "hideMainWindowPasteImage should route through the native bridge");
assert.deepEqual(plain(imageCall.args), { image: "data:image/png;base64,abc123" });

windowStub.utools.hideMainWindowPasteFile(["/tmp/a.txt", "/tmp/b.txt"]);
const fileCall = postedMessages.find((message) => message.method === "hideMainWindowPasteFile");
assert.ok(fileCall, "hideMainWindowPasteFile should route through the native bridge");
assert.deepEqual(plain(fileCall.args), { file: ["/tmp/a.txt", "/tmp/b.txt"] });

windowStub.utools.hideMainWindowTypeString("ATools");
const typeCall = postedMessages.find((message) => message.method === "hideMainWindowTypeString");
assert.ok(typeCall, "hideMainWindowTypeString should route through the native bridge");
assert.deepEqual(plain(typeCall.args), { text: "ATools" });

assert.match(bridgeApiSource, /hideMainWindowPasteText:\s*function\(text\)/, "production bridge entry should expose hideMainWindowPasteText");
assert.match(bridgeApiSource, /hideMainWindowPasteImage:\s*function\(image\)/, "production bridge entry should expose hideMainWindowPasteImage");
assert.match(bridgeApiSource, /hideMainWindowPasteFile:\s*function\(file\)/, "production bridge entry should expose hideMainWindowPasteFile");
assert.match(bridgeApiSource, /hideMainWindowTypeString:\s*function\(text\)/, "production bridge entry should expose hideMainWindowTypeString");
assert.match(nativeRouterSource, /case "hideMainWindowPasteText":/, "native host router should return a method-scoped paste-text result");
assert.doesNotMatch(
  nativeRouterSource,
  /hideMainWindowPasteText unsupported/,
  "paste-text should be implemented by the WebView host instead of returning unsupported",
);
assert.match(nativeRouterSource, /case "hideMainWindowPasteText":[\s\S]*await writeText\(/, "paste-text router should write text to clipboard before pasting");
assert.match(systemClipboardSource, /export async function hideMainWindowForPluginPaste/, "clipboard adapter should own main-window hiding for paste");
assert.match(nativeRouterSource, /keystroke "v" using command down/, "paste-text host should trigger the standard macOS paste shortcut");
assert.match(nativeRouterSource, /case "hideMainWindowPasteImage":/, "host should return a method-scoped paste-image result");
assert.doesNotMatch(
  nativeRouterSource,
  /hideMainWindowPasteImage unsupported/,
  "paste-image should be implemented by the WebView host instead of returning unsupported",
);
assert.match(
  nativeRouterSource,
  /case "hideMainWindowPasteImage":[\s\S]*writePluginImage\(args\.image\)/,
  "paste-image router should delegate image writing to its clipboard adapter before pasting",
);
assert.match(
  systemClipboardSource,
  /export async function writePluginImageToClipboard/,
  "clipboard adapter should own production image conversion and write" ,
);
assert.match(
  nativeRouterSource,
  /case "hideMainWindowPasteImage":[\s\S]*await hidePanelForPaste\(onclose\)/,
  "paste-image host should hide the main window before pasting into the foreground app",
);
assert.match(nativeRouterSource, /case "hideMainWindowPasteFile":/, "host should return a method-scoped paste-file result");
assert.doesNotMatch(
  nativeRouterSource,
  /hideMainWindowPasteFile unsupported/,
  "paste-file should be implemented by the WebView host instead of returning unsupported",
);
assert.match(
  nativeRouterSource,
  /case "hideMainWindowPasteFile":[\s\S]*pluginFileClipboardAppleScript\(pathsFromBridgeValue\(args\.file\)\)/,
  "paste-file host should write one or more file paths to the clipboard before pasting",
);
assert.match(
  nativeRouterSource,
  /case "hideMainWindowPasteFile":[\s\S]*await hidePanelForPaste\(onclose\)/,
  "paste-file host should hide the main window before pasting into the foreground app",
);
assert.match(nativeRouterSource, /case "hideMainWindowTypeString":/, "host should return a method-scoped type-string result");
assert.doesNotMatch(
  nativeRouterSource,
  /hideMainWindowTypeString unsupported/,
  "type-string should be implemented by the WebView host instead of returning unsupported",
);
assert.match(
  nativeRouterSource,
  /case "hideMainWindowTypeString":[\s\S]*await hidePanelForPaste\(onclose\)/,
  "type-string host should hide the main window before typing into the foreground app",
);
assert.match(
  nativeRouterSource,
  /case "hideMainWindowTypeString":[\s\S]*appleScriptString\(String\(args\.text \?\? ""\)\)/,
  "type-string host should escape text before passing it to AppleScript",
);
assert.match(capabilitySource, /"input"/, "shared capability inventory should include an input group");
assert.match(capabilitySource, /"hideMainWindowPasteText"/, "shared capability inventory should include hideMainWindowPasteText");
assert.match(capabilitySource, /"hideMainWindowPasteImage"/, "shared capability inventory should include hideMainWindowPasteImage");
assert.match(capabilitySource, /"hideMainWindowPasteFile"/, "shared capability inventory should include hideMainWindowPasteFile");
assert.match(capabilitySource, /"hideMainWindowTypeString"/, "shared capability inventory should include hideMainWindowTypeString");
