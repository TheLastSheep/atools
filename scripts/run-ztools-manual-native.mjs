#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fingerprintNativeExecutable, validateNativeBuildReceipt } from './lib/ztools-renderer-native-source-binding.mjs';
import { nativeChildEnvironment, readJsonNoFollow } from './lib/ztools-renderer-native-runtime.mjs';
import { BUILD_ARGS, OUTPUT, ROOT, TAURI_CONFIG, captureManualInputs, hashTree, identity, manualPaths, readJson, sha,
  verifyWorkspace } from './lib/ztools-manual-native-evidence.mjs';
import { cleanupManualOwned, preserveManualDatabase, runManualNativeChild } from './lib/ztools-manual-native-lifecycle.mjs';

assert.equal(process.argv.length, 4, 'Use --prepared /absolute/path/prepared.json');
assert.equal(process.argv[2], '--prepared');
const preparedPath = process.argv[3];
assert.ok(isAbsolute(preparedPath)); assert.equal(await realpath(preparedPath), preparedPath);
const preparedBytes = await readFile(preparedPath);
const prepared = JSON.parse(preparedBytes);
const paths = manualPaths(prepared.runId);
assert.equal(preparedPath, join(paths.runDirectory, 'prepared.json'));
assert.equal(dirname(paths.runDirectory), OUTPUT);
assert.equal((await lstat(paths.runDirectory)).mode & 0o077, 0);
for (const [key, value] of Object.entries(paths)) assert.equal(prepared[key], value, `Unexpected ${key}`);
assert.equal(prepared.schemaVersion, 1); assert.equal(prepared.journey, 'manual-ui');
assert.equal(prepared.durationLimitMs, 600000); assert.equal(prepared.guiAcceptance, 'unverified');
const executable = join(paths.bundlePath, 'Contents/MacOS/AToolsRendererSmoke');
assert.equal(prepared.executable, executable);
const args = ['--journey', 'manual-ui', '--fixture-root', paths.fixtureRoot, '--renderer-dist', paths.mainDist,
  '--output', paths.nativeReport, '--auto-clear', 'never', '--run-id', prepared.runId];
assert.deepEqual(prepared.args, args);
await verifyWorkspace();
const currentInputs = await captureManualInputs();
assert.deepEqual(currentInputs, prepared.inputs, 'Current Native/UI/runner sources differ from prepared build');
const receipt = await readJson(join(paths.runDirectory, 'native-build-receipt.json'));
assert.equal(prepared.binary.path, join(ROOT, 'target/debug/examples/ztools_renderer_desktop_smoke'));
assert.deepEqual(await fingerprintNativeExecutable(prepared.binary.path), prepared.binary, 'Build output changed since preparation');
assert.deepEqual(receipt.binary, prepared.binary);
assert.deepEqual(receipt.manualInputs, prepared.inputs);
assert.deepEqual(receipt.command, { program: 'cargo', args: BUILD_ARGS, config: TAURI_CONFIG });
const receiptCheck = validateNativeBuildReceipt({ exists: true, value: receipt }, currentInputs.native, prepared.binary.sha256);
assert.equal(receiptCheck.valid, true, JSON.stringify(receiptCheck.errors));
assert.equal((await fingerprintNativeExecutable(executable)).sha256, prepared.binary.sha256);
assert.equal(identity(await lstat(paths.bundlePath, { bigint: true })), prepared.bundleIdentity);
assert.deepEqual(await hashTree(paths.bundlePath), prepared.bundleFiles, 'Staged bundle changed');
assert.deepEqual(await hashTree(paths.mainDist), prepared.mainDistFiles, 'Staged Main changed');
await assert.rejects(lstat(paths.fixtureRoot), { code: 'ENOENT' });
await assert.rejects(lstat(join(paths.runDirectory, 'started.json')), { code: 'ENOENT' });
const report = { schemaVersion: 1, journey: 'manual-ui-runner', runId: prepared.runId, ...paths,
  preparedSha256: sha(preparedBytes), sourceInputs: currentInputs, guiAcceptance: 'unverified',
  nativeGuiInputs: 'Root CUA only', error: null };
let processResult;
try {
  processResult = await runManualNativeChild(executable, args, { env: nativeChildEnvironment(),
    onStarted: async pid => {
      report.pid = pid; report.startedAt = new Date().toISOString();
      await writeFile(join(paths.runDirectory, 'started.json'), JSON.stringify({ runId: prepared.runId,
        pid, bundlePath: paths.bundlePath, identifier: paths.identifier, root: paths.fixtureRoot,
        startedAt: report.startedAt, nativeDurationLimitMs: 600000, supervisorLimitMs: 615000 }, null, 2),
      { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ state: 'running-awaiting-root-cua', pid, ...paths }));
    } });
  const { stdout, stderr, ...facts } = processResult;
  report.process = { ...facts, stdout: stdout.metadata(), stderr: stderr.metadata() };
  await writeFile(join(paths.runDirectory, 'native.stdout.log'), stdout.bytes(), { mode: 0o600 });
  await writeFile(join(paths.runDirectory, 'native.stderr.log'), stderr.bytes(), { mode: 0o600 });
  const marker = await readJsonNoFollow(join(paths.fixtureRoot, '.atools-renderer-smoke-owner.json'), 4096);
  assert.equal(marker.root, paths.fixtureRoot); assert.equal(marker.pid, facts.pid);
  assert.equal(marker.identifier, paths.identifier); assert.equal(marker.schemaVersion, 1);
  const nativeInfo = await lstat(paths.nativeReport);
  assert.ok(nativeInfo.isFile() && !nativeInfo.isSymbolicLink() && nativeInfo.size <= 1024 * 1024);
  const nativeBytes = await readFile(paths.nativeReport);
  const native = JSON.parse(nativeBytes);
  for (const [key, value] of Object.entries({ schemaVersion: 1, journey: 'manual-ui', runId: prepared.runId,
    pid: facts.pid, root: paths.fixtureRoot, identifier: paths.identifier, durationLimitMs: 600000,
    guiAcceptance: 'unverified' })) assert.equal(native[key], value, `Native report ${key} mismatch`);
  report.native = native; report.nativeReportSha256 = sha(nativeBytes);
  await writeFile(join(paths.runDirectory, 'native-report.json'), nativeBytes, { flag: 'wx', mode: 0o600 });
  report.sqlite = await preserveManualDatabase(paths);
  report.sourceStable = JSON.stringify(await captureManualInputs()) === JSON.stringify(currentInputs);
  assert.equal(report.sourceStable, true);
  assert.equal(facts.exitCode, 0); assert.equal(facts.signal, null);
  assert.equal(facts.timedOut, false); assert.equal(facts.interrupted, false);
  assert.equal(facts.spawnError, null); assert.equal(facts.startError, null);
  report.rootCleanupAllowed = report.sqlite.absenceConfirmed === true || report.sqlite.observation?.integrity === 'ok';
} catch (error) { report.error = `${error.name}: ${error.message}`; }
finally {
  report.finishedAt = new Date().toISOString();
  if (processResult) report.cleanup = await cleanupManualOwned({ prepared, pid: processResult.pid,
    terminalObserved: processResult.terminalObserved, rootCleanupAllowed: report.rootCleanupAllowed === true });
  report.executionRecorded = report.error === null;
  await writeFile(join(paths.runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ report: join(paths.runDirectory, 'report.json'), executionRecorded: report.executionRecorded,
    guiAcceptance: 'unverified', cleanup: report.cleanup, error: report.error }, null, 2));
}
if (report.error) process.exitCode = 1;
