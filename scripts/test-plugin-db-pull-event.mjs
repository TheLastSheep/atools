import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

let bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("db-pull-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("db-pull-test-feature"));

const listeners = new Map();
const dispatchedEvents = [];
const postedMessages = [];
const consoleErrors = [];

const windowStub = {
  parent: {
    postMessage(message) {
      postedMessages.push(message);
    },
  },
  top: {},
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => ({ cmd, args }),
  },
  addEventListener(type, cb) {
    const list = listeners.get(type) || [];
    list.push(cb);
    listeners.set(type, list);
  },
  dispatchEvent(event) {
    dispatchedEvents.push(event.type);
    const list = listeners.get(event.type) || [];
    list.forEach((cb) => cb(event));
  },
  matchMedia() {
    return { matches: false };
  },
};
windowStub.parent.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;
windowStub.top.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;

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
  navigator: { platform: "MacIntel" },
  Event: EventStub,
  console: {
    error(...args) {
      consoleErrors.push(args);
    },
    warn() {},
    log() {},
  },
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

assert.equal(typeof windowStub.utools.onDbPull, "function", "utools.onDbPull should be exposed");
assert.match(componentSource, /var _dbListeners = \{ change: \[\], docs: \[\] \}/);
assert.match(componentSource, /__ipc_db_pull__/);
assert.match(componentSource, /function _emitDbPull/);

const pulledDocs = [];
const callbackResult = windowStub.utools.onDbPull((docs) => {
  pulledDocs.push(docs);
});
assert.equal(callbackResult, undefined, "onDbPull should preserve the official void-return shape");

windowStub.utools.onDbPull("not a callback");

const messageHandlers = listeners.get("message") || [];
assert.ok(messageHandlers.length >= 1, "bridge should register message handlers");

const docs = [
  { _id: "note/a", title: "A" },
  { _id: "note/b", title: "B" },
];
messageHandlers.forEach((handler) => {
  handler({ data: { __ipc_db_pull__: true, docs } });
});

assert.deepEqual(pulledDocs, [docs], "onDbPull should receive docs from the host message");

messageHandlers.forEach((handler) => {
  handler({ data: { __ipc_db_pull__: true, docs: { _id: "bad-shape" } } });
});
assert.equal(Array.isArray(pulledDocs[1]), true, "onDbPull should normalize non-array docs to an array");
assert.equal(pulledDocs[1].length, 0, "onDbPull should normalize non-array docs to an empty list");

windowStub.utools.onDbPull(() => {
  throw new Error("listener failure");
});
messageHandlers.forEach((handler) => {
  handler({ data: { __ipc_db_pull__: true, docs: [{ _id: "note/c" }] } });
});
assert.equal(pulledDocs.length, 3, "failing listeners should not prevent other listeners");
assert.ok(consoleErrors.length >= 1, "failing onDbPull listeners should be reported");
assert.deepEqual(
  postedMessages.filter((message) => message.__atools_plugin_ready__ !== true),
  [],
  "onDbPull should not post host messages during registration",
);
assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.find((message) => message.__atools_plugin_ready__ === true))), {
  __atools_plugin_ready__: true,
  pluginId: "db-pull-test-plugin",
  featureCode: "db-pull-test-feature",
});
assert.ok(dispatchedEvents.includes("atools-plugin-enter"));
assert.ok(dispatchedEvents.includes("atools-plugin-ready"));
