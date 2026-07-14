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
  .replace(/__PLUGIN_ID__/g, JSON.stringify("user-bridge-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("user-bridge-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

const listeners = new Map();
const postedMessages = [];

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

assert.equal(typeof windowStub.utools.getUser, "function", "utools.getUser should be exposed");
assert.equal(windowStub.utools.getUser(), null, "local-only host should report no logged-in uTools user");
assert.equal(
  postedMessages.some((message) => message.method === "getUser"),
  false,
  "getUser should be a synchronous local-only compatibility result"
);

assert.equal(
  typeof windowStub.utools.fetchUserServerTemporaryToken,
  "function",
  "utools.fetchUserServerTemporaryToken should be exposed"
);
await assert.rejects(
  windowStub.utools.fetchUserServerTemporaryToken(),
  /fetchUserServerTemporaryToken unsupported: user server temporary token is not available/
);
assert.equal(
  postedMessages.some((message) => message.method === "fetchUserServerTemporaryToken"),
  false,
  "temporary token should fail explicitly without a fake native bridge success"
);

assert.match(componentSource, /getUser:\s*function\(\)\s*\{\s*return null;\s*\}/);
assert.match(componentSource, /fetchUserServerTemporaryToken:\s*function\(\)/);
assert.match(componentSource, /fetchUserServerTemporaryToken unsupported/);
assert.match(capabilitySource, /id:\s*"user"/, "shared capability inventory should include a user group");
assert.match(capabilitySource, /"getUser"/, "shared capability inventory should include getUser");
assert.match(capabilitySource, /"fetchUserServerTemporaryToken"/, "shared capability inventory should include fetchUserServerTemporaryToken");
