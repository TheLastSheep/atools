import assert from 'node:assert/strict';
import { isAbsolute, normalize } from 'node:path';
import { buildNativeCaseArgs } from './ztools-renderer-native-runtime.mjs';

export const UPDATER_FORMAL_RECEIPT = 'output/renderer-updater-r78-2026-11-02/build/840bb5d8-41b3-43c8-b40d-c3595b8925fb/receipt.json';
export const UPDATER_PROVENANCE_SHA = 'cf49a9971bdcbf05879962407b40411e7209a0a0cdc3f302c2e06b9d235581d4';
export const UPDATER_BUILD_COMMAND = ['cargo', 'build', '-p', 'atools', '--example', 'ztools_renderer_desktop_smoke',
  '--features', 'legacy-node-smoke,ztools-multiwebview', '--locked', '--offline', '-j', '2'];
export const NATIVE_RUNNER_FILES = ['scripts/test-ztools-updater-native.mjs',
  ...['protocol', 'assets', 'sources', 'report', 'case'].map(name => `scripts/lib/ztools-updater-native-${name}.mjs`),
  'scripts/lib/ztools-renderer-native-runtime.mjs', 'scripts/lib/ztools-renderer-native-source-binding.mjs',
  'scripts/lib/ztools-renderer-native-source-snapshots.mjs', 'scripts/lib/ztools-renderer-browser-source-lock.mjs',
  'scripts/lib/ztools-renderer-native-provenance.mjs', 'scripts/lib/ztools-catalog-native-source-records.mjs',
  'scripts/lib/ztools-settings-native-sources.mjs', 'scripts/lib/ztools-settings-resource-budget.mjs',
  'scripts/lib/ztools-updater-browser-identity.mjs'];

export function updaterRunId(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return value.replaceAll('-', '').toLowerCase();
}
export const updaterFixtureRoot = runId => `/private/tmp/atools-renderer-updater-${updaterRunId(runId)}`;
export function parseUpdaterNativeArgs(argv) {
  const values = new Map(); let preflight = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--preflight') { assert.equal(preflight, false); preflight = true; continue; }
    assert.ok(['--binary', '--build-receipt', '--journey', '--auto-clear'].includes(flag), 'Unknown updater runner argument');
    assert.equal(values.has(flag), false, 'Duplicate updater runner argument');
    const value = argv[++i]; assert.ok(value && !value.startsWith('--')); values.set(flag, value);
  }
  assert.equal(values.get('--journey'), 'updater'); assert.equal(values.get('--auto-clear'), 'never');
  for (const flag of ['--binary', '--build-receipt']) {
    assert.ok(isAbsolute(values.get(flag) ?? ''), `${flag} must be an explicit absolute path`);
    assert.equal(normalize(values.get(flag)), values.get(flag), 'Canonical paths required');
  }
  return { binary: values.get('--binary'), buildReceipt: values.get('--build-receipt'), preflight };
}
export function buildUpdaterNativeArgs({ runId, fixtureRoot, rendererDist, output }) {
  runId = updaterRunId(runId);
  assert.equal(fixtureRoot, updaterFixtureRoot(runId));
  const args = buildNativeCaseArgs({ fixtureRoot, rendererDist, output, autoClear: 'never', runId, mode: 'multiwebview' });
  return [...args, '--journey', 'updater'];
}

export function assertUpdaterBuildReceipt(receipt, { binary, nativeSources, updaterFiles }) {
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.exitCode, 0);
  assert.deepEqual(receipt.command, UPDATER_BUILD_COMMAND, 'Require the actual offline multiwebview build command');
  assert.ok(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
  assert.deepEqual(receipt.binary, binary, 'Exact source executable fingerprint must match fresh build');
  assert.equal(receipt.nativeSources.sha256, nativeSources.sha256); assert.equal(receipt.nativeSources.fileCount, nativeSources.fileCount);
  assert.equal(receipt.nativeSources.stable, true);
  const bundle = receipt.updaterBundle;
  assert.equal(updaterFiles.length, 7); assert.equal(new Set(updaterFiles.map(file => file.path)).size, 7);
  assert.ok(bundle, 'R77/stale receipts without actual fresh updater compile inputs reject');
  assert.deepEqual(Object.keys(bundle).sort(), ['files', 'provenanceSha256', 'sourceManifestSha256', 'stable']);
  assert.equal(bundle.stable, true); assert.equal(bundle.provenanceSha256, UPDATER_PROVENANCE_SHA);
  assert.equal(bundle.sourceManifestSha256, updaterFiles.find(f => f.path === 'source-manifest.json')?.sha256);
  assert.deepEqual(bundle.files, updaterFiles, 'Fresh compiled seven-file tree must match current formal updater');
  for (const file of bundle.files) assert.deepEqual(Object.keys(file).sort(), ['bytes', 'path', 'sha256']);
}
