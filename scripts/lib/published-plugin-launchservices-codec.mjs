import { TextDecoder } from "node:util";

export const TARGET_LOG_FRAME_PREFIX = "AToolsNativeTargetLogFrame ";
export const OBSERVER_READY_PREFIX = "AToolsNativeStdioReady ";
export const OBSERVER_LAUNCH_PREFIX = "AToolsNativeLaunchServicesEvent ";
export const OBSERVER_RESULT_PREFIX = "AToolsNativeLaunchServicesResult ";
export const TARGET_ENVIRONMENT_PREFIX = "AToolsNativeLaunchServicesEnvironment ";

const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
const MAX_TARGET_LOG_BYTES = 256 * 1024;

function parseJsonLine(line, prefix) {
  try {
    const value = JSON.parse(line.slice(prefix.length));
    return value && typeof value === "object" && !Array.isArray(value) ? value : { protocolError: "invalid-object-shape" };
  }
  catch { return { protocolError: "invalid-json" }; }
}

export function encodeTargetLogFrame(runId, sequence, bytes) {
  const buffer = Buffer.from(bytes);
  return `${TARGET_LOG_FRAME_PREFIX}${JSON.stringify({ runId, sequence, byteLength: buffer.length,
    bytesBase64: buffer.toString("base64") })}\n`;
}

/** Bounded, line-framed observer stream parser. Only observer stdout owns controls. */
export class LaunchServicesLogStream {
  constructor({ channel, runId, maxEncodedBytes }) {
    if (!["stdout", "stderr"].includes(channel) || typeof runId !== "string" || !runId
      || !Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes < 1) throw new Error("Invalid LaunchServices stream decoder configuration");
    this.channel = channel;
    this.runId = runId;
    this.maxEncodedBytes = maxEncodedBytes;
    this.encodedBytes = 0;
    this.pending = Buffer.alloc(0);
    this.targetPending = Buffer.alloc(0);
    this.targetChunks = [];
    this.targetByteLength = 0;
    this.targetFrameCount = 0;
    this.targetFrameEncodedBytes = 0;
    this.nextSequence = 0;
    this.ordinaryLines = [];
    this.errors = [];
    this.overflow = false;
    this.ended = false;
    this.readyEvent = null;
    this.launchEvent = null;
    this.resultEvent = null;
    this.environmentEvent = null;
  }

