import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCurrentSettingsBuildInputs } from './ztools-settings-current-build-inputs.mjs'
import { captureHostBridgeSources, hostBridgeSourcesProvenance } from '../../packages/ztools-settings/src/host-bridge-build.mjs'
import { captureSettingsNativeSources } from './ztools-settings-native-sources.mjs'

const root = process.cwd(), milestone = 'original-vue-about-update-settings-2026-11-02'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function inputs() {
  const files = ['packages/ztools-settings/build.mjs']
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await scan(p)
      else if (p.endsWith('.mjs') && !p.endsWith('.test.mjs')) files.push(p)
    }
  }
  await scan('packages/ztools-settings/src')
  return Promise.all(files.map(async path => { const data = await readFile(path); return { path, bytes: data.length, sha256: hash(data) } }))
}
async function metadata() {
  const packageFiles = await inputs()
  const result = JSON.parse(await readFile('output/renderer-about-update-r79-2026-11-02/frontend/lifecycle-close/settings-strict-result.json'))
  return { manifest: { build: { budgetMilestone: milestone } }, provenance: { build: { localBuildInputs: structuredClone(packageFiles) }, sourceCompatibility: result.compatibility }, packageFiles }
}

test('actual R80 dist is accepted by actual source reader', async () => {
  const result = await captureSettingsNativeSources(root)
  assert.equal(result.bundle.resourceBytes, 817194)
})
test('synthetic new metadata accepts exact modules and applied child close entry patch', async () => {
  const m = await metadata(); assert.doesNotThrow(() => assertCurrentSettingsBuildInputs(m.manifest, m.provenance, m.packageFiles))
  const ids = m.packageFiles.map(f => f.path)
  assert.ok(ids.includes('packages/ztools-settings/src/compatibility-patches/child-close-lifecycle.mjs'))
  assert.ok(ids.includes('packages/ztools-settings/src/compatibility-patches/hotkey-recording.mjs'))
})
test('rejects same-size modified module, missing and duplicated actual inputs', async () => {
  const m = await metadata(), target = m.packageFiles.find(x => x.path.endsWith('child-close-lifecycle.mjs'))
  const altered = structuredClone(m.packageFiles), actual = altered.find(x => x.path === target.path); actual.sha256 = 'f'.repeat(64)
  assert.equal(actual.bytes, target.bytes)
  assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, m.provenance, altered), /modules differ/)
  const missing = structuredClone(m.provenance); missing.build.localBuildInputs = missing.build.localBuildInputs.filter(x => x.path !== target.path)
  assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, missing, m.packageFiles), /modules differ/)
  const duplicate = structuredClone(m.provenance); duplicate.build.localBuildInputs.push(target)
  assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, duplicate, m.packageFiles), /modules differ/)
})
test('rejects missing, duplicated or altered consumed patch receipt', async () => {
  const m = await metadata(), remove = structuredClone(m.provenance)
  remove.sourceCompatibility.patchedFiles = remove.sourceCompatibility.patchedFiles.filter(p => p.path !== 'internal-plugins/setting/src/main.ts')
  assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, remove, m.packageFiles), /entry patch receipt/)
  const altered = structuredClone(m.provenance), entry = altered.sourceCompatibility.patchedFiles.find(p => p.path === 'internal-plugins/setting/src/main.ts')
  entry.changes[0].id = 'unrelated'; assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, altered, m.packageFiles), /child close patch/)
  const duplicate = structuredClone(m.provenance); duplicate.sourceCompatibility.patchedFiles.push(duplicate.sourceCompatibility.patchedFiles.find(p => p.path === 'internal-plugins/setting/src/main.ts'))
  assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, duplicate, m.packageFiles), /entry patch receipt/)
})
test('historical milestone remains on its existing policy path', () => {
  assert.doesNotThrow(() => assertCurrentSettingsBuildInputs({ build: { budgetMilestone: 'original-vue-default-height-settings-2026-11-02' } }, {}, []))
})

test('actual bundle reader accepts synthetic updated metadata then rejects same-size module drift and missing patch', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'r79-settings-source-gate-')))
  const target = join(directory, 'packages/ztools-settings')
  try {
    await cp('packages/ztools-settings', target, { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/review-dist') })
    const m = await metadata(), provenancePath = join(target, 'dist/build-provenance.json')
    const provenance = JSON.parse(await readFile(provenancePath))
    const host = await captureHostBridgeSources(directory)
    provenance.build.hostBridgeSources = hostBridgeSourcesProvenance(host, provenance.build.hostBridgeSources.runtimeImports, 'packages/ztools-settings/src/hostBridgeEntry.ts')
    provenance.build.localBuildInputs = m.provenance.build.localBuildInputs
    await writeFile(provenancePath, JSON.stringify(provenance))
    const result = await captureSettingsNativeSources(directory)
    assert.ok(result.bundle.fileCount > 0)
    const file = join(target, 'src/compatibility-patches/child-close-lifecycle.mjs'), original = await readFile(file), altered = Buffer.from(original)
    altered[0] ^= 1; await writeFile(file, altered)
    await assert.rejects(captureSettingsNativeSources(directory), /Settings current build modules differ from provenance/)
    await writeFile(file, original)
    provenance.sourceCompatibility.patchedFiles = provenance.sourceCompatibility.patchedFiles.filter(p => p.path !== 'internal-plugins/setting/src/main.ts')
    await writeFile(provenancePath, JSON.stringify(provenance))
    await assert.rejects(captureSettingsNativeSources(directory), /Settings current entry patch receipt/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('R80 requires exact current modules and all three pinned patch receipts', async () => {
  const m = await metadata()
  const { settingsSourceCompatibilityPatches } = await import('../../packages/ztools-settings/src/compatibility-patches/index.mjs')
  const after = new Map([
    ['internal-plugins/setting/src/main.ts', '5ed64fde74e3fe2bebb2f0bcafc7eefac88d341d6672aa1affed424dbcbbba75'],
    ['internal-plugins/setting/src/components/common/ShortcutEditor/ShortcutEditor.vue', 'c97a872a52b49a7d97ff05b93999b1df35d7751fccd676ea4a9b17c9c00e2b94'],
    ['internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue', 'bea522589fce5b7c8017945395024170a34affb7bfc22e1f62296ccfe0b7cfd0']
  ])
  const entries = settingsSourceCompatibilityPatches.filter(p => after.has(p.path)).map(p => ({ path: p.path, beforeSha256: p.beforeSha256, afterSha256: after.get(p.path), changes: p.changes.map(({ id, kind }) => ({ id, kind })) }))
  m.manifest.build.budgetMilestone = 'original-vue-app-global-shortcuts-settings-2026-11-02'
  m.provenance.sourceCompatibility.patchedFiles = entries
  assert.doesNotThrow(() => assertCurrentSettingsBuildInputs(m.manifest, m.provenance, m.packageFiles))
  const bad = structuredClone(m.provenance); bad.sourceCompatibility.patchedFiles[1].changes[0].kind = 'type-only'
  assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, bad, m.packageFiles), /R80 patch changes differ/)
  const missing = structuredClone(m.provenance); missing.sourceCompatibility.patchedFiles.pop()
  assert.throws(() => assertCurrentSettingsBuildInputs(m.manifest, missing, m.packageFiles), /R80 patch receipt/)
})
