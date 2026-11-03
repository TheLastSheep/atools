import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";

const MAX_FRAME = 16 * 1024 * 1024;
export function originalClientFrame(opcode, payload) {
  const size = payload.length, extended = size < 126 ? 0 : size <= 65535 ? 2 : 8;
  const bytes = Buffer.alloc(2 + extended + 4 + size); bytes[0] = 0x80 | opcode;
  bytes[1] = 0x80 | (extended === 0 ? size : extended === 2 ? 126 : 127);
  if (extended === 2) bytes.writeUInt16BE(size, 2);
  if (extended === 8) bytes.writeBigUInt64BE(BigInt(size), 2);
  const mask = randomBytes(4); mask.copy(bytes, 2 + extended);
  for (let i = 0; i < size; i++) bytes[6 + extended + i] = payload[i] ^ mask[i % 4];
  return bytes;
}
export function originalServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0], second = buffer[1];
  assert.equal(second & 0x80, 0, "DevTools server frames must be unmasked");
  assert.equal(first & 0x70, 0, "Unsupported WebSocket extensions");
  let length = second & 127, offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) {
    if (buffer.length < 10) return null;
    const size = buffer.readBigUInt64BE(2); assert.ok(size <= BigInt(MAX_FRAME), "DevTools frame exceeds budget"); length = Number(size); offset = 10;
  }
  assert.ok(length <= MAX_FRAME, "DevTools frame exceeds budget");
  if (buffer.length < offset + length) return null;
  return { final: !!(first & 0x80), opcode: first & 15, payload: buffer.subarray(offset, offset + length), bytes: offset + length };
}

/** Owns the TCP socket even during connect/handshake failure; no abandoned connection promise. */
export async function connectOriginalCdpSocket(url, { timeoutMs = 10000, createConnectionImpl = createConnection } = {}) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "ws:"); assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
  assert.ok(timeoutMs > 0, "Positive DevTools connect budget required");
  const socket = createConnectionImpl({ host: parsed.hostname, port: Number(parsed.port) });
  try {
    const rest = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0), settled = false;
      const key = randomBytes(16).toString("base64");
      const timer = setTimeout(() => finish(Error("Original DevTools connect/handshake deadline exceeded")), timeoutMs);
      function finish(error, remainder) {
        if (settled) return; settled = true; clearTimeout(timer);
        socket.off("connect", connect); socket.off("data", data); socket.off("error", fail); socket.off("close", close);
        if (error) reject(error); else resolve(remainder);
      }
      const fail = error => finish(error), close = () => finish(Error("Original DevTools socket closed during handshake"));
      function connect() {
        socket.write([`GET ${parsed.pathname}${parsed.search} HTTP/1.1`, `Host: ${parsed.host}`, "Upgrade: websocket", "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
      }
      function data(chunk) {
        buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) { if (buffer.length > 16384) finish(Error("DevTools handshake header exceeds budget")); return; }
        try {
          const header = buffer.subarray(0, end).toString("utf8"); assert.match(header, /^HTTP\/1\.1 101 /);
          const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          assert.ok(header.split("\r\n").some(line => line.slice(0, line.indexOf(":" )).toLowerCase() === "sec-websocket-accept"
            && line.slice(line.indexOf(":" ) + 1).trim() === accept), "DevTools handshake proof differs");
          finish(null, buffer.subarray(end + 4));
        } catch (error) { finish(error); }
      }
      socket.once("connect", connect); socket.on("data", data); socket.once("error", fail); socket.once("close", close);
    });
    const handlers = [], backlog = []; let buffer = Buffer.alloc(0), fragments = [], fragmentBytes = 0;
    const emit = text => { if (!handlers.length) backlog.push(text); else handlers.forEach(handler => handler(text)); };
    function receive(chunk) {
      try {
        buffer = Buffer.concat([buffer, chunk]); assert.ok(buffer.length <= MAX_FRAME + 16, "DevTools frame buffer exceeds budget");
        let frame;
        while ((frame = originalServerFrame(buffer))) {
          buffer = buffer.subarray(frame.bytes);
          if (frame.opcode === 8) { socket.end(); continue; }
          if (frame.opcode === 9) { socket.write(originalClientFrame(10, frame.payload)); continue; }
          if (frame.opcode === 10) continue;
          assert.ok(frame.opcode === 1 || frame.opcode === 0, "DevTools must emit text/continuation frames");
          fragmentBytes += frame.payload.length; assert.ok(fragmentBytes <= MAX_FRAME, "DevTools message exceeds budget");
          fragments.push(frame.payload);
          if (frame.final) { emit(Buffer.concat(fragments).toString("utf8")); fragments = []; fragmentBytes = 0; }
        }
      } catch (error) { socket.destroy(error); }
    }
    socket.on("data", receive); socket.on("error", () => {});
    if (rest.length) receive(rest);
    return { socket, onMessage(handler) { handlers.push(handler); for (const text of backlog.splice(0)) handler(text); },
      sendJson(value) { assert.equal(socket.destroyed, false, "Original DevTools socket closed"); socket.write(originalClientFrame(1, Buffer.from(JSON.stringify(value)))); } };
  } catch (error) {
    // destroy() cancels the actual connect/handshake operation, rather than racing its promise.
    socket.destroy(); throw error;
  }
}
