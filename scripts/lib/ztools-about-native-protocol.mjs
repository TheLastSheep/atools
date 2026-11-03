import assert from 'node:assert/strict';
import { isAbsolute, normalize } from 'node:path';
import { buildUpdaterNativeArgs, NATIVE_RUNNER_FILES } from './ztools-updater-native-protocol.mjs';
export const ABOUT_MAIN_PROVENANCE = '0a3f7bf23e342fadf06ede0469dfe45bc111ded1cce4525c63e6c27122f8a9c1';
export const ABOUT_REPORT_SCHEMA = Object.freeze({ path: 'output/renderer-about-update-r79-2026-11-02/native/runtime-report-types.ts', sha256: '50a833a85992abf56c39fea5b843ba39730d1c1f7578fdfde01a4e17f8a5bfbd' });
export const ABOUT_MILESTONE = 'original-vue-main-about-update-2026-11-02';
// Root-approved formal freeze; never accept a caller-supplied provenance grant.
export const ABOUT_SETTINGS_FORMAL = Object.freeze({
  path: 'output/renderer-about-update-r79-2026-11-02/frontend/lifecycle-close/formal-build/receipt.json',
  sha256: 'f07e204c290636f4a9338beb4b3472d3e3fcfad98ce4ce18a2385c1f80db9457',
  provenanceSha256: 'bd89bcfdd27b0c770b6823b0c43895d6048281f26fb6f49f7af37d146cb4757b',
});
export const ABOUT_RUNNER_FILES = [...NATIVE_RUNNER_FILES, 'scripts/test-ztools-about-native.mjs',
  ...['protocol', 'sources', 'assets', 'case', 'report', 'report-shapes', 'report-stages'].map(n => `scripts/lib/ztools-about-native-${n}.mjs`),
  'scripts/lib/ztools-settings-current-build-inputs.mjs', ABOUT_REPORT_SCHEMA.path];
export function parseAboutNativeArgs(argv) {
  const values = new Map(); let preflight = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--preflight') { assert.equal(preflight, false); preflight = true; continue; }
    assert.ok(['--binary', '--build-receipt', '--journey', '--updater-mode', '--auto-clear'].includes(flag), 'Unknown About runner argument');
    assert.equal(values.has(flag), false, 'Duplicate About runner argument');
    const value = argv[++i]; assert.ok(value && !value.startsWith('--')); values.set(flag, value);
  }
  assert.equal(values.get('--journey'), 'updater'); assert.equal(values.get('--updater-mode'), 'about');
  assert.equal(values.get('--auto-clear'), 'never');
  for (const flag of ['--binary', '--build-receipt']) {
    assert.ok(isAbsolute(values.get(flag) ?? ''), `${flag} requires absolute path`);
    assert.equal(normalize(values.get(flag)), values.get(flag));
  }
  return { binary: values.get('--binary'), buildReceipt: values.get('--build-receipt'), preflight };
}
export function buildAboutNativeArgs(options) {
  assert.match(options.runId, /^[0-9a-f]{32}$/);
  return [...buildUpdaterNativeArgs(options), '--updater-mode', 'about'];
}
export function assertAboutSettingsFreeze(snapshot, formal = ABOUT_SETTINGS_FORMAL) {
  assert.ok(formal, 'R79 formal Settings freeze not installed; old Settings cannot authorize About');
  assert.match(formal.provenanceSha256, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.bundle.provenanceSha256, formal.provenanceSha256, 'Reject untrusted/old Settings provenance');
}
