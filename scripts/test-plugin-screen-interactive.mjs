import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");
let screenBridgeSource = "";
try {
  screenBridgeSource = await readFile(new URL("src/lib/pluginScreenBridge.ts", root), "utf8");
} catch {
  screenBridgeSource = "";
}
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-screen-interactive-"));
const screenBridgeOutFile = join(outDir, "pluginScreenBridge.mjs");

try {
  assert.match(screenBridgeSource, /desktopCaptureSourcesForDisplay/, "pluginScreenBridge should implement desktopCaptureSourcesForDisplay");
  const screenBridgeSourcePath = new URL("src/lib/pluginScreenBridge.ts", root).pathname;
  const transformedScreenBridge = await transformWithEsbuild(screenBridgeSource, screenBridgeSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(screenBridgeOutFile, transformedScreenBridge.code);
  const screenBridge = await import(pathToFileURL(screenBridgeOutFile).href);
  assert.equal(typeof screenBridge.desktopCaptureSourcesForDisplay, "function");
  const primarySources = screenBridge.desktopCaptureSourcesForDisplay(
    { types: ["screen"] },
    { width: 1440, height: 900, availWidth: 1200, availHeight: 800, colorDepth: 30 },
    2,
  );
  assert.deepEqual(primarySources, [{
    id: "screen:1",
    name: "Primary Display",
    type: "screen",
    display_id: "1",
    thumbnail: null,
    appIcon: null,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 0, width: 1200, height: 800 },
    scaleFactor: 2,
  }]);
  assert.deepEqual(
    screenBridge.desktopCaptureSourcesForDisplay({ types: ["window"] }, { width: 1440, height: 900 }, 1),
    [],
  );
  assert.equal(
    screenBridge.desktopCaptureSourcesForDisplay(null, { width: 1440, height: 900 }, 1).length,
    1,
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

const bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("screen-interactive-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("screen-interactive-test-feature"))
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

assert.equal(typeof windowStub.utools.screenCapture, "function", "utools.screenCapture should be exposed");
assert.equal(typeof windowStub.utools.screenColorPick, "function", "utools.screenColorPick should be exposed");
assert.equal(typeof windowStub.utools.desktopCaptureSources, "function", "utools.desktopCaptureSources should be exposed");

const captureCallbacks = [];
const capturePromise = windowStub.utools.screenCapture((image) => {
  captureCallbacks.push(image);
});
const captureCall = postedMessages.find((message) => message.method === "screenCapture");
assert.ok(captureCall, "screenCapture should route through the native bridge");
respondToNativeCall(captureCall, { result: "data:image/png;base64,abc123" });
assert.equal(await capturePromise, "data:image/png;base64,abc123");
assert.deepEqual(captureCallbacks, ["data:image/png;base64,abc123"]);

const colorCallbacks = [];
const colorPromise = windowStub.utools.screenColorPick((colors) => {
  colorCallbacks.push(colors);
});
const colorCall = postedMessages.find((message) => message.method === "screenColorPick");
assert.ok(colorCall, "screenColorPick should route through the native bridge");
respondToNativeCall(colorCall, { result: { hex: "#336699", rgb: "rgb(51, 102, 153)" } });
assert.deepEqual(await colorPromise, { hex: "#336699", rgb: "rgb(51, 102, 153)" });
assert.deepEqual(colorCallbacks, [{ hex: "#336699", rgb: "rgb(51, 102, 153)" }]);

const sourcePromise = windowStub.utools.desktopCaptureSources({ types: ["window", "screen"] });
const sourceCall = postedMessages.find((message) => message.method === "desktopCaptureSources");
assert.ok(sourceCall, "desktopCaptureSources should route through the native bridge");
assert.deepEqual(plain(sourceCall.args), { options: { types: ["window", "screen"] } });
respondToNativeCall(sourceCall, { result: [{ id: "screen:1", name: "Primary Display" }] });
assert.deepEqual(plain(await sourcePromise), [{ id: "screen:1", name: "Primary Display" }]);

assert.match(componentSource, /screenCapture:\s*function\(callback\)/, "screenCapture should support the official callback argument");
assert.match(componentSource, /screenColorPick:\s*function\(callback\)/, "screenColorPick should support the official callback argument");
assert.match(componentSource, /desktopCaptureSources:\s*function\(options\)/, "desktopCaptureSources should accept options");
assert.match(componentSource, /case "screenColorPick":/, "host should return a method-scoped screenColorPick result");
assert.doesNotMatch(
  componentSource,
  /screenColorPick unsupported/,
  "screenColorPick should use a WebView host color picker path instead of unconditional unsupported",
);
assert.match(
  componentSource,
  /case "screenColorPick":[\s\S]*pickScreenColorWithEyeDropper\(\)/,
  "host should use the WebView EyeDropper bridge for screenColorPick",
);
assert.match(
  componentSource,
  /screenColorPick unavailable/,
  "screenColorPick should return an explicit unavailable error when EyeDropper is missing",
);
assert.match(componentSource, /case "desktopCaptureSources":/, "host should return a method-scoped desktopCaptureSources result");
assert.match(componentSource, /desktopCaptureSourcesForDisplay/, "host should return primary display capture source metadata");
assert.doesNotMatch(componentSource, /desktopCaptureSources unsupported/, "desktopCaptureSources should return a compatibility source list instead of unsupported");
assert.match(capabilitySource, /"screenColorPick"/, "shared capability inventory should include screenColorPick");
assert.match(capabilitySource, /"desktopCaptureSources"/, "shared capability inventory should include desktopCaptureSources");
