import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, lstat, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../../packages/ztools-build/pinned-inputs.mjs';
import { stageRendererNativeApp, cleanupOwnedRendererApp, cleanupOwnedFixtureRoot, OWNER_MARKER_NAME } from './ztools-renderer-native-runtime.mjs';
import { stageUpdaterNativeAssets, hashUpdaterTree } from './ztools-updater-native-assets.mjs';
import { fingerprintNativeExecutable } from './ztools-renderer-native-source-binding.mjs';
import { runUpdaterNativeCase } from './ztools-updater-native-case.mjs';
import { runUpdaterNativeAcceptance } from '../test-ztools-updater-native.mjs';

async function isolatedCase() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'r78-cleanup-gates-')));
  const distRoot = join(directory, 'dist'), runDirectory = join(directory, 'run'), binary = join(directory, 'fixture-binary');
  await mkdir(join(distRoot, 'assets'), { recursive: true }); await mkdir(runDirectory, { mode: 0o700 });
  await writeFile(binary, 'never executed', { mode: 0o755 });
  for (const name of ['updater.html', 'assets/app.js', 'assets/app.css', 'assets/logo.png', 'build-provenance.json', 'source-manifest.json', 'ZTools-LICENSE'])
    await writeFile(join(distRoot, name), name);
  const inputs = { binary: await fingerprintNativeExecutable(binary), assets: { updater: {
    distRoot, files: await hashUpdaterTree(distRoot), identity: { provenanceSha256: 'b'.repeat(64) } } } };
  let fixtureRoot;
  const ports = { validateReport() {}, async launchChild(_binary, args) {
    const value = flag => args[args.indexOf(flag) + 1]; fixtureRoot = value('--fixture-root');
    await mkdir(fixtureRoot, { mode: 0o700 });
    await writeFile(join(fixtureRoot, OWNER_MARKER_NAME), JSON.stringify({ schemaVersion: 1, pid: process.pid,
      root: fixtureRoot, identifier: `dev.atools.renderer-smoke.${value('--run-id')}` }), { mode: 0o600 });
    await writeFile(value('--output'), '{}');
    return { spawned: true, terminalObserved: true, pid: process.pid, timedOut: false, exitCode: 0, signal: null };
  } };
  return { directory, runDirectory, inputs, ports, root: () => fixtureRoot, async close() {
    if (fixtureRoot) { await rm(fixtureRoot, { recursive: true, force: true }); await rm(fixtureRoot + '.held', { recursive: true, force: true }); }
    await rm(directory, { recursive: true, force: true });
  } };
}

