import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");
let shellBridgeSource = "";
try {
  shellBridgeSource = await readFile(new URL("src/lib/pluginSystemShellBridge.ts", root), "utf8");
} catch {
  shellBridgeSource = "";
}
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-system-shell-bridge-"));
const shellBridgeOutFile = join(outDir, "pluginSystemShellBridge.mjs");

try {
  assert.match(shellBridgeSource, /shellTrashAppleScript/, "pluginSystemShellBridge should implement shellTrashAppleScript");
  assert.match(shellBridgeSource, /normalizeShellTrashPath/, "pluginSystemShellBridge should implement normalizeShellTrashPath");
  const shellBridgeSourcePath = new URL("src/lib/pluginSystemShellBridge.ts", root).pathname;
  const transformedShellBridge = await transformWithEsbuild(shellBridgeSource, shellBridgeSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(shellBridgeOutFile, transformedShellBridge.code);
  const shellBridge = await import(pathToFileURL(shellBridgeOutFile).href);

  assert.equal(typeof shellBridge.shellTrashAppleScript, "function", "shellTrashAppleScript should be exported");
  assert.equal(typeof shellBridge.normalizeShellTrashPath, "function", "normalizeShellTrashPath should be exported");
  assert.equal(shellBridge.normalizeShellTrashPath("  /tmp/delete-me.txt  "), "/tmp/delete-me.txt");
  assert.throws(() => shellBridge.normalizeShellTrashPath(""), /shellTrashItem requires a file path/);
  assert.throws(() => shellBridge.normalizeShellTrashPath("   "), /shellTrashItem requires a file path/);
  assert.equal(
    shellBridge.shellTrashAppleScript('/tmp/delete "me" \\\\ file.txt'),
    'tell application "Finder" to delete POSIX file "/tmp/delete \\"me\\" \\\\\\\\ file.txt"',
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
  .replace(/__PLUGIN_ID__/g, JSON.stringify("system-shell-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("system-shell-test-feature"))
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
  localStorage: {
    getItem() { return null; },
    setItem() {},
  },
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
  navigator: { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
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
  decodeURIComponent,
  encodeURIComponent,
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

assert.equal(typeof windowStub.utools.isMacOS, "function", "utools.isMacOS should be exposed");
assert.equal(typeof windowStub.utools.isWindows, "function", "utools.isWindows should be exposed");
assert.equal(typeof windowStub.utools.isLinux, "function", "utools.isLinux should be exposed");
assert.equal(windowStub.utools.isMacOS(), false, "Windows navigator should not be reported as macOS");
assert.equal(windowStub.utools.isWindows(), true, "Windows navigator should be reported as Windows");
assert.equal(windowStub.utools.isLinux(), false, "Windows navigator should not be reported as Linux");

assert.equal(typeof windowStub.utools.getFileIcon, "function", "utools.getFileIcon should be exposed");
const fileIcon = windowStub.utools.getFileIcon(".txt");
assert.match(fileIcon, /^data:image\/svg\+xml;charset=UTF-8,/, "getFileIcon should return a stable data URL fallback");
assert.ok(decodeURIComponent(fileIcon).includes(".TXT"), "file icon fallback should include the requested extension label");

assert.equal(typeof windowStub.utools.shellTrashItem, "function", "utools.shellTrashItem should be exposed");
const trashPromise = windowStub.utools.shellTrashItem("/tmp/delete-me.txt");
const trashCall = postedMessages.find((message) => message.method === "shellTrashItem");
assert.ok(trashCall, "shellTrashItem should route through the native bridge");
assert.deepEqual(plain(trashCall.args), { path: "/tmp/delete-me.txt" });
respondToNativeCall(trashCall, {
  error: "shellTrashItem unsupported: moving files to trash is not available in the current WebView host",
});
await assert.rejects(trashPromise, /shellTrashItem unsupported/);

assert.equal(typeof windowStub.utools.shellBeep, "function", "utools.shellBeep should be exposed");
const beepPromise = windowStub.utools.shellBeep();
const beepCall = postedMessages.find((message) => message.method === "shellBeep");
assert.ok(beepCall, "shellBeep should route through the native bridge");
assert.deepEqual(plain(beepCall.args), {});
respondToNativeCall(beepCall, { result: true });
assert.equal(await beepPromise, true, "shellBeep should resolve the native bridge result");

assert.match(componentSource, /function _fileIconDataUrl\(/, "bridge should keep the file icon fallback in one helper");
assert.match(componentSource, /getFileIcon:\s*function\(filePath\)/, "utools.getFileIcon should be in the bridge object");
assert.match(componentSource, /shellTrashItem:\s*function\(path\)/, "utools.shellTrashItem should be in the bridge object");
assert.match(componentSource, /shellBeep:\s*function\(\)/, "utools.shellBeep should be in the bridge object");
assert.match(componentSource, /shellTrashAppleScript/, "PluginPanel should use the shared shellTrashAppleScript helper");
assert.match(componentSource, /normalizeShellTrashPath/, "PluginPanel should validate shellTrashItem paths");
assert.match(componentSource, /case "shellTrashItem":/, "host should handle shellTrashItem natively");
assert.match(componentSource, /case "shellBeep":/, "host should handle shellBeep natively");
assert.doesNotMatch(componentSource, /shellTrashItem unsupported/, "shellTrashItem should move items to Trash instead of returning unsupported");
assert.match(capabilitySource, /"getFileIcon"/, "shared capability inventory should include getFileIcon");
assert.match(capabilitySource, /"shellTrashItem"/, "shared capability inventory should include shellTrashItem");
assert.match(capabilitySource, /"shellBeep"/, "shared capability inventory should include shellBeep");
assert.match(capabilitySource, /"isMacOS"/, "shared capability inventory should include isMacOS");
assert.match(capabilitySource, /"isWindows"/, "shared capability inventory should include isWindows");
