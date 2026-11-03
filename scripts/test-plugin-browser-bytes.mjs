import { assertInitialHostedIpcRegistration } from "./lib/hosted-ipc-fixture-assertions.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { injectPluginBridgeFactories } from "./lib/plugin-bridge-fixture.mjs";

const source = await readFile(new URL("../src/components/PluginPanel.svelte", import.meta.url), "utf8");
const template = source.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/)?.[1];
assert.ok(template, "Actual production plugin bridge must be available");
const bridge = (await injectPluginBridgeFactories(template))
  .replace(/__ACTION_PAYLOAD__/g, "null")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("browser-byte-fixture"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("bytes"))
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "").replace(/\s*<\/script>\s*$/, "");
const calls = [], timers = [], listeners = new Map();
const frame = { parent: { postMessage: value => calls.push(value) }, top: {},
  addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type),
  dispatchEvent() {}, matchMedia: () => ({ matches: false }) };
const context = vm.createContext({ window: frame, document: { readyState: "complete", addEventListener() {} },
  navigator: { platform: "MacIntel" }, Event: class { constructor(type) { this.type = type; } },
  TextEncoder, TextDecoder, btoa, atob, console,
  setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
});
vm.runInContext(bridge, context);
assertInitialHostedIpcRegistration(calls);
calls.length = 0; // Subsequent synchronous operations must still make zero business requests.
const installationTimers = timers.length;
const LocalBuffer = frame.Buffer;
assert.equal(LocalBuffer.from("ATools 中文🙂").toString("base64"), Buffer.from("ATools 中文🙂").toString("base64"));
assert.equal(LocalBuffer.from("AP//", "base64").toString("hex"), "00ffff");
assert.equal(frame.require("buffer").Buffer, LocalBuffer);
assert.equal(frame.require("node:buffer").Buffer, LocalBuffer);
assert.equal(LocalBuffer.isBuffer(new Uint8Array(1)), false);
assert.equal(frame.utools.getPathForFile(new File(["pixel"], "red.png", { type: "image/png" })), "");
for (const value of [undefined, null, {}, { name: "red.png" }, { path: "red.png" }, { path: "../red.png" }, { path: "/tmp/" + String.fromCharCode(0) + "red.png" }]) {
  assert.equal(frame.utools.getPathForFile(value), "");
}
for (const value of ["/private/tmp/red.png", "C:\\private\\red.png", "\\\\server\\share\\red.png"]) {
  assert.equal(frame.utools.getPathForFile({ path: value }), value);
}
assert.deepEqual(calls, [], "Pure browser byte/path helpers must not request host authority");
assert.equal(timers.length, installationTimers, "Pure byte operations must not add polling or timers");
console.log("Production browser byte/path bridge passed: real encoding factory, local require aliases, named File fallback, absolute metadata only, no host calls or timers");