test('actual runner preserves owned root/App when the final source gate drifts or throws', async () => {
  for (const failure of ['drift', 'throw']) {
    const fixture = await isolatedCase(); let reads = 0, cleanupCalls = 0;
    try {
      fixture.ports.cleanupFixtureRoot = async options => { cleanupCalls++; return cleanupOwnedFixtureRoot(options); };
      const code = await runUpdaterNativeAcceptance(['--journey', 'updater', '--auto-clear', 'never', '--binary', fixture.inputs.binary.path,
        '--build-receipt', join(fixture.directory, 'not-read-receipt.json')], {
        createRunDirectory: async () => fixture.runDirectory,
        preflight: async () => { if (++reads === 1) return fixture.inputs; if (failure === 'throw') throw Error('after-preflight failed'); return { ...fixture.inputs, changed: true }; },
        runCase: context => runUpdaterNativeCase(context, fixture.ports),
      });
      assert.equal(code, 1); assert.equal(cleanupCalls, 0, 'No cleanup before the actual final identity gate succeeds');
      assert.equal((await lstat(fixture.root())).isDirectory(), true);
      assert.equal((await lstat(join(fixture.runDirectory, 'case-never.app'))).isDirectory(), true);
    } finally { await fixture.close(); }
  }
});
test('actual cleanup caller rejects root or marker replacement carrying copied legal ownership', async () => {
  for (const replacement of ['root', 'marker']) {
    const fixture = await isolatedCase(); let cleanupResult;
    try {
    fixture.ports.cleanupFixtureRoot = async options => {
      const original = await readFile(join(options.root, OWNER_MARKER_NAME));
      if (replacement === 'root') { await rename(options.root, options.root + '.held'); await mkdir(options.root, { mode: 0o700 }); }
      else await rename(join(options.root, OWNER_MARKER_NAME), join(options.root, OWNER_MARKER_NAME + '.held'));
      await writeFile(join(options.root, OWNER_MARKER_NAME), original, { mode: 0o600 });
      cleanupResult = await cleanupOwnedFixtureRoot(options); return cleanupResult;
    };
    const result = await runUpdaterNativeCase({ root: process.cwd(), runDirectory: fixture.runDirectory,
      runId: randomUUID().replaceAll('-', ''), inputs: fixture.inputs }, fixture.ports);
    assert.equal(result.runtimePassed, true); await result.completeCleanup();
    assert.equal(cleanupResult.reason, replacement === 'root' ? 'root_identity_changed' : 'marker_identity_changed');
    assert.equal(cleanupResult.rootAbsent, false); assert.equal(result.passed, false);
    assert.equal((await lstat(fixture.root())).isDirectory(), true);
    assert.equal((await lstat(join(fixture.runDirectory, 'case-never.app'))).isDirectory(), true);
    if (replacement === 'root') assert.equal((await lstat(fixture.root() + '.held')).isDirectory(), true);
    } finally { await fixture.close(); }
  }
});
test('actual runner cleans the original owned resources only after its final identity gate succeeds', async () => {
  const fixture = await isolatedCase(); let reads = 0, cleanups = 0;
  try {
    fixture.ports.cleanupFixtureRoot = async options => { assert.equal(reads, 2); cleanups++; return cleanupOwnedFixtureRoot(options); };
    assert.equal(await runUpdaterNativeAcceptance(['--journey', 'updater', '--auto-clear', 'never', '--binary', fixture.inputs.binary.path,
      '--build-receipt', join(fixture.directory, 'not-read-receipt.json')], {
      createRunDirectory: async () => fixture.runDirectory, preflight: async () => { reads++; return fixture.inputs; },
      runCase: context => runUpdaterNativeCase(context, fixture.ports),
    }), 0);
    assert.equal(cleanups, 1); await assert.rejects(lstat(fixture.root()), { code: 'ENOENT' });
    await assert.rejects(lstat(join(fixture.runDirectory, 'case-never.app')), { code: 'ENOENT' });
  } finally { await fixture.close(); }
});

test('staging copies all seven exact files into only the newly owned App; drift and extra entries reject', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'r78-updater-stage-')));
  let staged;
  try {
    const distRoot = join(root, 'dist'), runDirectory = join(root, 'run');
    await mkdir(join(distRoot, 'assets'), { recursive: true }); await mkdir(runDirectory, { mode: 0o700 });
    const names = ['updater.html', 'assets/app.js', 'assets/app.css', 'assets/logo.png',
      'build-provenance.json', 'source-manifest.json', 'ZTools-LICENSE'];
    for (const name of names) await writeFile(join(distRoot, name), name);
    const binary = join(root, 'not-executed-binary'); await writeFile(binary, 'fixture only');
    staged = await stageRendererNativeApp({ binary, runDirectory, autoClear: 'never', runId: 'a'.repeat(32),
      expectedSha256: sha256('fixture only'), mode: 'multiwebview' });
    const snapshot = { distRoot, files: await hashUpdaterTree(distRoot), identity: { provenanceSha256: 'b'.repeat(64) } };
    const result = await stageUpdaterNativeAssets({ snapshot, staged }); assert.equal(result.staged, true);
    const target = join(staged.bundlePath, result.resourcePath);
    assert.deepEqual(await hashUpdaterTree(target), snapshot.files);
    await assert.rejects(stageUpdaterNativeAssets({ snapshot, staged: { ...staged, identifier: 'arbitrary.app' } }));
    await assert.rejects(stageUpdaterNativeAssets({ snapshot, staged })); // never overwrite/reuse staging
    await mkdir(join(target, 'extra')); await assert.rejects(hashUpdaterTree(target), /Extra updater directory/); await rm(join(target, 'extra'), { recursive: true });
    await writeFile(join(target, 'extra.js'), 'x'); await assert.rejects(hashUpdaterTree(target), /Extra updater file/); await rm(join(target, 'extra.js'));
    await rm(join(target, 'assets/app.js')); await assert.rejects(hashUpdaterTree(target), /seven/);
    await symlink(join(distRoot, 'assets/app.js'), join(target, 'assets/app.js')); await assert.rejects(hashUpdaterTree(target), /symlink/);
  } finally {
    if (staged) assert.equal((await cleanupOwnedRendererApp({ ...staged, processTerminal: true })).bundleAbsent, true);
    await rm(root, { recursive: true, force: true });
  }
});
