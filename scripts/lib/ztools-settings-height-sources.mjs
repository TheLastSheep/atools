import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { captureNativeSourceSnapshot, fingerprintNativeExecutable, validateNativeBuildReceipt } from './ztools-renderer-native-source-binding.mjs';
import { setupNativeRendererSourceLock } from './ztools-renderer-native-source-snapshots.mjs';
import { validateRendererNativeProvenance } from './ztools-renderer-native-provenance.mjs';
import { captureSettingsNativeSources, summarizeSettingsNativeSources } from './ztools-settings-native-sources.mjs';
import { readJsonNoFollow } from './ztools-renderer-native-runtime.mjs';

export const ROOT = '/Users/harris/Desktop/atools';
export const OUTPUT = join(ROOT, 'output/renderer-settings-height-native-r76-2026-11-02');
export const NODE = join(ROOT, 'src-tauri/binaries/node-aarch64-apple-darwin');
export const SCRIPT_INPUTS = [
  'scripts/test-ztools-settings-height-native.mjs',
  'scripts/lib/ztools-settings-height-fixtures.mjs',
  ...['case', 'report', 'sqlite', 'sources', 'proof'].flatMap(name => [
    `scripts/lib/ztools-settings-height-${name}.mjs`, `scripts/lib/ztools-settings-height-${name}.test.mjs`,
  ]),
  'scripts/lib/ztools-renderer-native-runtime.mjs', 'scripts/lib/ztools-renderer-native-source-binding.mjs',
  'scripts/lib/ztools-renderer-native-source-snapshots.mjs', 'scripts/lib/ztools-renderer-browser-source-lock.mjs',
  'scripts/lib/ztools-renderer-host-sources.mjs', 'scripts/lib/ztools-renderer-native-provenance.mjs',
  'scripts/lib/ztools-settings-native-sources.mjs', 'scripts/lib/ztools-settings-resource-budget.mjs',
];
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const identity = info => `${info.dev}:${info.ino}`;

/** R75 approved Main tree, not only its self-reported JS byte count/provenance. */
export function assertHeightMainDist(files) {
  const prefix = 'packages/ztools-renderer/dist/';
  assert.ok(Object.keys(files).every(path => path.startsWith(prefix)));
  const entries = Object.entries(files).map(([path, hash]) => [path.slice(prefix.length), hash])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(entries.length, 12);
  assert.equal(sha(JSON.stringify(entries)), '068d2bf8f593b9e5800c02204103813dd624a3e9b5500baa5493d57186dc5b31');
}

export async function verifyHeightWorkspace() {
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
  assert.equal(await realpath(ROOT), ROOT);
  assert.equal(git('branch', '--show-current'), 'codex/atools-ztools-parity');
  assert.equal(git('rev-parse', 'HEAD'), 'c34789c0e3d19b3bf7c05d396540d891ff126abc');
  assert.equal(await realpath(process.execPath), await realpath(NODE));
  assert.equal(process.versions.node, '22.23.3');
  assert.equal(process.platform, 'darwin');
  return { root: ROOT, branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD') };
}

/** Bind both formal UI artifacts, all declared host helpers, runner inputs and native build. */
export async function captureHeightSources(binary, receiptPath) {
  const packageRoot = join(ROOT, 'packages/ztools-renderer'), distRoot = join(packageRoot, 'dist');
  const { sourceLock, snapshot } = await setupNativeRendererSourceLock({ root: ROOT,
    upstreamPath: '/Users/harris/Desktop/ZTools', packageRoot, distRoot, fixtureFiles: SCRIPT_INPUTS });
  assert.deepEqual(snapshot.errors, []);
  assertHeightMainDist(snapshot.distFiles);
  const main = await readJsonNoFollow(join(distRoot, 'build-provenance.json'), 1024 * 1024);
  const manifest = await readJsonNoFollow(join(packageRoot, 'source-manifest.json'), 256 * 1024);
  assert.deepEqual(await sourceLock.readHostAdapterSources(), main.hostAdapterSources);
  let mainBytes = 0;
  for (const path of Object.keys(snapshot.distFiles).filter(path => path.endsWith('.js'))) {
    mainBytes += (await lstat(join(ROOT, path))).size;
  }
  validateRendererNativeProvenance(manifest, main, snapshot.upstream, mainBytes);
  assert.equal(mainBytes, 604522);
  assert.equal(sha(await readFile(join(distRoot, 'build-provenance.json'))), 'c8aa4946014ca1c73c675aa1d2c2da75d5b36c18434b38baec76bc8099a07657');
  const settings = await captureSettingsNativeSources(ROOT);
  assert.equal(settings.bundle.resourceBytes, 803857);
  assert.equal(settings.bundle.provenanceSha256, 'c897cfbd6d5287861c448a0c42ba84dabae11d60951e654bab22f4cdb1bdf092');
  const native = await captureNativeSourceSnapshot(ROOT), executable = await fingerprintNativeExecutable(binary);
  assert.equal(await realpath(receiptPath), receiptPath);
  const info = await lstat(receiptPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid());
  assert.ok(Date.now() - info.mtimeMs >= 0 && Date.now() - info.mtimeMs < 86400000, 'Use a fresh native build receipt');
  const receipt = await readJsonNoFollow(receiptPath, 1024 * 1024);
  assert.equal(validateNativeBuildReceipt({ exists: true, value: receipt }, native, executable.sha256).valid, true);
  return { settings, executable, evidence: { native, executable, receiptSha256: sha(await readFile(receiptPath)),
    main: snapshot, settings: summarizeSettingsNativeSources(settings) } };
}

export function assertHeightSourcesStable(before, after) {
  assert.deepEqual(after, before, 'Native, binary, receipt, scripts, source or formal dist drifted');
}
