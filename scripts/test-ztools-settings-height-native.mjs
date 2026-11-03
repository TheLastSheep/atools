import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, OUTPUT, assertHeightSourcesStable, captureHeightSources, sha, verifyHeightWorkspace } from './lib/ztools-settings-height-sources.mjs';
import { privateDirectory } from './lib/ztools-settings-height-sqlite.mjs';
import { runHeightCase } from './lib/ztools-settings-height-case.mjs';

export function parseHeightRunnerArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--binary', '--build-receipt'].includes(argv[i]) && !values.has(argv[i])
      && typeof argv[i + 1] === 'string' && isAbsolute(argv[i + 1]), 'Only unique absolute --binary/--build-receipt paths are accepted');
    values.set(argv[i], argv[i + 1]);
  }
  assert.equal(values.size, 2);
  return { binary: values.get('--binary'), receipt: values.get('--build-receipt') };
}

export async function runHeightAcceptance(argv = process.argv.slice(2)) {
  const cli = parseHeightRunnerArgs(argv), workspace = await verifyHeightWorkspace();
  await mkdir(OUTPUT, { recursive: true, mode: 0o700 });
  for (const path of [join(ROOT, 'output'), OUTPUT]) {
    const info = await lstat(path);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && await realpath(path) === path);
  }
  // OUTPUT may preexist with ordinary workspace permissions; the fresh child is always private.
  const suiteId = randomUUID().replaceAll('-', ''), directory = join(OUTPUT, `run-${suiteId}`);
  await privateDirectory(directory, true);
  const report = { schemaVersion: 1, journey: 'settings-height-four-process-chain', suiteId,
    workspace, startedAt: new Date().toISOString(), finishedAt: null, passed: false,
    registrationScheme: 'single-owned-child-lifecycle', numericRegistrationIdCollected: false,
    guiAcceptance: 'unverified', crossRootBoundary: 'terminal SQLite backups copied into four independent private process roots',
    cases: [], sourceDigest: null, errors: [] };
  try {
    const before = await captureHeightSources(cli.binary, cli.receipt);
    await writeFile(join(directory, 'source-before.json'), JSON.stringify(before.evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    report.sourceDigest = sha(JSON.stringify(before.evidence));
    let previous = null;
    for (const heightCase of ['a', 'b', 'c', 'd']) {
      const runId = randomUUID().replaceAll('-', ''), runDirectory = join(directory, `case-${heightCase}`);
      await privateDirectory(runDirectory, true);
      const result = await runHeightCase({ runId, heightCase, runDirectory,
        rendererDist: join(ROOT, 'packages/ztools-renderer/dist'), executable: before.executable,
        settingsSnapshot: before.settings, previous, async checkSources(phase) {
          const current = await captureHeightSources(cli.binary, cli.receipt);
          await writeFile(join(runDirectory, `source-${phase}.json`), JSON.stringify(current.evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          assertHeightSourcesStable(before.evidence, current.evidence);
        }, mainProvenanceSha256: before.evidence.main.distFiles['packages/ztools-renderer/dist/build-provenance.json'] });
      report.cases.push(result);
      process.stdout.write(JSON.stringify({ kind: 'height-case-terminal', heightCase, passed: result.passed,
        pid: result.process?.pid ?? null, runDirectory }) + '\n');
      if (!result.passed) throw new Error(`Height case ${heightCase} failed; preserve its evidence and stop the chain`);
      previous = result;
    }
    const final = await captureHeightSources(cli.binary, cli.receipt);
    await writeFile(join(directory, 'source-after.json'), JSON.stringify(final.evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assertHeightSourcesStable(before.evidence, final.evidence);
    report.passed = report.cases.length === 4 && report.cases.every(value => value.passed);
  } catch (error) { report.errors.push(String(error.message || error).slice(0, 1000)); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { passed: report.passed, reportPath: join(directory, 'report.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHeightAcceptance().then(result => { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.passed ? 0 : 1; })
    .catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
}
