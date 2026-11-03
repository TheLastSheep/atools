import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureZtoolsSettingsInputIdentity, validateZtoolsSettingsInputIdentity } from './ztools-settings-input-browser-identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('formal Main provenance binds root and nested compatibility helpers and rejects either tamper', async () => {
  const identity = await captureZtoolsSettingsInputIdentity({ root, authoredFiles: [] });
  assert.deepEqual((await validateZtoolsSettingsInputIdentity({ root, identity })).errors, []);
  for (const path of ['upstream-compatibility-patches.mjs', 'src/builtinShortcutsCompatibility.mjs']) {
    assert.ok(identity.renderer.provenance.hostAdapterSources.some(source => source.path === path));
    const changed = structuredClone(identity);
    const helper = changed.renderer.sources.files.find(source => source.path === path);
    assert.ok(helper);
    helper.sha256 = helper.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    assert.ok((await validateZtoolsSettingsInputIdentity({ root, identity: changed })).errors.some(error => error.includes('hostAdapterSources')));
  }
});
