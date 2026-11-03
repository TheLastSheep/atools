import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { assertNativeReportIdentity } from "./published-plugin-profile.mjs";

const MAX_REPORT_BYTES = 16 * 1024 * 1024;

async function readIdentityReport(target, profile, runId, executionMode) {
  let handle;
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_REPORT_BYTES || (before.mode & 0o777) !== 0o600) return null;
    let flags = fsConstants.O_RDONLY;
    if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
    if (typeof fsConstants.O_NONBLOCK === "number") flags |= fsConstants.O_NONBLOCK;
    handle = await open(target, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.size > MAX_REPORT_BYTES || (opened.mode & 0o777) !== 0o600) return null;
    const chunks = []; let size = 0;
    while (size <= MAX_REPORT_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_REPORT_BYTES + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); size += bytesRead;
    }
    const after = await handle.stat();
    if (size > MAX_REPORT_BYTES || size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return null;
    const report = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    assertNativeReportIdentity(report, profile, runId, executionMode);
    return report;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

async function writeIdentityReport(target, report, profile, runId, executionMode) {
  assertNativeReportIdentity(report, profile, runId, executionMode);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_REPORT_BYTES || (before.mode & 0o777) !== 0o600) {
    throw Error("Current-run report target is not a bounded private regular file");
  }
  let flags = fsConstants.O_RDWR;
  if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  if (typeof fsConstants.O_NONBLOCK === "number") flags |= fsConstants.O_NONBLOCK;
  const handle = await open(target, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_REPORT_BYTES
      || (opened.mode & 0o777) !== 0o600) throw Error("Report target changed while opening");
    const chunks = []; let size = 0;
    while (size <= MAX_REPORT_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_REPORT_BYTES + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); size += bytesRead;
    }
    if (size > MAX_REPORT_BYTES || size !== opened.size) throw Error("Current report exceeded bounded read");
    const current = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    assertNativeReportIdentity(current, profile, runId, executionMode);
    const output = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    if (output.length > MAX_REPORT_BYTES) throw Error("Finalized report exceeds output budget");
    await handle.truncate(0);
    let offset = 0;
    while (offset < output.length) {
      const { bytesWritten } = await handle.write(output, offset, output.length - offset, offset);
      if (!bytesWritten) throw Error("Could not finish current-run report write");
      offset += bytesWritten;
    }
  } finally { await handle.close(); }
}

/** Runs native work and guarantees fixture cleanup; report fallback is accepted only for this UUID/profile. */
export async function runAndFinalizeLocalFixture({ run, cleanup, target, profile, runId, executionMode = "original_ui", summarizeCleanup }) {
  if (!["original_ui", "original_worker_contract"].includes(executionMode)) throw Error("Unsupported local fixture execution mode");
  let report = null, runError = null, cleanupError = null, removed = false, writeError = null;
  try {
    const result = await run();
    assertNativeReportIdentity(result, profile, runId, executionMode);
    report = result;
  } catch (error) { runError = error; }
  finally {
    try { removed = (await cleanup()) === true; }
    catch (error) { cleanupError = error; }
    if (!report) report = await readIdentityReport(target, profile, runId, executionMode);
    if (report) {
      report.localSourceFixtureCleanup = summarizeCleanup(profile, removed, report.sourceBytesUnchanged === true);
      if (runError || cleanupError || !removed) {
        report.wrapperError = String(runError || cleanupError || "Owned fixture cleanup failed");
        report.passed = false; report.status = "failed";
      }
      try { await writeIdentityReport(target, report, profile, runId, executionMode); }
      catch (error) { writeError = error; }
    }
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  if (writeError) throw writeError;
  if (!removed) throw Error("Owned local package fixture was not removed");
  if (!report?.passed) throw Error("Local original package acceptance failed; report retained");
  return report;
}
