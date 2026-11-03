import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runAndFinalizeLocalFixture } from "./lib/local-original-run-finalization.mjs";
import { readPublishedPluginProfile, profilePackageDigest } from "./lib/published-plugin-profile.mjs";

const profile = await readPublishedPluginProfile("local-content-workbench");
const summarizeCleanup = (_profile, removed, unchanged) => ({ removed, originalBytesNotModified: unchanged });
const root = await mkdtemp(path.join(tmpdir(), "atools-local-finalization-test-"));
const makeReport = runId => ({ runId, profile, packageSha256: profilePackageDigest(profile), executionMode: "original_ui",
  passed: true, status: "passed", sourceBytesUnchanged: true });
async function invoke(target, run, cleanup) {
  const runId = randomUUID(); let cleaned = false;
  const result = await runAndFinalizeLocalFixture({ target, profile, runId, summarizeCleanup,
    run: () => run(runId), cleanup: async () => { cleaned = true; await cleanup?.(); return true; } });
  return { result, cleaned };
}

try {
  const malformed = path.join(root, "malformed.json"), malformedBytes = Buffer.from('{"runId":');
  await writeFile(malformed, malformedBytes, { mode: 0o600 });
  let cleaned = false;
  await assert.rejects(runAndFinalizeLocalFixture({ target: malformed, profile, runId: randomUUID(), summarizeCleanup,
    run: async () => { throw Error("native failed"); }, cleanup: async () => { cleaned = true; return true; } }), /native failed/);
  assert.equal(cleaned, true);
  assert.deepEqual(await readFile(malformed), malformedBytes);

  const missing = path.join(root, "missing.json"); cleaned = false;
  await assert.rejects(runAndFinalizeLocalFixture({ target: missing, profile, runId: randomUUID(), summarizeCleanup,
    run: async () => { throw Error("native failed"); }, cleanup: async () => { cleaned = true; return true; } }), /native failed/);
  assert.equal(cleaned, true);
  await assert.rejects(readFile(missing), { code: "ENOENT" });

  const preexisting = path.join(root, "preexisting.json"), foreignRun = makeReport(randomUUID());
  const unrelated = Buffer.from(JSON.stringify(foreignRun));
  await writeFile(preexisting, unrelated, { mode: 0o600 }); cleaned = false;
  await assert.rejects(runAndFinalizeLocalFixture({ target: preexisting, profile, runId: randomUUID(), summarizeCleanup,
    run: async () => { throw Error("fresh-output gate rejected"); }, cleanup: async () => { cleaned = true; return true; } }), /fresh-output gate/);
  assert.equal(cleaned, true);
  assert.deepEqual(await readFile(preexisting), unrelated);

  const raced = path.join(root, "raced.json"), raceBytes = Buffer.from(JSON.stringify(makeReport(randomUUID())));
  cleaned = false;
  await assert.rejects(runAndFinalizeLocalFixture({ target: raced, profile, runId: randomUUID(), summarizeCleanup,
    run: async () => { await writeFile(raced, raceBytes, { mode: 0o600, flag: "wx" }); throw Error("wx refused occupied output"); },
    cleanup: async () => { cleaned = true; return true; } }), /wx refused/);
  assert.equal(cleaned, true);
  assert.deepEqual(await readFile(raced), raceBytes);

  const oversized = path.join(root, "oversized.json"), oversizedBytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
  await writeFile(oversized, oversizedBytes, { mode: 0o600 }); cleaned = false;
  await assert.rejects(runAndFinalizeLocalFixture({ target: oversized, profile, runId: randomUUID(), summarizeCleanup,
    run: async () => { throw Error("native failed"); }, cleanup: async () => { cleaned = true; return true; } }), /native failed/);
  assert.equal(cleaned, true);
  assert.equal((await lstat(oversized)).size, oversizedBytes.length);

  const own = path.join(root, "own.json"), ownRunId = randomUUID(), ownReport = makeReport(ownRunId);
  await writeFile(own, JSON.stringify(ownReport), { mode: 0o600 }); cleaned = false;
  await assert.rejects(runAndFinalizeLocalFixture({ target: own, profile, runId: ownRunId, summarizeCleanup,
    run: async () => ownReport, cleanup: async () => { cleaned = true; throw Error("cleanup failure"); } }), /cleanup failure/);
  assert.equal(cleaned, true);
  const finalized = JSON.parse(await readFile(own, "utf8"));
  assert.equal(finalized.passed, false);
  assert.match(finalized.wrapperError, /cleanup failure/);
  assert.equal(finalized.localSourceFixtureCleanup.removed, false);

  const failedOwned = path.join(root, "failed-owned.json"), failedRunId = randomUUID(), failedReport = makeReport(failedRunId);
  await assert.rejects(runAndFinalizeLocalFixture({ target: failedOwned, profile, runId: failedRunId, summarizeCleanup,
    run: async () => { await writeFile(failedOwned, JSON.stringify(failedReport), { mode: 0o600, flag: "wx" }); throw Error("native failure after report"); },
    cleanup: async () => true }), /native failure after report/);
  const recovered = JSON.parse(await readFile(failedOwned, "utf8"));
  assert.equal(recovered.localSourceFixtureCleanup.removed, true);
  assert.equal(recovered.passed, false);

  const { result, cleaned: normalCleaned } = await invoke(path.join(root, "normal.json"), async runId => {
    const report = makeReport(runId);
    await writeFile(path.join(root, "normal.json"), JSON.stringify(report), { mode: 0o600, flag: "wx" });
    return report;
  });
  assert.equal(normalCleaned, true);
  assert.equal(result.passed, true);
  console.log("local original run finalization tests passed (8 checks; no native or package execution)");
} finally { await rm(root, { recursive: true, force: true }); }
