import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

const [componentSource, capabilitySource, shimSource, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8"),
  readFile(new URL("crates/atools-plugin/src/bridge.rs", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define UTOOLS_BRIDGE");

const bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("events-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("events-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools Test"))
  .replace(/__APP_VERSION__/g, JSON.stringify("1.2.3"))
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify("payload text"));

const listeners = new Map();
const parentMessages = [];
const windowStub = {
  parent: {
    postMessage(message) {
      parentMessages.push(message);
    },
  },
  top: {},
  navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0" },
  document: {
    readyState: "loading",
    addEventListener(type, cb) {
      const list = listeners.get(`document:${type}`) || [];
      list.push(cb);
      listeners.set(`document:${type}`, list);
    },
  },
  addEventListener(type, cb) {
    const list = listeners.get(type) || [];
    list.push(cb);
    listeners.set(type, list);
  },
  dispatchEvent(event) {
    const type = typeof event === "string" ? event : event.type;
    for (const cb of listeners.get(type) || []) {
      cb(event);
    }
  },
};

function dispatchWindowMessage(data) {
  for (const cb of listeners.get("message") || []) {
    cb({ data });
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const context = vm.createContext({
  window: windowStub,
  navigator: windowStub.navigator,
  document: windowStub.document,
  console,
  setTimeout(fn) {
    fn();
  },
  Event: class {
    constructor(type) {
      this.type = type;
    }
  },
  CustomEvent: class {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  },
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.events.vm.js" });

assert.equal(typeof windowStub.utools.onMainPush, "function", "utools.onMainPush should be exposed");
assert.equal(typeof windowStub.utools.onPluginDetach, "function", "utools.onPluginDetach should be exposed");

let enterAction;
windowStub.utools.onPluginEnter((action) => {
  enterAction = action;
});
windowStub.dispatchEvent(new context.Event("atools-plugin-enter"));
assert.equal(enterAction.code, "events-feature");
assert.equal(enterAction.from, "main");
assert.equal(enterAction.payload, "payload text");

let outIsKill;
windowStub.utools.onPluginOut((isKill) => {
  outIsKill = isKill;
});
windowStub.dispatchEvent(new context.CustomEvent("atools-plugin-out", { detail: { isKill: true } }));
assert.equal(outIsKill, true, "onPluginOut should receive the official isKill boolean");

let detachCount = 0;
windowStub.utools.onPluginDetach(() => {
  detachCount += 1;
});
windowStub.dispatchEvent(new context.Event("atools-plugin-detach"));
assert.equal(detachCount, 1, "onPluginDetach should run registered callbacks");

let mainPushAction;
let selectedAction;
windowStub.utools.onMainPush(
  (action) => {
    mainPushAction = action;
    return [{ title: "Alpha", text: "alpha text", icon: "icon.png" }];
  },
  (action) => {
    selectedAction = action;
    return true;
  },
);

dispatchWindowMessage({
  __ipc_main_push__: true,
  reqId: 42,
  action: { code: "events-feature", type: "text", payload: "query" },
});
assert.deepEqual(mainPushAction, { code: "events-feature", type: "text", payload: "query" });
assert.deepEqual(plain(parentMessages.at(-1)), {
  __ipc_main_push_result__: true,
  reqId: 42,
  results: [{ title: "Alpha", text: "alpha text", icon: "icon.png" }],
});

dispatchWindowMessage({
  __ipc_main_push_select__: true,
  action: { code: "events-feature", type: "text", payload: "query", option: { text: "alpha text" } },
});
assert.deepEqual(selectedAction, {
  code: "events-feature",
  type: "text",
  payload: "query",
  option: { text: "alpha text" },
});

assert.match(componentSource, /onMainPush:\s*function\(callback,\s*onSelect\)/, "PluginPanel should expose official onMainPush signature");
assert.match(componentSource, /__ipc_main_push__/, "PluginPanel should listen for host mainPush events");
assert.match(componentSource, /onPluginDetach:\s*function\(cb\)/, "PluginPanel should expose onPluginDetach");
assert.match(componentSource, /detail\.isKill/, "onPluginOut should forward the official isKill detail");
assert.match(componentSource, /import\s+\{[^}]*\bonDestroy\b[^}]*\}\s+from\s+"svelte"/, "PluginPanel should register a destroy-time plugin lifecycle hook");
assert.match(componentSource, /function dispatchPluginOutEvent\(isKill: boolean\)/, "PluginPanel should centralize host-side onPluginOut dispatch");
assert.match(componentSource, /atools-plugin-out/, "host should dispatch atools-plugin-out before leaving plugin mode");
assert.match(componentSource, /postPluginLifecycleEvent\("plugin-out",\s*\{\s*isKill\s*\}\)/, "host onPluginOut dispatch should include the official isKill detail");
assert.match(componentSource, /function dispatchPluginDetachEvent\(\)/, "PluginPanel should centralize host-side onPluginDetach dispatch");
assert.match(componentSource, /atools-plugin-detach/, "host should dispatch atools-plugin-detach for the detach chrome action");
assert.match(componentSource, /function handlePluginChromeAction/, "PluginPanel should handle plugin chrome action clicks");
assert.match(componentSource, /case "detach":[\s\S]*dispatchPluginDetachEvent\(\)/, "detach chrome action should notify registered onPluginDetach callbacks");
assert.match(componentSource, /function closePluginPanel\(\)/, "PluginPanel should close through a lifecycle-aware helper");
assert.match(componentSource, /onDestroy\(\(\) => \{[\s\S]*dispatchPluginOutEvent\(true\)/, "destroying the plugin host should send a kill-style onPluginOut fallback");
assert.match(componentSource, /onclick=\{closePluginPanel\}/, "the back button should notify plugin out before closing");
assert.match(componentSource, /if \(data\.__ipc_close__\) \{[\s\S]*closePluginPanel\(\);/, "iframe close requests should notify plugin out before closing");
assert.match(componentSource, /function handleMainWindowLifecycle[\s\S]*else \{[\s\S]*closePluginPanel\(\);/, "Web preview hide fallback should use the lifecycle-aware close path");
assert.match(capabilitySource, /id:\s*"events"/, "shared bridge capability inventory should include an events group");
assert.match(capabilitySource, /"onMainPush"/, "shared capability inventory should include onMainPush");
assert.match(capabilitySource, /"onPluginDetach"/, "shared capability inventory should include onPluginDetach");
assert.match(shimSource, /onMainPush:\s*function\(callback,\s*onSelect\)/, "Rust plugin shim should expose the official onMainPush signature");

const pluginOutChecklistLine = smokeChecklist
  .split("\n")
  .find((line) => line.includes("插件宿主返回、iframe `__ipc_close__`、Web preview close 和 Svelte 销毁 fallback"));
assert.ok(pluginOutChecklistLine, "macOS smoke checklist should include plugin onPluginOut lifecycle row");
assert.match(
  pluginOutChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark plugin onPluginOut lifecycle row complete",
);
[
  "`__ipc_close__`",
  "`atools-plugin-out`",
  "`isKill:false`",
  "`isKill:true`",
  "`onPluginOut(callback)`",
].forEach((token) => {
  assert.ok(pluginOutChecklistLine.includes(token), `plugin onPluginOut lifecycle row should mention ${token}`);
});
