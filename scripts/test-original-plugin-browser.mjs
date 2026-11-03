import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parseOriginalBrowserArgs } from "./probe-original-plugin-business-browser.mjs";
import { assertExpectedRows, assertTrustedEvents, subnetExpected } from "./lib/original-plugin-browser-scenarios.mjs";
import { allowedOriginalBrowserUrl } from "./lib/original-plugin-browser-runtime.mjs";
import { captureOriginalPackages } from "./lib/original-plugin-browser-sources.mjs";
import { OriginalFrameSession } from "./lib/original-plugin-browser-frames.mjs";
import { assertOriginalImageCanvas } from "./lib/original-plugin-browser-image.mjs";
import { originalImagePngBase64 } from "../tests/components/originalPluginBrowserImageFixture.ts";
import { inflateSync } from "node:zlib";

test("rejects repository overwrite, missing/unknown arguments and non-JSON output", () => {
  for (const args of [[], ["x", "y"], ["--unknown"], ["/private/tmp/report.txt"], ["scripts/report.json"]]) assert.throws(() => parseOriginalBrowserArgs(args));
  assert.equal(parseOriginalBrowserArgs(["--validate-only", "/private/tmp/atools-original-new.json"]).validateOnly, true);
});
test("pins all bytes and empty directories of three unchanged original packages", async () => {
  const packages = await captureOriginalPackages(resolve("."));
  assert.deepEqual(packages.map(item => [item.id, item.fileCount]), [["subnet-calculator", 4], ["uuid-kit", 12], ["image-stitch", 5]]);
});
test("row oracle rejects wrong numeric result, missing row and duplicate expected label", () => {
  const rows = Object.entries(subnetExpected.ordinary).map(([label, value]) => ({ label, value }));
  assertExpectedRows(rows, subnetExpected.ordinary);
  assert.throws(() => assertExpectedRows(rows.slice(1), subnetExpected.ordinary));
  assert.throws(() => assertExpectedRows([{ label: rows[0].label, value: "wrong" }, ...rows.slice(1)], subnetExpected.ordinary));
  assert.throws(() => assertExpectedRows([rows[1], ...rows.slice(1)], subnetExpected.ordinary));
});
test("event proof rejects untrusted synthesis, missing control and missing event stage", () => {
  const types = ["pointerdown", "keydown", "beforeinput", "input"];
  const events = types.map(type => ({ type, trusted: true, target: "ipInput" }));
  assertTrustedEvents(events, "ipInput", types);
  assert.throws(() => assertTrustedEvents(events.map(item => ({ ...item, trusted: false })), "ipInput", types));
  assert.throws(() => assertTrustedEvents(events.slice(1), "ipInput", types));
  assert.throws(() => assertTrustedEvents(events, "maskInput", types));
});
test("network boundary rejects non-owned ports, external origins and file URLs", () => {
  assert.equal(allowedOriginalBrowserUrl("http://127.0.0.1:15134/a", 15134), true);
  assert.equal(allowedOriginalBrowserUrl("ws://127.0.0.1:15134/", 15134), true);
  for (const url of ["https://example.com/a", "http://127.0.0.1:15135/a", "file:///tmp/a", "http://localhost:15134/a"]) assert.equal(allowedOriginalBrowserUrl(url, 15134), false);
});
function fakeParent() {
  const handlers = new Map(), sent = [];
  return { sent, on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    send(method, params) { sent.push({ method, params }); return Promise.resolve({}); },
    receive(sessionId, message) { for (const handler of handlers.get("Target.receivedMessageFromTarget") || []) handler({ sessionId, message: JSON.stringify(message) }); } };
}
test("opaque iframe transport separates sessions and propagates CDP error replies", async () => {
  const parent = fakeParent(), session = new OriginalFrameSession(parent, "owned");
  const pending = session.send("Runtime.evaluate", { expression: "document.URL" });
  parent.receive("other", { id: 1, result: { wrong: true } });
  assert.equal(session.pending.size, 1);
  parent.receive("owned", { id: 1, result: { value: "about:srcdoc" } });
  assert.deepEqual(await pending, { value: "about:srcdoc" });
  const failed = session.send("Runtime.evaluate");
  parent.receive("owned", { id: 2, error: { message: "Document gone" } });
  await assert.rejects(failed, /Document gone/); session.invalidate();
});
test("opaque iframe detach clears document identities and rejects pending commands", async () => {
  const session = new OriginalFrameSession(fakeParent(), "owned"); let cleared = false;
  session.on("Runtime.executionContextsCleared", () => { cleared = true; });
  const pending = session.send("Runtime.evaluate"); session.invalidate();
  await assert.rejects(pending, /target detached/); assert.equal(cleared, true); assert.equal(session.pending.size, 0);
  assert.throws(() => session.send("Runtime.evaluate"), /already closed/);
});
test("opaque iframe command timeout releases its pending command", async () => {
  const session = new OriginalFrameSession(fakeParent(), "owned");
  await assert.rejects(session.send("Runtime.evaluate", {}, { timeoutMs: 15 }), /timeout/);
  assert.equal(session.pending.size, 0); session.invalidate();
});
test("image fixture independently decodes as 32×16 RGBA with red left and green right", () => {
  const png = Buffer.from(originalImagePngBase64, "base64"); assert.equal(png.readUInt32BE(16), 32); assert.equal(png.readUInt32BE(20), 16);
  assert.equal(png[24], 8); assert.equal(png[25], 6); const parts = [];
  for (let at = 8; at < png.length;) { const size = png.readUInt32BE(at); if (png.toString("ascii", at + 4, at + 8) === "IDAT") parts.push(png.subarray(at + 8, at + 8 + size)); at += size + 12; }
  const raw = inflateSync(Buffer.concat(parts)); assert.equal(raw.length, 16 * 129);
  for (let y = 0; y < 16; y++) { assert.equal(raw[y * 129], 0); for (let x = 0; x < 32; x++) assert.deepEqual([...raw.subarray(y * 129 + 1 + x * 4, y * 129 + 5 + x * 4)], x < 16 ? [255, 0, 0, 255] : [0, 255, 0, 255]); }
});
test("original image canvas oracle rejects lost alpha, wrong size and missing source image", () => {
  const correct = { visible: true, width: 32, height: 16, imageCount: 1, placeholderVisible: false, left: [255, 0, 0, 255], right: [0, 255, 0, 255], labels: ["粘贴图片 (32×16)"] };
  assertOriginalImageCanvas(correct);
  for (const patch of [{ width: 64 }, { imageCount: 0 }, { left: [255, 0, 0, 0] }, { placeholderVisible: true }]) assert.throws(() => assertOriginalImageCanvas({ ...correct, ...patch }));
});
