import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_CAPTURE_BYTES_PER_STREAM, buildNativeCaseArgs, cleanupOwnedFixtureRoot, cleanupOwnedRendererApp,
  nativeChildEnvironment, runNativeChild, stageRendererNativeApp } from './ztools-renderer-native-runtime.mjs';
import { fingerprintNativeExecutable } from './ztools-renderer-native-source-binding.mjs';
import { A_RAW, HEIGHT_CASES, heightPaths, validateHeightReport } from './ztools-settings-height-report.mjs';
import { cleanupHeightSeed, inspectHeightOwner, prepareHeightSeed, preserveHeightDatabase,
  privateDirectory, readHeightFile, requireAbsent } from './ztools-settings-height-sqlite.mjs';

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function assertHeightProcessTerminal(value, alive) {
  assert.ok(value?.spawned && value.terminalObserved && !value.timedOut && !value.exception
    && value.exitCode === 0 && value.signal === null && Number.isSafeInteger(value.pid) && value.pid > 0
    && value.supervisorDeadlineMs === 180000 && Number.isFinite(value.supervisorElapsedMs)
    && value.supervisorElapsedMs >= 0 && value.supervisorElapsedMs <= 180000
    && !value.interrupted && alive === false, 'Native process was not successful, terminal and independently absent');
}

export function buildHeightCaseArgs(paths, rendererDist, heightCase) {
  assert.deepEqual(paths, heightPaths(paths.runId));
  assert.ok(Object.hasOwn(HEIGHT_CASES, heightCase));
  return [...buildNativeCaseArgs({ fixtureRoot: paths.root, rendererDist, output: paths.output,
    autoClear: 'never', runId: paths.runId }), '--journey', 'settings-height', '--height-case', heightCase];
}

