import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

const bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("input-bridge-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("input-bridge-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

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
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});

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

assert.match(componentSource, /hideMainWindowPasteText:\s*function\(text\)/, "bridge should expose hideMainWindowPasteText");
assert.match(componentSource, /hideMainWindowPasteImage:\s*function\(image\)/, "bridge should expose hideMainWindowPasteImage");
assert.match(componentSource, /hideMainWindowPasteFile:\s*function\(file\)/, "bridge should expose hideMainWindowPasteFile");
assert.match(componentSource, /hideMainWindowTypeString:\s*function\(text\)/, "bridge should expose hideMainWindowTypeString");
assert.match(componentSource, /case "hideMainWindowPasteText":/, "host should return a method-scoped paste-text result");
assert.doesNotMatch(
  componentSource,
  /hideMainWindowPasteText unsupported/,
  "paste-text should be implemented by the WebView host instead of returning unsupported",
);
assert.match(componentSource, /writeText\(/, "paste-text host should write text to the clipboard before pasting");
assert.match(componentSource, /hideMainWindowForPluginPaste/, "paste-text host should hide the main window before pasting");
assert.match(componentSource, /keystroke "v" using command down/, "paste-text host should trigger the standard macOS paste shortcut");
assert.match(componentSource, /case "hideMainWindowPasteImage":/, "host should return a method-scoped paste-image result");
assert.doesNotMatch(
  componentSource,
  /hideMainWindowPasteImage unsupported/,
  "paste-image should be implemented by the WebView host instead of returning unsupported",
);
assert.match(
  componentSource,
  /case "hideMainWindowPasteImage":[\s\S]*writePluginImageToClipboard\(args\.image\)/,
  "paste-image host should write the image to the clipboard before pasting",
);
assert.match(
  componentSource,
  /case "hideMainWindowPasteImage":[\s\S]*hideMainWindowForPluginPaste\(\)/,
  "paste-image host should hide the main window before pasting into the foreground app",
);
assert.match(componentSource, /case "hideMainWindowPasteFile":/, "host should return a method-scoped paste-file result");
assert.doesNotMatch(
  componentSource,
  /hideMainWindowPasteFile unsupported/,
  "paste-file should be implemented by the WebView host instead of returning unsupported",
);
assert.match(
  componentSource,
  /case "hideMainWindowPasteFile":[\s\S]*pluginFileClipboardAppleScript\(pathsFromBridgeValue\(args\.file\)\)/,
  "paste-file host should write one or more file paths to the clipboard before pasting",
);
assert.match(
  componentSource,
  /case "hideMainWindowPasteFile":[\s\S]*hideMainWindowForPluginPaste\(\)/,
  "paste-file host should hide the main window before pasting into the foreground app",
);
assert.match(componentSource, /case "hideMainWindowTypeString":/, "host should return a method-scoped type-string result");
assert.doesNotMatch(
  componentSource,
  /hideMainWindowTypeString unsupported/,
  "type-string should be implemented by the WebView host instead of returning unsupported",
);
assert.match(
  componentSource,
  /case "hideMainWindowTypeString":[\s\S]*hideMainWindowForPluginPaste\(\)/,
  "type-string host should hide the main window before typing into the foreground app",
);
assert.match(
  componentSource,
  /case "hideMainWindowTypeString":[\s\S]*appleScriptString\(String\(args\.text \?\? ""\)\)/,
  "type-string host should escape text before passing it to AppleScript",
);
assert.match(capabilitySource, /"input"/, "shared capability inventory should include an input group");
assert.match(capabilitySource, /"hideMainWindowPasteText"/, "shared capability inventory should include hideMainWindowPasteText");
assert.match(capabilitySource, /"hideMainWindowPasteImage"/, "shared capability inventory should include hideMainWindowPasteImage");
assert.match(capabilitySource, /"hideMainWindowPasteFile"/, "shared capability inventory should include hideMainWindowPasteFile");
assert.match(capabilitySource, /"hideMainWindowTypeString"/, "shared capability inventory should include hideMainWindowTypeString");
