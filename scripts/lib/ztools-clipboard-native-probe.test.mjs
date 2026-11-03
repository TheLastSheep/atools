import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(
  new URL("../../src-tauri/src/renderer_desktop_smoke/clipboard_context_journey/probe.js", import.meta.url),
  "utf8",
);
const token = "0123456789abcdef0123456789abcdef";
const runId = "abcdef0123456789abcdef0123456789";
const fixtureText = "  ATools R62 private clipboard text \n";
const fixtureFileName = "atools-r62-private-clipboard.txt";
const nativeCalls = [];
const returnValue = Object.freeze({ preserved: true });
let getterCalls = 0;
let updateCalls = 0;
const originalGetter = async () => {
  getterCalls += 1;
  return null;
};
const originalUpdate = function () {
  updateCalls += 1;
  return returnValue;
};
const input = { value: "", selectionStart: 0, selectionEnd: 0 };
const document = {
  documentElement: null,
  visibilityState: "visible",
  hasFocus: () => true,
  querySelector(selector) {
    return selector === "input.search-input" && this.documentElement ? input : null;
  },
  querySelectorAll(selector) {
    return selector === "input.search-input" && this.documentElement ? [input] : [];
  },
};
const core = {
  async invoke(command, args) {
    nativeCalls.push({ command, args });
    return undefined;
  },
};
const window = { __TAURI__: { core } };
const injected = source
  .replace('"__ATOOLS_CLIPBOARD_TOKEN__"', JSON.stringify(token))
  .replace('"__ATOOLS_CLIPBOARD_RUN_ID__"', JSON.stringify(runId))
  .replace("__ATOOLS_CLIPBOARD_PID__", "4217")
  .replace('"__ATOOLS_CLIPBOARD_FIXTURE_TEXT__"', JSON.stringify(fixtureText))
  .replace('"__ATOOLS_CLIPBOARD_FIXTURE_FILE_NAME__"', JSON.stringify(fixtureFileName));

runInNewContext(injected, { window, document, setTimeout, clearTimeout, Promise, Date });
setTimeout(() => {
  window.ztools = {
    getLastCopiedContent: originalGetter,
    updateLaunchContext: originalUpdate,
  };
  window.__ATOOLS_ZTOOLS_HOST_ADAPTER__ = { snapshot: () => ({ outstandingNativeCalls: 0 }) };
  document.documentElement = {};
}, 30);

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

assert.equal(await waitFor(() => nativeCalls.length === 1), true, "ready probe should arrive");
const readyCall = nativeCalls[0];
assert.equal(readyCall.command, "renderer_clipboard_context_probe");
assert.equal(readyCall.args.operation, undefined);
const ready = readyCall.args.evidence;
const observerInstalled = window.ztools.updateLaunchContext !== originalUpdate;
const getterPreserved = window.ztools.getLastCopiedContent === originalGetter;
const updateResult = window.ztools.updateLaunchContext({
  searchQuery: "safe fixture query",
  pastedImage: null,
  pastedFiles: null,
  pastedText: null,
});
const probeApi = window.__ATOOLS_CLIPBOARD_CONTEXT_PROBE__;
assert.equal(typeof probeApi?.run, "function");
assert.equal(await probeApi.run("dispose", 1), true);
assert.equal(window.ztools.updateLaunchContext, originalUpdate);
assert.equal(window.ztools.getLastCopiedContent, originalGetter);
assert.equal(window.__ATOOLS_CLIPBOARD_CONTEXT_PROBE__, undefined);
const disposeCall = nativeCalls[1];

assert.deepEqual({
  searchInputCount: ready.searchInputCount,
  clipboardGetterAvailable: ready.clipboardGetterAvailable,
  adapterOutstandingNativeCalls: ready.adapterOutstandingNativeCalls,
  observerInstalled,
  getterPreserved,
  updateCalls,
  updateResultPreserved: updateResult === returnValue,
  getterCalls,
  disposeOperation: disposeCall.args.evidence.operation,
  disposeOutstanding: disposeCall.args.evidence.adapterOutstandingNativeCalls,
}, {
  searchInputCount: 1,
  clipboardGetterAvailable: true,
  adapterOutstandingNativeCalls: 0,
  observerInstalled: true,
  getterPreserved: true,
  updateCalls: 1,
  updateResultPreserved: true,
  getterCalls: 0,
  disposeOperation: "dispose",
  disposeOutstanding: 0,
});

console.log("clipboard native probe delayed-ready regression passed");
