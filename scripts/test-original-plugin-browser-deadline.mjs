import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { CdpClient } from "./chrome-cdp-smoke-utils.mjs";
import { boundedOriginalCdp, createOriginalPageTarget, navigateOriginalPage } from "./lib/original-plugin-browser-deadline.mjs";
import { originalBrowserControls } from "./lib/original-plugin-browser-cdp.mjs";
import { observeOriginalFrameSessions } from "./lib/original-plugin-browser-frames.mjs";
import { connectOriginalCdpSocket, originalServerFrame } from "./lib/original-plugin-browser-websocket.mjs";

function serverTextFrame(payloadLength) {
  const extended = payloadLength < 126 ? 0 : payloadLength <= 65535 ? 2 : 8;
  const headerLength = 2 + extended, frame = Buffer.alloc(headerLength + payloadLength, 0x61);
  frame[0] = 0x81;
  if (extended === 0) frame[1] = payloadLength;
  else if (extended === 2) { frame[1] = 126; frame.writeUInt16BE(payloadLength, 2); }
  else { frame[1] = 127; frame.writeBigUInt64BE(BigInt(payloadLength), 2); }
  return { frame, headerLength };
}

function silentWire({ respond } = {}) {
  const socket = new EventEmitter(); socket.destroyed = false;
  socket.end = () => {}; socket.destroy = () => { socket.destroyed = true; queueMicrotask(() => socket.emit("close")); };
  const messages = []; let receive;
  const ws = { socket, onMessage(callback) { receive = callback; }, sendJson(message) {
    messages.push(message); if (respond?.(message)) queueMicrotask(() => receive(JSON.stringify({ id: message.id, result: {} })));
  } };
  const raw = new CdpClient(ws);
  return { raw, socket, messages, emit(method, params) { receive(JSON.stringify({ method, params })); } };
}
test("real CdpClient silent first key command is bounded and removes its actual pending entry", async () => {
  const wire = silentWire(), page = boundedOriginalCdp(wire.raw, { commandMs: 20, totalMs: 500, closeMs: 10 });
  const controls = originalBrowserControls(page, { inputs: [] }); const started = Date.now();
  await assert.rejects(controls.key("a", "KeyA", 65, 4), /Timed out running CDP command Input.dispatchKeyEvent/);
  assert.ok(Date.now() - started < 200); assert.equal(wire.raw.pending.size, 0); assert.equal(wire.messages.length, 1);
  await page.close(); assert.equal(wire.socket.destroyed, true); assert.equal(page.state.socketCloseForced, true);
});
test("total deadline cancels a live send and an event wait, with no pending callbacks after socket close", async () => {
  const wire = silentWire(), page = boundedOriginalCdp(wire.raw, { totalMs: 25, commandMs: 200, closeMs: 5 });
  const send = page.send("Page.navigate"), event = page.waitForEvent("Page.domContentEventFired", 200);
  await Promise.all([assert.rejects(send, /total deadline/), assert.rejects(event, /total deadline/)]);
  assert.equal(wire.raw.pending.size, 0); assert.equal((wire.raw.eventHandlers.get("Page.domContentEventFired") || []).length, 0);
  await page.close(); assert.equal(page.state.totalDeadlineExceeded, true); assert.equal(page.state.eventWaitsAtClose, 0);
});
test("iframe cleanup remains bounded when disable auto-attach never replies and drains opening sessions", async () => {
  const wire = silentWire({ respond: message => message.method === "Target.setAutoAttach" && message.params.autoAttach });
  const page = boundedOriginalCdp(wire.raw, { totalMs: 500, commandMs: 20, closeMs: 5 });
  const report = { consoleIssues: [] }; const frames = await observeOriginalFrameSessions(page, report, () => {}, "void 0");
  wire.emit("Target.attachedToTarget", { sessionId: "silent-child", waitingForDebugger: true, targetInfo: { targetId: "child", type: "iframe", url: "about:srcdoc" } });
  const started = Date.now();
  await assert.rejects(frames.close(), /Timed out running CDP command Target.setAutoAttach/);
  assert.ok(Date.now() - started < 250); assert.equal(report.iframeTargets[0].state, "closed");
  await page.close(); assert.equal(wire.raw.pending.size, 0); assert.equal(page.state.pendingAtClose, 0);
});
test("cleanup has a separate finite budget and zero pending commands after a silent socket is destroyed", async () => {
  const wire = silentWire(), page = boundedOriginalCdp(wire.raw, { totalMs: 20, commandMs: 200, closeMs: 5 });
  await assert.rejects(page.send("Page.captureScreenshot"), /total deadline/);
  page.beginCleanup({ totalMs: 30, commandMs: 15 });
  await assert.rejects(page.send("Runtime.evaluate"), /Timed out/);
  await page.close(); assert.equal(page.state.pendingAtClose, 0); assert.equal(page.state.deadlineTimerCleared, true);
  const count = wire.messages.length; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(wire.messages.length, count);
});
test("silent HTTP target transaction is actually aborted and its promise settles", async () => {
  let active = false;
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    active = true; signal.addEventListener("abort", () => { active = false; reject(signal.reason); }, { once: true });
  });
  await assert.rejects(createOriginalPageTarget("ws://127.0.0.1:1234/devtools/browser/a", { timeoutMs: 15, fetchImpl }), /deadline/);
  assert.equal(active, false);
});
test("silent TCP handshake destroys the actual connecting socket and removes all handshake listeners", async () => {
  const socket = new EventEmitter(); socket.write = () => {}; socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; queueMicrotask(() => socket.emit("close")); };
  await assert.rejects(connectOriginalCdpSocket("ws://127.0.0.1:1234/devtools/page/a", { timeoutMs: 15, createConnectionImpl: () => socket }), /deadline/);
  assert.equal(socket.destroyed, true); assert.equal(socket.listenerCount("data"), 0); assert.equal(socket.listenerCount("connect"), 0);
});
test("wire parser rejects masked server frames and excessive 64-bit payloads before buffering them", () => {
  assert.throws(() => originalServerFrame(Buffer.from([0x81, 0x80])), /unmasked/);
  const large = Buffer.alloc(10); large[0] = 0x81; large[1] = 127; large.writeBigUInt64BE(17000000n, 2);
  assert.throws(() => originalServerFrame(large), /budget/);
  assert.equal(originalServerFrame(Buffer.from([0x81, 3, 97])), null);
});
test("wire parser decodes payload lengths at every 7/16/64-bit boundary", () => {
  for (const payloadLength of [125, 126, 127, 128, 65535, 65536]) {
    const { frame } = serverTextFrame(payloadLength);
    const parsed = originalServerFrame(frame);
    assert.ok(parsed, `expected complete ${payloadLength}-byte server frame`);
    assert.equal(parsed.opcode, 1);
    assert.equal(parsed.payload.length, payloadLength);
    assert.equal(parsed.bytes, frame.length);
  }
});
test("wire parser waits for incomplete short, 16-bit, and 64-bit headers and payloads", () => {
  for (const payloadLength of [125, 126, 127, 128, 65535, 65536]) {
    const { frame, headerLength } = serverTextFrame(payloadLength);
    assert.equal(originalServerFrame(frame.subarray(0, headerLength - 1)), null, `partial header ${payloadLength}`);
    assert.equal(originalServerFrame(frame.subarray(0, headerLength)), null, `missing payload ${payloadLength}`);
    assert.equal(originalServerFrame(frame.subarray(0, frame.length - 1)), null, `partial payload ${payloadLength}`);
  }
});
test("runtime navigation jointly consumes silent command/event failure without orphan rejection", async () => {
  const wire = silentWire(), page = boundedOriginalCdp(wire.raw, { totalMs: 25, commandMs: 200, closeMs: 5 });
  const orphan = [], observe = error => orphan.push(error);
  process.on("unhandledRejection", observe);
  try {
    await assert.rejects(navigateOriginalPage(page, "about:blank"), /total deadline/);
    page.beginCleanup({ totalMs: 50, commandMs: 20 }); await page.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(orphan, []); assert.equal(wire.raw.pending.size, 0); assert.equal(wire.raw.eventHandlers.size, 0);
  } finally { process.off("unhandledRejection", observe); await page.close(); }
});
