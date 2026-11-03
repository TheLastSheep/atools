import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUpdaterNativeArgs, updaterRunId, updaterFixtureRoot, buildUpdaterNativeArgs,
  assertUpdaterBuildReceipt, UPDATER_BUILD_COMMAND, UPDATER_PROVENANCE_SHA } from './ztools-updater-native-protocol.mjs';

const runId = 'a'.repeat(32);
test('updater CLI and child arguments fix the journey/root/auto-clear and never accept arbitrary profiles', () => {
  const cli = ['--journey', 'updater', '--auto-clear', 'never', '--binary', '/owned/binary', '--build-receipt', '/owned/build-receipt.json'];
  assert.equal(parseUpdaterNativeArgs([...cli, '--preflight']).preflight, true);
  for (const extra of [['--mode', 'multiwebview'], ['--fixture-root', '/tmp/anything'], ['--binary', '/other'], ['--preflight', '--preflight']])
    assert.throws(() => parseUpdaterNativeArgs([...cli, ...extra]));
  assert.throws(() => parseUpdaterNativeArgs(cli.map(x => x === 'updater' ? 'catalog' : x)));
  assert.throws(() => parseUpdaterNativeArgs(cli.map(x => x === 'never' ? 'immediately' : x)));
  assert.equal(updaterRunId('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'), runId);
  const args = buildUpdaterNativeArgs({ runId, fixtureRoot: updaterFixtureRoot(runId), rendererDist: '/owned/main', output: '/owned/new.json' });
  assert.equal(args[args.indexOf('--journey') + 1], 'updater');
  assert.equal(args[args.indexOf('--auto-clear') + 1], 'never');
  assert.throws(() => buildUpdaterNativeArgs({ runId, fixtureRoot: '/private/tmp/wrong', rendererDist: '/owned/main', output: '/owned/new.json' }));
});
test('a fresh compile receipt must bind updater resources, real zero exit and offline feature command', () => {
  const binary = { path: '/owned/binary', sha256: 'b'.repeat(64), sizeBytes: '123' };
  const nativeSources = { sha256: 'c'.repeat(64), fileCount: 10 };
  const updaterFiles = ['ZTools-LICENSE', 'assets/app.css', 'assets/app.js', 'assets/logo.png',
    'build-provenance.json', 'source-manifest.json', 'updater.html'].map(path => ({ path, sha256: 'd'.repeat(64), bytes: 10 }));
  const receipt = { schemaVersion: 1, exitCode: 0, command: UPDATER_BUILD_COMMAND,
    binary, nativeSources: { ...nativeSources, stable: true }, startedAt: '2026-11-02T00:00:00Z', finishedAt: '2026-11-02T00:00:01Z',
    updaterBundle: { provenanceSha256: UPDATER_PROVENANCE_SHA, sourceManifestSha256: updaterFiles[0].sha256, files: updaterFiles, stable: true } };
  const inputs = { binary, nativeSources, updaterFiles };
  assert.doesNotThrow(() => assertUpdaterBuildReceipt(receipt, inputs));
  for (const mutate of [r => delete r.updaterBundle, r => r.exitCode = 1, r => r.command.pop(),
    r => r.nativeSources.stable = false, r => r.updaterBundle.stable = false,
    r => r.updaterBundle.files[0].sha256 = '0'.repeat(64), r => r.updaterBundle.provenanceSha256 = '0'.repeat(64),
    r => r.updaterBundle.extra = true]) {
    const bad = structuredClone(receipt); mutate(bad); assert.throws(() => assertUpdaterBuildReceipt(bad, inputs));
  }
});
