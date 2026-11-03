import { injectPluginBridgeFactories } from "./lib/plugin-bridge-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget } from "typescript";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");
const electronAdapterUrl = new URL("src/lib/pluginElectronAdapter.ts", root);
const electronAdapterSource = await readFile(electronAdapterUrl, "utf8");
const compiledElectronAdapter = await transformWithEsbuild(electronAdapterSource, electronAdapterUrl.pathname, {
  format: "esm", target: "esnext", loader: "ts",
});
const { pluginElectronAdapterScript } = await import(
  "data:text/javascript;base64," + Buffer.from(compiledElectronAdapter.code).toString("base64")
);
let shellBridgeSource = "";
try {
  shellBridgeSource = await readFile(new URL("src/lib/pluginSystemShellBridge.ts", root), "utf8");
} catch {
  shellBridgeSource = "";
}
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-system-shell-bridge-"));
const shellBridgeOutFile = join(outDir, "pluginSystemShellBridge.mjs");
let shellBridge;

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
  shellBridge = await import(pathToFileURL(shellBridgeOutFile).href);

  assert.equal(typeof shellBridge.shellTrashAppleScript, "function", "shellTrashAppleScript should be exported");
  assert.equal(typeof shellBridge.normalizeShellTrashPath, "function", "normalizeShellTrashPath should be exported");
  assert.equal(typeof shellBridge.validateShellFilePath, "function", "the native OS boundary must share strict validation");
  assert.throws(() => shellBridge.normalizeShellTrashPath("  /tmp/delete-me.txt  "), /requires an absolute file path/);
  assert.equal(shellBridge.normalizeShellTrashPath("/tmp/文件名 "), "/tmp/文件名 ");
  assert.throws(() => shellBridge.normalizeShellTrashPath(""), /shellTrashItem requires a file path/);
  assert.throws(() => shellBridge.normalizeShellTrashPath("   "), /shellTrashItem requires a file path/);
  for (const invalid of [null, undefined, 12, {}, []]) {
    assert.throws(() => shellBridge.normalizeShellTrashPath(invalid), /shellTrashItem requires a file path/);
  }
  assert.throws(() => shellBridge.normalizeShellTrashPath("/tmp/bad\0file"), /without NUL/);
  assert.throws(() => shellBridge.shellTrashAppleScript("/tmp/bad\0file"), /without NUL/);
  for (const method of ["shellShowItemInFolder", "shellTrashItem"]) {
    for (const path of ["/tmp/文件名 ", "C:\\temporary\\file.txt", "D:/temporary/file.txt", "\\\\server\\share\\file.txt", "/" + "a".repeat(8191)]) {
      assert.equal(shellBridge.validateShellFilePath(path, method), path, "valid targets must retain every original character");
    }
    for (const path of [undefined, null, {}, [], 3, "", "   ", "relative.txt", "C:relative.txt", "file:///tmp/file", "/tmp/bad\0file", "/" + "a".repeat(8192)]) {
      assert.throws(() => shellBridge.validateShellFilePath(path, method), new RegExp(method + " requires"));
    }
  }
  assert.equal(
    shellBridge.shellTrashAppleScript("/tmp/原名 "),
    'tell application "Finder" to delete POSIX file "/tmp/原名 "',
  );
  assert.equal(
    shellBridge.shellTrashAppleScript('/tmp/delete "me" \\\\ file.txt'),
    'tell application "Finder" to delete POSIX file "/tmp/delete \\"me\\" \\\\\\\\ file.txt"',
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");
const bridgeTemplate = await injectPluginBridgeFactories(bridgeMatch[1]);

const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
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
assert.match(componentSource, /import \{ validateShellFilePath, shellTrashAppleScript \} from "\.\.\/lib\/pluginSystemShellBridge"/,
  "both real native shell cases must import the host validator");
assert.match(componentSource, /case "shellShowItemInFolder": \{\s*const path = validateShellFilePath\(pathFromBridgeValue\(args\.path\), "shellShowItemInFolder"\);\s*await runCommand\("open", \["-R", path\], "shellShowItemInFolder"\);/,
  "reveal must validate the target before the production OS command");
assert.match(componentSource, /case "shellTrashItem": \{\s*const path = validateShellFilePath\(pathFromBridgeValue\(args\.path\), "shellTrashItem"\);\s*await runAppleScript\(shellTrashAppleScript\(path\), "shellTrashItem"\);/,
  "trash must validate the target before creating or running the OS command");
assert.match(componentSource, /case "shellTrashItem":/, "host should handle shellTrashItem natively");
assert.match(componentSource, /case "shellBeep":/, "host should handle shellBeep natively");
assert.doesNotMatch(componentSource, /shellTrashItem unsupported/, "shellTrashItem should move items to Trash instead of returning unsupported");
assert.match(capabilitySource, /"getFileIcon"/, "shared capability inventory should include getFileIcon");
assert.match(capabilitySource, /"shellTrashItem"/, "shared capability inventory should include shellTrashItem");
assert.match(capabilitySource, /"shellBeep"/, "shared capability inventory should include shellBeep");
assert.match(capabilitySource, /"isMacOS"/, "shared capability inventory should include isMacOS");
assert.match(capabilitySource, /"isWindows"/, "shared capability inventory should include isWindows");

// Execute the actual production native method and argument extraction functions
// with the real validator and inert OS sinks. No frontend wrapper can satisfy this.
const componentScript = componentSource.slice(componentSource.indexOf(">") + 1, componentSource.lastIndexOf("</script>"));
const componentAst = createSourceFile("PluginPanel.ts", componentScript, ScriptTarget.Latest, true, ScriptKind.TS);
assert.equal(componentAst.parseDiagnostics.length, 0, "native boundary fixture must parse the production script");
function productionFunction(name) {
  const declarations = componentAst.statements.filter((node) => isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(declarations.length, 1, "expected one production function: " + name);
  return declarations[0].getText(componentAst);
}
const nativeBoundarySource = await transformWithEsbuild(
  productionFunction("pathFromBridgeValue") + "\n" + productionFunction("handleNativeBridgeMethod") +
    "\nglobalThis.shellNativeBoundary = handleNativeBridgeMethod;",
  "PluginPanel-native-shell-boundary.ts", { format: "iife", target: "esnext", loader: "ts" },
);
const osCalls = [];
const nativeContext = vm.createContext({
  validateShellFilePath: shellBridge.validateShellFilePath,
  shellTrashAppleScript: shellBridge.shellTrashAppleScript,
  async runCommand(program, args, label) { osCalls.push({ program, args, label }); },
  async runAppleScript(script, label) { osCalls.push({ script, label }); },
});
vm.runInContext(nativeBoundarySource.code, nativeContext);
const nativeBoundary = nativeContext.shellNativeBoundary;
for (const method of ["shellShowItemInFolder", "shellTrashItem"]) {
  for (const path of ["", "   ", "relative.txt", "C:relative.txt", "file:///tmp/file", "/tmp/bad\0file", "/" + "a".repeat(8192)]) {
    const callCount = osCalls.length;
    await assert.rejects(nativeBoundary(method, { path }), new RegExp(method + " requires"));
    assert.equal(osCalls.length, callCount, "invalid direct native args must fail before reaching the OS sink");
  }
}
assert.equal(await nativeBoundary("shellShowItemInFolder", { path: "/tmp/原名 " }), null);
assert.deepEqual(plain(osCalls.pop()), { program: "open", args: ["-R", "/tmp/原名 "], label: "shellShowItemInFolder" });
assert.equal(await nativeBoundary("shellTrashItem", { path: "/tmp/原名 " }), null);
assert.deepEqual(plain(osCalls.pop()), { script: 'tell application "Finder" to delete POSIX file "/tmp/原名 "', label: "shellTrashItem" });

// Exercise the emitted Electron adapter above the actual production permission
// and native-message bridge. The parent is a fake; no OS operation is executed.
const shellListeners = new Map(), shellMessages = [], shellErrors = [];
const shellConsole = { error(...args) { shellErrors.push(args); }, warn() {}, log() {} };
const shellWindow = {
  ...windowStub,
  console: shellConsole,
  parent: { postMessage(message) { shellMessages.push(message); } },
  addEventListener(type, handler) {
    const handlers = shellListeners.get(type) || [];
    handlers.push(handler);
    shellListeners.set(type, handlers);
  },
  dispatchEvent(event) { (shellListeners.get(event.type) || []).forEach((handler) => handler(event)); },
};
// Do not reuse the previously initialized bridge state or its local require.
delete shellWindow.utools;
delete shellWindow.ztools;
delete shellWindow.require;
const shellContext = vm.createContext({
  window: shellWindow, document: documentStub,
  navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0" },
  Event: EventStub, console: shellConsole, Date, Math, Number, Promise,
  decodeURIComponent, encodeURIComponent, setTimeout, clearTimeout,
});
assert.ok(bridgeSource.includes("var _atoolsPluginPermissions = null;"), "permission fixture must bind the real bridge declaration");
vm.runInContext(bridgeSource.replace("var _atoolsPluginPermissions = null;", "var _atoolsPluginPermissions = [];"), shellContext);
vm.runInContext(pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, ""), shellContext);
const electronShell = shellWindow.require("electron").shell;
const shellSettle = () => new Promise((resolve) => setTimeout(resolve, 0));
function shellRespond(payload) {
  (shellListeners.get("message") || []).forEach((handler) => handler({ data: payload }));
}
const nativeMessages = (method) => shellMessages.filter((message) => message.__atools_native_call__ && message.method === method);
const permissionMessages = (permission) => shellMessages.filter((message) => message.__atools_permission_request__ && message.permission === permission);

assert.equal(electronShell.showItemInFolder("/tmp/reveal "), undefined, "Electron reveal has no completion value");
await shellSettle();
const deniedReveal = permissionMessages("shell.showItemInFolder")[0];
assert.ok(deniedReveal, "Electron reveal must request its existing exact permission");
assert.equal(nativeMessages("shellShowItemInFolder").length, 0, "permission must precede native execution");
shellRespond({ __atools_permission_response__: true, reqId: deniedReveal.reqId, allowed: false });
await shellSettle();
assert.equal(shellErrors.length, 1, "the void method must observe permission rejection");
assert.match(shellErrors[0][1].message, /Plugin permission denied: shell.showItemInFolder/);
shellRespond({ __atools_permission_response__: true, reqId: deniedReveal.reqId, allowed: true });
await shellSettle();
assert.equal(nativeMessages("shellShowItemInFolder").length, 0, "a late approval must not replay the denied reveal");

electronShell.showItemInFolder("/tmp/reveal ");
await shellSettle();
const approvedReveal = permissionMessages("shell.showItemInFolder")[1];
assert.ok(approvedReveal && approvedReveal.reqId !== deniedReveal.reqId, "only a new explicit call may request permission again");
shellRespond({ __atools_permission_response__: true, reqId: approvedReveal.reqId, allowed: true });
await shellSettle();
const revealNative = nativeMessages("shellShowItemInFolder")[0];
assert.ok(revealNative);
assert.deepEqual(plain(revealNative.args), { path: "/tmp/reveal " }, "reveal must preserve the original target");
shellRespond({ __atools_native_response__: true, reqId: revealNative.reqId, error: "OS reveal failed" });
await shellSettle();
assert.equal(shellErrors.length, 2);
assert.match(shellErrors[1][1].message, /OS reveal failed/);
assert.equal(nativeMessages("shellShowItemInFolder").length, 1, "native failure must not cause another reveal");

const deniedTrashPromise = electronShell.trashItem("/tmp/trash ");
const deniedTrashObserved = assert.rejects(deniedTrashPromise, /Plugin permission denied: shell.trashItem/);
await shellSettle();
const deniedTrash = permissionMessages("shell.trashItem")[0];
assert.ok(deniedTrash, "trash must use its separate exact permission");
assert.equal(nativeMessages("shellTrashItem").length, 0);
shellRespond({ __atools_permission_response__: true, reqId: deniedTrash.reqId, allowed: false });
await deniedTrashObserved;
shellRespond({ __atools_permission_response__: true, reqId: deniedTrash.reqId, allowed: true });
await shellSettle();
assert.equal(nativeMessages("shellTrashItem").length, 0, "a late approval must not replay denied trash");

const canceledTrashPromise = electronShell.trashItem("/tmp/trash ");
const canceledTrashObserved = assert.rejects(canceledTrashPromise, /Canceled by user/);
await shellSettle();
const approvedTrash = permissionMessages("shell.trashItem")[1];
shellRespond({ __atools_permission_response__: true, reqId: approvedTrash.reqId, allowed: true });
await shellSettle();
const trashNative = nativeMessages("shellTrashItem")[0];
assert.deepEqual(plain(trashNative.args), { path: "/tmp/trash " });
shellRespond({ __atools_native_response__: true, reqId: trashNative.reqId, error: "Canceled by user" });
await canceledTrashObserved;
await shellSettle();
assert.equal(nativeMessages("shellTrashItem").length, 1, "cancellation must not be swallowed or replayed");
assert.equal(shellErrors.length, 2, "trash rejection remains with the Promise caller");

const successfulTrashPromise = electronShell.trashItem("/tmp/trash ");
await shellSettle();
const finalTrash = nativeMessages("shellTrashItem")[1];
assert.ok(finalTrash, "a new explicit operation can use its current approved permission");
shellRespond({ __atools_native_response__: true, reqId: finalTrash.reqId, result: null });
assert.equal(await successfulTrashPromise, undefined, "trash only resolves when the native response resolves");
assert.equal(shellMessages.filter((message) => message.__ipc_invoke__ || message.cmd === "shell_open").length, 0,
  "the two methods must not fall back to an openPath command");

// Direct utools entry bypasses Electron validation. Carry its actual emitted args
// through the extracted production native handler and reply through the real bridge.
for (const method of ["shellShowItemInFolder", "shellTrashItem"]) {
  for (const path of ["relative.txt", "/tmp/bad\0file", "/" + "a".repeat(8192)]) {
    const previous = nativeMessages(method).length, osCallCount = osCalls.length;
    const directPromise = shellWindow.utools[method](path);
    const directRejection = assert.rejects(directPromise, new RegExp(method + " requires"));
    await shellSettle();
    const nativeMessage = nativeMessages(method)[previous];
    assert.ok(nativeMessage, "direct utools must send its existing native bridge message");
    let boundaryError;
    try { await nativeBoundary(nativeMessage.method, nativeMessage.args); }
    catch (error) { boundaryError = error; }
    assert.ok(boundaryError, "the actual native handler must reject the invalid direct utools path");
    shellRespond({ __atools_native_response__: true, reqId: nativeMessage.reqId, error: boundaryError.message });
    await directRejection;
    assert.equal(osCalls.length, osCallCount, "direct utools must not bypass host OS-boundary validation");
  }
}
