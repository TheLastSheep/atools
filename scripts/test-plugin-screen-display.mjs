import { injectPluginBridgeFactories } from "./lib/plugin-bridge-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");
const bridgeTemplate = await injectPluginBridgeFactories(bridgeMatch[1]);

const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("screen-display-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("screen-display-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

const listeners = new Map();
const dispatchedEvents = [];

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const windowStub = {
  parent: {
    postMessage() {},
  },
  top: {},
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => ({ cmd, args }),
  },
  screen: {
    width: 2560,
    height: 1440,
    availLeft: 10,
    availTop: 20,
    availWidth: 2500,
    availHeight: 1350,
    colorDepth: 30,
  },
  devicePixelRatio: 2,
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
  navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
  Event: EventStub,
  CustomEvent: class extends EventStub { constructor(type, init) { super(type); this.detail = init?.detail; } },
  console: {
    error() {},
    warn() {},
    log() {},
  },
  Date,
  Math,
  Number,
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });
// Production entry dispatch waits for the async initialization barrier.
await new Promise(resolve => setImmediate(resolve));

assert.equal(typeof windowStub.utools.getPrimaryDisplay, "function", "utools.getPrimaryDisplay should be exposed");
assert.equal(typeof windowStub.utools.getAllDisplays, "function", "utools.getAllDisplays should be exposed");
assert.equal(typeof windowStub.utools.getCursorScreenPoint, "function", "utools.getCursorScreenPoint should be exposed");
assert.equal(typeof windowStub.utools.getDisplayNearestPoint, "function", "utools.getDisplayNearestPoint should be exposed");
assert.equal(typeof windowStub.utools.getDisplayMatching, "function", "utools.getDisplayMatching should be exposed");
assert.equal(typeof windowStub.utools.screenToDipPoint, "function", "utools.screenToDipPoint should be exposed");
assert.equal(typeof windowStub.utools.dipToScreenPoint, "function", "utools.dipToScreenPoint should be exposed");
assert.equal(typeof windowStub.utools.screenToDipRect, "function", "utools.screenToDipRect should be exposed");
assert.equal(typeof windowStub.utools.dipToScreenRect, "function", "utools.dipToScreenRect should be exposed");

// The base/preview bridge has no native authority. Browser screen or mouse
// events must never be passed off as operating-system display metadata.
for (const method of ["getPrimaryDisplay", "getAllDisplays", "getCursorScreenPoint", "getDisplayNearestPoint", "getDisplayMatching", "screenToDipPoint", "dipToScreenPoint", "screenToDipRect", "dipToScreenRect"]) {
  assert.throws(() => windowStub.utools[method](), error => error.code === "ERR_ATOOLS_DISPLAY_UNSUPPORTED");
}
assert.equal((listeners.get("mousemove") || []).length, 0, "metadata must not use a DOM pointer history");

assert.ok(dispatchedEvents.includes("atools-plugin-enter"));
assert.ok(dispatchedEvents.includes("atools-plugin-ready"));

assert.match(componentSource, /pluginDisplayBridgeScript/, "production injects the permission-bound native implementation");
assert.doesNotMatch(componentSource, /_lastCursorScreenPoint|function _createDisplaySnapshot/, "no fake per-window display implementation remains");
assert.match(capabilitySource, /"getPrimaryDisplay"/, "shared capability inventory should include getPrimaryDisplay");
assert.match(capabilitySource, /"getAllDisplays"/, "shared capability inventory should include getAllDisplays");
assert.match(capabilitySource, /"getCursorScreenPoint"/, "shared capability inventory should include getCursorScreenPoint");
assert.match(capabilitySource, /"getDisplayNearestPoint"/, "shared capability inventory should include getDisplayNearestPoint");
assert.match(capabilitySource, /"getDisplayMatching"/, "shared capability inventory should include getDisplayMatching");
assert.match(capabilitySource, /"screenToDipPoint"/, "shared capability inventory should include screenToDipPoint");
assert.match(capabilitySource, /"dipToScreenPoint"/, "shared capability inventory should include dipToScreenPoint");
assert.match(capabilitySource, /"screenToDipRect"/, "shared capability inventory should include screenToDipRect");
assert.match(capabilitySource, /"dipToScreenRect"/, "shared capability inventory should include dipToScreenRect");
