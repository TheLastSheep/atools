import assert from 'node:assert/strict'

const MILESTONE = 'original-vue-about-update-settings-2026-11-02'
const R80 = 'original-vue-app-global-shortcuts-settings-2026-11-02'
const MAIN = 'internal-plugins/setting/src/main.ts'
const ID = 'settings-child-out-skips-general-remount'
const BEFORE = 'bf94ee1f636d7e0643dd14fe9a13a0797138c8a7b022f0d482a96d6e7f82a8fb'
const AFTER = '02b77e96213024e426fff06ffe36840f8105d28220de09b5a11f6abc4fa4b9eb'

/** Require the current R79 artifact to bind the real build modules and applied entry patch. */
export function assertCurrentSettingsBuildInputs(manifest, provenance, packageFiles) {
  const milestone = manifest?.build?.budgetMilestone
  if (milestone !== MILESTONE && milestone !== R80) return
  const needed = packageFiles.filter(f => f.path === 'packages/ztools-settings/build.mjs' ||
    (f.path.startsWith('packages/ztools-settings/src/') && f.path.endsWith('.mjs') && !f.path.endsWith('.test.mjs')))
  const declared = provenance?.build?.localBuildInputs
  assert.ok(Array.isArray(declared), 'Settings current build inputs are missing')
  const mjs = declared.filter(f => typeof f?.path === 'string' && f.path.endsWith('.mjs'))
  const sort = entries => entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path))
  assert.deepEqual(sort(mjs), sort(needed), 'Settings current build modules differ from provenance')
  const patches = provenance?.sourceCompatibility?.patchedFiles
  assert.ok(Array.isArray(patches), 'Settings current compatibility patch receipt missing')
  const matches = patches.filter(p => p?.path === MAIN)
  assert.equal(matches.length, 1, 'Settings current entry patch receipt missing or duplicated')
  const entry = matches[0]
  assert.equal(entry.beforeSha256, BEFORE, 'Settings entry patch original source differs')
  if (milestone === MILESTONE) {
    assert.equal(entry.afterSha256, AFTER, 'Settings entry patch result differs')
    assert.deepEqual(entry.changes, [{ id: ID, kind: 'child-close-lifecycle' }], 'Settings child close patch was not applied')
    return
  }
  const expected = [
    [MAIN, BEFORE, '5ed64fde74e3fe2bebb2f0bcafc7eefac88d341d6672aa1affed424dbcbbba75', [ID, 'settings-app-shortcuts-intent-route']],
    ['internal-plugins/setting/src/components/common/ShortcutEditor/ShortcutEditor.vue', 'c7cd5aeb5715ca59852e8c1725ff8170da6083bf26d276c439d0c7da1dd381e1', 'a943bc9e5389471c8570eb8e57097461ecc8a3f98d18e3a69439cc599db5dbbf', ['app-shortcut-editor-identity']],
    ['internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue', '746709f7441db1a192693283f0f7b343c8b6fddd23d9dcc28c92a5001c80c078', 'bea522589fce5b7c8017945395024170a34affb7bfc22e1f62296ccfe0b7cfd0', [
      'shortcut-command-id-helper-accepts-all-command-kinds', 'builtin-shortcut-failure-restores-confirmed-projection',
      'builtin-shortcut-only-supported-single-key-intent', 'builtin-shortcut-checkbox-restores-confirmed-state',
      'global-shortcut-unmount-import', 'global-shortcut-type-and-client', 'global-shortcut-app-authority',
      'global-shortcut-prefill-identity', 'global-shortcut-load', 'global-shortcut-remove-legacy-write',
      'global-shortcut-handle-save-signature', 'global-shortcut-handle-save-dispatch', 'global-shortcut-open-editor-generation',
      'global-shortcut-edit-generation', 'global-shortcut-close-generation', 'global-shortcut-single-mutation',
      'global-shortcut-delete-mutation', 'global-shortcut-unsupported-autocopy', 'global-shortcut-session-prefill'
    ]]
  ]
  for (const [path, before, after, ids] of expected) {
    const matches = patches.filter(p => p?.path === path)
    assert.equal(matches.length, 1, 'Settings R80 patch receipt missing or duplicated')
    assert.equal(matches[0].beforeSha256, before, 'Settings R80 original source differs')
    assert.equal(matches[0].afterSha256, after, 'Settings R80 patched source differs')
    assert.deepEqual(matches[0].changes, ids.map(id => ({ id, kind: id === ID ? 'child-close-lifecycle' :
      id === 'shortcut-command-id-helper-accepts-all-command-kinds' ? 'type-only' :
        id.startsWith('builtin-shortcut-') ? 'builtin-shortcuts' : 'app-global-shortcuts' })), 'Settings R80 patch changes differ')
  }
}
