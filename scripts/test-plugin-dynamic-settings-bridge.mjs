import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-dynamic-settings-"));

try {
  const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  const appSource = await readFile(new URL("src/App.svelte", root), "utf8");
  const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

  const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
  assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

  const bridgeSource = bridgeMatch[1]
    .replace(/<\\\/script>/g, "</script>")
    .replace(/^\s*<script>\s*/, "")
    .replace(/\s*<\/script>\s*$/, "")
    .replace(/__PLUGIN_ID__/g, JSON.stringify("dynamic-settings-test-plugin"))
    .replace(/__FEATURE_CODE__/g, JSON.stringify("dynamic-settings-test-feature"))
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

  assert.equal(
    typeof windowStub.utools.redirectHotKeySetting,
    "function",
    "utools.redirectHotKeySetting should be exposed",
  );
  const hotkeyPromise = windowStub.utools.redirectHotKeySetting("问 AI", true);
  const hotkeyCall = postedMessages.find((message) => message.method === "redirectHotKeySetting");
  assert.ok(hotkeyCall, "redirectHotKeySetting should route through the native bridge");
  assert.deepEqual(JSON.parse(JSON.stringify(hotkeyCall.args)), {
    cmdLabel: "问 AI",
    autocopy: true,
  });
  respondToNativeCall(hotkeyCall, { result: true });
  assert.equal(await hotkeyPromise, true, "redirectHotKeySetting should resolve the host routing result");

  assert.equal(
    typeof windowStub.utools.redirectAiModelsSetting,
    "function",
    "utools.redirectAiModelsSetting should be exposed",
  );
  const aiPromise = windowStub.utools.redirectAiModelsSetting();
  const aiCall = postedMessages.find((message) => message.method === "redirectAiModelsSetting");
  assert.ok(aiCall, "redirectAiModelsSetting should route through the native bridge");
  assert.deepEqual(JSON.parse(JSON.stringify(aiCall.args)), {});
  respondToNativeCall(aiCall, { result: true });
  assert.equal(await aiPromise, true, "redirectAiModelsSetting should resolve the host routing result");

  assert.match(componentSource, /onsettingsredirect\?:/, "PluginPanel should accept a settings redirect host callback");
  assert.match(componentSource, /redirectHotKeySetting:\s*function\(cmdLabel,\s*autocopy\)/, "bridge should expose redirectHotKeySetting(cmdLabel, autocopy)");
  assert.match(componentSource, /redirectAiModelsSetting:\s*function\(\)/, "bridge should expose redirectAiModelsSetting()");
  assert.match(componentSource, /case "redirectHotKeySetting":/, "host should handle redirectHotKeySetting native calls");
  assert.match(componentSource, /case "redirectAiModelsSetting":/, "host should handle redirectAiModelsSetting native calls");
  assert.match(componentSource, /settings redirect unsupported/, "unsupported settings redirect errors should name the API class");
  assert.match(capabilitySource, /"redirectHotKeySetting"/, "shared capability inventory should include redirectHotKeySetting");
  assert.match(capabilitySource, /"redirectAiModelsSetting"/, "shared capability inventory should include redirectAiModelsSetting");
  assert.match(appSource, /function handlePluginSettingsRedirect/, "App should handle plugin settings redirect requests");
  assert.match(appSource, /activePlugin = null;/, "settings redirects should leave plugin mode before opening settings");
  assert.match(appSource, /openSettingsMenu\("shortcuts"\)/, "hotkey setting redirect should open the shortcuts settings page");
  assert.match(appSource, /openSettingsMenu\("ai"\)/, "AI models setting redirect should open the AI settings page");
  assert.match(
    appSource,
    /onsettingsredirect:\s*handlePluginSettingsRedirect/,
    "PluginPanel should be wired to App settings redirect handling",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