  push(chunk) {
    if (this.ended) { this.errors.push("stream-data-after-end"); return; }
    const bytes = Buffer.from(chunk);
    this.encodedBytes += bytes.length;
    if (this.encodedBytes > this.maxEncodedBytes) {
      this.overflow = true;
      this.errors.push("encoded-stream-byte-budget-exceeded");
      return;
    }
    this.pending = Buffer.concat([this.pending, bytes]);
    if (this.pending.length > MAX_PROTOCOL_LINE_BYTES && !this.pending.includes(0x0a)) {
      this.errors.push("unterminated-protocol-line-exceeds-limit");
      this.pending = Buffer.alloc(0);
      return;
    }
    let newline;
    while ((newline = this.pending.indexOf(0x0a)) >= 0) {
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.length > MAX_PROTOCOL_LINE_BYTES) { this.errors.push("protocol-line-exceeds-limit"); continue; }
      this.consumeLine(line);
    }
  }

  consumeLine(bytes) {
    let line;
    try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { this.errors.push("observer-stream-line-is-not-valid-utf8"); return; }
    if (line.startsWith(TARGET_LOG_FRAME_PREFIX)) {
      if (this.channel !== "stdout") { this.errors.push("target-log-frame-on-stderr"); return; }
      this.consumeTargetFrame(line);
      return;
    }
    if (this.channel === "stdout" && line.startsWith(OBSERVER_LAUNCH_PREFIX)) {
      if (!this.readyEvent) { this.errors.push("launch-event-before-stdio-reader-ready"); return; }
      if (this.launchEvent) { this.errors.push("duplicate-observer-launch-event"); return; }
      this.launchEvent = parseJsonLine(line, OBSERVER_LAUNCH_PREFIX);
      return;
    }
    if (this.channel === "stdout" && line.startsWith(OBSERVER_READY_PREFIX)) {
      if (this.readyEvent) { this.errors.push("duplicate-observer-stdio-ready-event"); return; }
      this.readyEvent = parseJsonLine(line, OBSERVER_READY_PREFIX);
      if (this.readyEvent.runId !== this.runId) this.errors.push("observer-stdio-ready-run-id-mismatch");
      return;
    }
    if (this.channel === "stdout" && line.startsWith(OBSERVER_RESULT_PREFIX)) {
      if (this.resultEvent) { this.errors.push("duplicate-observer-result-event"); return; }
      this.resultEvent = parseJsonLine(line, OBSERVER_RESULT_PREFIX);
      return;
    }
    if (line.startsWith(TARGET_ENVIRONMENT_PREFIX)) {
      this.errors.push(this.channel === "stdout" ? "environment-observation-outside-target-log-frame" : "target-environment-on-stderr");
      return;
    }
    this.ordinaryLines.push(line);
  }

  consumeTargetFrame(line) {
    if (this.channel !== "stdout") { this.errors.push("target-log-frame-on-stderr"); return; }
    let frame;
    try { frame = JSON.parse(line.slice(TARGET_LOG_FRAME_PREFIX.length)); }
    catch { this.errors.push("target-log-frame-invalid-json"); return; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || frame.runId !== this.runId || frame.sequence !== this.nextSequence
      || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 0
      || typeof frame.bytesBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.bytesBase64)) {
      this.errors.push("target-log-frame-identity-sequence-or-shape-invalid");
      return;
    }
    const payload = Buffer.from(frame.bytesBase64, "base64");
    if (payload.length !== frame.byteLength || payload.toString("base64") !== frame.bytesBase64) {
      this.errors.push("target-log-frame-byte-length-or-base64-invalid");
      return;
    }
    this.nextSequence += 1;
    this.targetFrameCount += 1;
    this.targetFrameEncodedBytes += Buffer.byteLength(line) + 1;
    this.targetByteLength += payload.length;
    if (this.targetByteLength > MAX_TARGET_LOG_BYTES) {
      this.overflow = true;
      this.errors.push("decoded-target-log-byte-budget-exceeded");
      return;
    }
    this.targetChunks.push(payload);
    this.targetPending = Buffer.concat([this.targetPending, payload]);
    let newline;
    while ((newline = this.targetPending.indexOf(0x0a)) >= 0) {
      const targetLine = this.targetPending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.targetPending = this.targetPending.subarray(newline + 1);
      if (!targetLine.startsWith(TARGET_ENVIRONMENT_PREFIX)) continue;
      if (this.environmentEvent) { this.errors.push("duplicate-target-environment-observation"); continue; }
      this.environmentEvent = parseJsonLine(targetLine, TARGET_ENVIRONMENT_PREFIX);
      if (this.environmentEvent.runId !== this.runId) this.errors.push("target-environment-run-id-mismatch");
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    if (this.pending.length) this.errors.push("observer-stream-has-incomplete-final-line");
    if (this.targetPending.toString("ascii").startsWith(TARGET_ENVIRONMENT_PREFIX)) {
      this.errors.push("target-environment-observation-missing-final-newline");
    }
    try { this.targetText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.targetChunks)); }
    catch { this.errors.push("target-log-is-not-complete-valid-utf8"); this.targetText = ""; }
    this.targetChunks = [];
  }

  snapshot() {
    return { channel: this.channel, encodedBytes: this.encodedBytes, overflow: this.overflow,
      errors: [...this.errors], readyEvent: this.readyEvent, launchEvent: this.launchEvent, resultEvent: this.resultEvent,
      environmentEvent: this.environmentEvent, targetByteLength: this.targetByteLength,
      targetFrameCount: this.targetFrameCount, targetFrameEncodedBytes: this.targetFrameEncodedBytes,
      targetText: this.targetText ?? "", ordinaryText: this.ordinaryLines.join("\n") };
  }
}