/** Own signal handling only while the exact child handle is alive; retain bounded raw logs. */
export async function launchHeightChild(executable, args, runDirectory, {
  spawnImpl = spawn, signalSource = process, timeoutMs = 180000, termGraceMs = 2000,
  killGraceMs = 5000, interruptGraceMs = 3000,
} = {}) {
  const supervisorStart = process.hrtime.bigint(), supervisorStartedAt = new Date().toISOString();
  const chunks = { stdout: [], stderr: [] }, lengths = { stdout: 0, stderr: 0 };
  let active = null, interrupted = false, startRecordFailed = false, startedRecord = null, interruptKill;
  const onSignal = () => {
    interrupted = true;
    if (active) {
      const child = active; child.kill('SIGTERM');
      if (!interruptKill) interruptKill = setTimeout(() => { if (active === child) child.kill('SIGKILL'); }, interruptGraceMs);
    }
  };
  signalSource.on('SIGINT', onSignal); signalSource.on('SIGTERM', onSignal);
  try {
    const result = await runNativeChild(executable, args, { timeoutMs, termGraceMs, killGraceMs,
      spawnOptions: { env: nativeChildEnvironment() }, spawnImpl(...parameters) {
        assert.equal(parameters[0], executable); assert.deepEqual(parameters[1], args);
        const child = spawnImpl(...parameters); active = child;
        child.once('spawn', () => {
          process.stdout.write(JSON.stringify({ kind: 'height-case-started', pid: child.pid, executable }) + '\n');
          startedRecord = writeFile(join(runDirectory, 'started.json'), JSON.stringify({ pid: child.pid, executable,
            args, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
            .catch(() => { startRecordFailed = true; child.kill('SIGTERM'); });
          if (interrupted) child.kill('SIGTERM');
        });
        for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', value => {
          const bytes = Buffer.from(value), keep = Math.max(0, MAX_CAPTURE_BYTES_PER_STREAM - lengths[stream]);
          if (keep) chunks[stream].push(bytes.subarray(0, keep)); lengths[stream] += bytes.length;
        });
        child.once('close', () => { active = null; });
        return child;
      } });
    await startedRecord;
    return { ...result, interrupted, startRecordFailed: startRecordFailed || startedRecord === null,
      supervisorStartedAt, supervisorFinishedAt: new Date().toISOString(), supervisorDeadlineMs: timeoutMs,
      supervisorElapsedMs: Number(process.hrtime.bigint() - supervisorStart) / 1e6 };
  } finally {
    signalSource.off('SIGINT', onSignal); signalSource.off('SIGTERM', onSignal);
    clearTimeout(interruptKill);
    for (const stream of ['stdout', 'stderr']) await writeFile(join(runDirectory, `${stream}.log`), Buffer.concat(chunks[stream]), { flag: 'wx', mode: 0o600 });
  }
}

/** Dependency hooks are for unit tests only; CLI never accepts executors or arbitrary arguments. */
export async function runHeightCase({ runId, heightCase, runDirectory, rendererDist, executable,
  settingsSnapshot, mainProvenanceSha256, previous = null, checkSources, dependencies = {} }) {
  const paths = heightPaths(runId);
  const deps = { stage: stageRendererNativeApp, launch: launchHeightChild, alive: processIsAlive,
    inspectOwner: inspectHeightOwner, preserve: preserveHeightDatabase,
    cleanupRoot: cleanupOwnedFixtureRoot, cleanupBundle: cleanupOwnedRendererApp, ...dependencies };
  const result = { runId, heightCase, runDirectory, paths, passed: false, process: null, processAlive: null,
    seed: null, owner: null, reportValidation: null, database: null, sourcesStable: false,
    binaryStable: false, cleanup: { root: null, bundle: null, seed: null, allowed: false }, errors: [] };
  let staged = null, fingerprint = null, complete = false;
  const fail = error => result.errors.push(String(error.message || error).slice(0, 1000));
  try {
    assert.ok(Object.hasOwn(HEIGHT_CASES, heightCase));
    await privateDirectory(runDirectory); await requireAbsent(paths.root); await requireAbsent(paths.seed);
    await writeFile(join(runDirectory, 'planned.json'), JSON.stringify({ runId, heightCase, paths,
      rootAndSeedAbsentBeforePreparation: true }) + '\n', { flag: 'wx', mode: 0o600 });
    await checkSources('before');
    if (heightCase !== 'a') result.seed = await prepareHeightSeed(previous, paths, heightCase);
    else assert.equal(previous, null);
    staged = await deps.stage({ binary: executable.path, runDirectory, autoClear: 'never', runId,
      expectedSha256: executable.sha256, mode: 'settings', settingsSourceSnapshot: settingsSnapshot });
    assert.equal(staged.identifier, paths.identifier);
    assert.equal(staged.settingsBundle.provenanceSha256, settingsSnapshot.bundle.provenanceSha256);
    fingerprint = await fingerprintNativeExecutable(staged.executable);
    assert.equal(fingerprint.sha256, executable.sha256);
    result.staged = staged;
    result.process = await deps.launch(staged.executable, buildHeightCaseArgs(paths, rendererDist, heightCase), runDirectory);
    result.processAlive = deps.alive(result.process.pid);
    assertHeightProcessTerminal(result.process, result.processAlive);
    assert.notEqual(result.process.startRecordFailed, true, 'PID/argv start receipt failed');
    result.owner = await deps.inspectOwner(paths, result.process.pid);
    const rawReport = await readHeightFile(paths.output, 512 * 1024);
    await writeFile(join(runDirectory, 'native-report.json'), rawReport.bytes, { flag: 'wx', mode: 0o600 });
    const nativeReport = JSON.parse(rawReport.bytes);
    result.reportValidation = validateHeightReport(nativeReport, { ...paths, heightCase, pid: result.process.pid,
      bundleRevision: settingsSnapshot.bundle.provenanceSha256, mainProvenanceSha256, rawBefore: result.seed?.rawBefore ?? A_RAW,
      seed: result.seed ? { path: paths.seed, sha256: result.seed.sha256, bytes: result.seed.bytes } : null });
    assert.equal(result.reportValidation.passed, true, result.reportValidation.errors.join('; '));
    result.database = await deps.preserve({ paths, pid: result.process.pid, runDirectory,
      processTerminal: true, processAlive: false });
    assert.equal(result.database.observation.rawGeneral, nativeReport.rawGeneral.after, 'SQLite and native final General differ');
    assert.deepEqual(await fingerprintNativeExecutable(staged.executable), fingerprint, 'Staged executable changed');
    result.binaryStable = true;
    if (result.seed) {
      const current = await readHeightFile(paths.seed);
      assert.equal(current.sha256, result.seed.sha256); assert.equal(current.identity, result.seed.identity);
    }
    await checkSources('after'); result.sourcesStable = true;
    assert.deepEqual(await deps.inspectOwner(paths, result.process.pid), result.owner);
    complete = true;
  } catch (error) { fail(error); }
  // Even a failed report may have a safely preservable DB. Never delete that root on failure.
  if (!result.database && result.process?.terminalObserved && result.processAlive === false) {
    try {
      result.owner = await deps.inspectOwner(paths, result.process.pid);
      result.database = await deps.preserve({ paths, pid: result.process.pid, runDirectory,
        processTerminal: true, processAlive: false });
    } catch (error) { fail(error); }
  }
  if (complete && result.database?.complete && result.sourcesStable && result.binaryStable) {
    result.cleanup.allowed = true;
    try {
      assert.equal(deps.alive(result.process.pid), false, 'PID became alive before cleanup');
      assert.deepEqual(await deps.inspectOwner(paths, result.process.pid), result.owner);
      result.cleanup.root = await deps.cleanupRoot({ root: paths.root, childPid: result.process.pid, processTerminal: true,
        expectedRootIdentity: result.owner.rootIdentity, expectedMarkerIdentity: result.owner.markerIdentity });
      assert.equal(result.cleanup.root.rootAbsent, true, 'Owned root was not removed');
      result.cleanup.bundle = await deps.cleanupBundle({ ...staged, processTerminal: true });
      assert.equal(result.cleanup.bundle.bundleAbsent, true, 'Owned bundle was not removed');
      result.cleanup.seed = await cleanupHeightSeed(result.seed);
      result.passed = true;
    } catch (error) { fail(error); }
  }
  await writeFile(join(runDirectory, 'case.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}
