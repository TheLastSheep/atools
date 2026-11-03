import { loadProductionPluginBridgeTemplate, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const themeImplementation = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/utools-api-and-dynamic-features.ts");
const themeEntry = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/providers-and-entry-lifecycle.ts");
const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("window-theme-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("window-theme-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

function runBridge({ matchMedia } = {}) {
  const listeners = new Map();
  const windowStub = {
    parent: {
      postMessage() {},
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
  };
  if (matchMedia) {
    windowStub.matchMedia = matchMedia;
  }

  const documentStub = {
    readyState: "complete",
    addEventListener(type, cb) {
      const list = listeners.get(`document:${type}`) || [];
      list.push(cb);
      listeners.set(`document:${type}`, list);
    },
  };

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
    Event,
    CustomEvent,
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
  return windowStub;
}

let lastMediaQuery = null;
const darkWindow = runBridge({
  matchMedia(query) {
    lastMediaQuery = query;
    return { matches: true };
  },
});

assert.equal(typeof darkWindow.utools.isDarkColors, "function", "utools.isDarkColors should be exposed");
assert.equal(darkWindow.utools.isDarkColors(), true, "dark color scheme should return true");
assert.equal(lastMediaQuery, "(prefers-color-scheme: dark)", "isDarkColors should use the official web-native media query");

const lightWindow = runBridge({
  matchMedia() {
    return { matches: false };
  },
});
assert.equal(lightWindow.utools.isDarkColors(), false, "light color scheme should return false");

const fallbackWindow = runBridge();
assert.equal(fallbackWindow.utools.isDarkColors(), false, "missing matchMedia should still return a boolean false");

assert.match(themeImplementation, /function _isDarkColors\(\)/, "bridge should keep theme detection in a safe helper");
assert.match(themeEntry, /isDarkColors:\s*function\(\)/, "bridge should expose isDarkColors()");
assert.match(capabilitySource, /"isDarkColors"/, "shared window capability inventory should include isDarkColors");
