#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseUpdaterNativeArgs } from './lib/ztools-updater-native-protocol.mjs';
import { preflightUpdaterNative } from './lib/ztools-updater-native-sources.mjs';
import { createUpdaterNativeRunDirectory, runUpdaterNativeCase } from './lib/ztools-updater-native-case.mjs';

export async function runUpdaterNativeAcceptance(argv = process.argv.slice(2), ports = {}) {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url))), cli = parseUpdaterNativeArgs(argv);
  assert.equal(await realpath(root), '/Users/harris/Desktop/atools');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git(['branch', '--show-current']), 'codex/atools-ztools-parity');
  assert.equal(git(['rev-parse', 'HEAD']), 'c34789c0e3d19b3bf7c05d396540d891ff126abc');
  assert.equal(process.version, 'v22.23.3');
  assert.equal(await realpath(process.execPath), await realpath(join(root, 'src-tauri/binaries/node-aarch64-apple-darwin')));
  const runId = randomUUID().replaceAll('-', ''), runDirectory = await (ports.createRunDirectory ?? createUpdaterNativeRunDirectory)(root, runId);
  const report = { schemaVersion: 1, journey: 'updater', mode: cli.preflight ? 'preflight' : 'run', runId,
    pid: null, passed: false, errors: [], startedAt: new Date().toISOString(), finishedAt: null,
    inputSource: null, physicalOsInput: false, realSdk: false, sourceStable: false, case: null };
  let before;
  try {
    before = await (ports.preflight ?? preflightUpdaterNative)(root, cli); report.before = before;
    if (!cli.preflight) {
      assert.equal(process.platform, 'darwin', 'Owned Native App journey is macOS-only');
      report.case = await (ports.runCase ?? runUpdaterNativeCase)({ root, runDirectory, runId, inputs: before });
      report.pid = report.case.process?.pid ?? null;
      const native = report.case.nativeReport;
      if (native) {
        report.inputSource = native.inputSource; report.stages = native.stages; report.fixture = native.fixture;
        report.nativeCleanup = native.cleanup;
      }
    }
    const after = await (ports.preflight ?? preflightUpdaterNative)(root, cli); report.after = after;
    assert.deepEqual(after, before, 'Native/build receipts, binary, Main/Settings/Updater resources and runner sources changed');
    report.sourceStable = true;
    if (!cli.preflight) await report.case.completeCleanup();
    report.passed = cli.preflight || report.case.passed === true;
  } catch (error) {
    if (report.case?.cleanup.retained && !report.sourceStable) report.case.cleanup.retained.reason = 'final-input-gate-failed';
    report.errors.push({ name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 500) });
  }
  finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(join(runDirectory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ mode: report.mode, passed: report.passed, report: join(runDirectory, 'report.json') }));
  }
  return report.passed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runUpdaterNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`updater-native-preflight-failed: ${error.message}`); process.exitCode = 1;
  });
}
