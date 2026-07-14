import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [componentSource, capabilitySource, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

const bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("copied-files-shape-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("copied-files-shape-test-feature"))
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

assert.equal(typeof windowStub.utools.getCopyedFiles, "function", "getCopyedFiles should be exposed");
assert.equal(typeof windowStub.utools.getCopiedFiles, "function", "getCopiedFiles alias should be exposed");

const copiedFilesPromise = windowStub.utools.getCopyedFiles();
const copiedFilesCall = postedMessages.find((message) => message.method === "getCopyedFiles");
assert.ok(copiedFilesCall, "getCopyedFiles should route through the native bridge");
respondToNativeCall(copiedFilesCall, {
  result: ["/tmp/example.txt", "/tmp/folder/"],
});

assert.deepEqual(plain(await copiedFilesPromise), [
  {
    path: "/tmp/example.txt",
    name: "example.txt",
    isFile: true,
    isDiractory: false,
  },
  {
    path: "/tmp/folder/",
    name: "folder",
    isFile: false,
    isDiractory: true,
  },
]);

const copiedAliasPromise = windowStub.utools.getCopiedFiles();
const copiedAliasCall = postedMessages.findLast((message) => message.method === "getCopyedFiles");
assert.ok(copiedAliasCall, "getCopiedFiles should use the uTools getCopyedFiles bridge method");
respondToNativeCall(copiedAliasCall, {
  result: [
    {
      path: "/Applications/ATools.app",
      name: "ATools.app",
      isFile: false,
      isDiractory: true,
      extra: "preserve-me",
    },
    {
      path: "/Users/harris/Desktop/readme.md",
      isDiractory: false,
    },
  ],
});

assert.deepEqual(plain(await copiedAliasPromise), [
  {
    path: "/Applications/ATools.app",
    name: "ATools.app",
    isFile: false,
    isDiractory: true,
    extra: "preserve-me",
  },
  {
    path: "/Users/harris/Desktop/readme.md",
    isDiractory: false,
    name: "readme.md",
    isFile: true,
  },
]);

assert.match(componentSource, /function _normalizeCopiedFiles\(files\)/, "bridge should normalize copied-file results in one helper");
assert.match(componentSource, /getCopyedFiles:\s*function\(\)\s*\{\s*return _nativeCall\('getCopyedFiles'\)\.then\(_normalizeCopiedFiles\);/);
assert.match(componentSource, /getCopiedFiles:\s*function\(\)\s*\{\s*return _nativeCall\('getCopyedFiles'\)\.then\(_normalizeCopiedFiles\);/);
assert.match(componentSource, /normalizeCopiedFileEntries\(.*output\.split/s, "host should return CopiedFile-shaped entries when it only receives paths");
assert.match(capabilitySource, /"getCopyedFiles"/, "shared capability inventory should include the uTools typo method");
assert.match(capabilitySource, /"getCopiedFiles"/, "shared capability inventory should include the corrected alias");

const copiedFilesChecklistLine = smokeChecklist
  .split("\n")
  .find((line) => line.includes("插件调用 `getCopyedFiles` / `getCopiedFiles` 时"));
assert.ok(copiedFilesChecklistLine, "macOS smoke checklist should include copied-files object shape row");
assert.match(
  copiedFilesChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark copied-files object shape row complete",
);
[
  "`getCopyedFiles`",
  "`getCopiedFiles`",
  "`CopiedFile[]`",
  "`path`",
  "`name`",
  "`isFile`",
  "`isDiractory`",
].forEach((token) => {
  assert.ok(copiedFilesChecklistLine.includes(token), `copied-files object shape row should mention ${token}`);
});
