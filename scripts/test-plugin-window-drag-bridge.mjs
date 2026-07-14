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
  .replace(/__PLUGIN_ID__/g, JSON.stringify("window-drag-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("window-drag-test-feature"))
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

assert.equal(typeof windowStub.utools.startDrag, "function", "utools.startDrag should be exposed");

const singleDragPromise = windowStub.utools.startDrag("/tmp/example.txt");
const singleDragCall = postedMessages.find((message) => message.method === "startDrag");
assert.ok(singleDragCall, "startDrag should route through the native bridge");
assert.deepEqual(plain(singleDragCall.args), { filePath: "/tmp/example.txt" });
respondToNativeCall(singleDragCall, {
  error: "startDrag unsupported: native file dragging is not available in the current WebView host",
});
await assert.rejects(singleDragPromise, /startDrag unsupported/);

windowStub.utools.startDrag(["/tmp/a.txt", "/tmp/b.txt"]);
const arrayDragCall = postedMessages.findLast((message) => message.method === "startDrag");
assert.ok(arrayDragCall, "startDrag should support the official file path array argument");
assert.deepEqual(plain(arrayDragCall.args), { filePath: ["/tmp/a.txt", "/tmp/b.txt"] });

assert.match(componentSource, /startDrag:\s*function\(filePath\)/, "bridge should expose startDrag(filePath)");
assert.match(componentSource, /case "startDrag":/, "host should return a method-scoped drag result");
assert.match(componentSource, /startDrag unsupported/, "startDrag unsupported errors should include the API name");
assert.match(capabilitySource, /"startDrag"/, "shared capability inventory should include startDrag");
