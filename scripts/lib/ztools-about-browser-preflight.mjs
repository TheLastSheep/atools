import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { captureZtoolsSettingsInputIdentity, validateZtoolsSettingsInputIdentity } from './ztools-settings-input-browser-identity.mjs'
import { captureUpdaterBrowserIdentity } from './ztools-updater-browser-identity.mjs'

const sha = data => createHash('sha256').update(data).digest('hex')
const RECORD_SHA = Object.freeze({ tree: '775ee8b1301719d4f2b1ebb16e9d97e4c5bd3fd8f6cc20c72ede1197335d65a9', sources: 'cc0459f947c1bfb1856a1d71e1d2685aa12455aff9718a033b59cc149fb456c6' })
export function validateFrozenRecords(tree, sources) {
  assert.equal(sha(tree), RECORD_SHA.tree, 'Frozen formal tree record changed')
  assert.equal(sha(sources), RECORD_SHA.sources, 'Frozen source record changed')
}
export function assertAboutIdentityStable(before, after) { assert.deepEqual(after, before, 'About preflight identity drift') }
const RECEIPT = 'f07e204c290636f4a9338beb4b3472d3e3fcfad98ce4ce18a2385c1f80db9457'
export function validateFormalReceipt(bytes) { assert.equal(sha(bytes), RECEIPT, 'Lifecycle formal receipt changed') }
const ROOTS = ['packages/ztools-renderer/dist', 'packages/ztools-settings/dist', 'dist-ztools-updater']
const PROVENANCE = ['0a3f7bf23e342fadf06ede0469dfe45bc111ded1cce4525c63e6c27122f8a9c1', 'bd89bcfdd27b0c770b6823b0c43895d6048281f26fb6f49f7af37d146cb4757b', 'cf49a9971bdcbf05879962407b40411e7209a0a0cdc3f302c2e06b9d235581d4']
async function tree(root, directory, out = []) {
  for (const name of (await readdir(directory)).sort()) {
    const file = join(directory, name), stat = await lstat(file)
    assert.ok(!stat.isSymbolicLink(), `symlink ${file}`)
    if (stat.isDirectory()) await tree(root, file, out)
    else { assert.ok(stat.isFile()); const data = await readFile(file); out.push({ path: relative(root, file), bytes: data.length, sha256: sha(data) }) }
  }
  return out
}
export async function preflightAbout({ root, authoredFiles = [] }) {
  const dir = join(root, 'output/renderer-about-update-r79-2026-11-02/frontend/lifecycle-close/formal-build')
  const receipt = await readFile(join(dir, 'receipt.json')); validateFormalReceipt(receipt)
  const treeRecord = await readFile(join(dir, 'trees-after.json'))
  const sourceRecord = await readFile(join(root, 'output/renderer-about-update-r79-2026-11-02/browser-driver/lifecycle-pins/source-current.json'))
  validateFrozenRecords(treeRecord, sourceRecord)
  const records = JSON.parse(treeRecord)
  const expected = records.filter(x => ROOTS.some(prefix => x.path.startsWith(`${prefix}/`))).sort((a, b) => a.path.localeCompare(b.path))
  const actual = (await Promise.all(ROOTS.map(prefix => tree(root, join(root, prefix))))).flat().sort((a, b) => a.path.localeCompare(b.path))
  assert.deepEqual(actual, expected, 'Formal tree differs from recorded complete tree')
  for (let i = 0; i < ROOTS.length; i++) assert.equal(sha(await readFile(join(root, ROOTS[i], 'build-provenance.json'))), PROVENANCE[i])
  const manifest = JSON.parse(sourceRecord)
  assert.equal(manifest.length, 39); assert.equal(new Set(manifest.map(entry => entry.path)).size, 39)
  for (const entry of manifest) { const bytes = await readFile(join(root, entry.path)); assert.equal(bytes.length, entry.bytes, entry.path); assert.equal(sha(bytes), entry.sha256, entry.path) }
  const updater = await captureUpdaterBrowserIdentity({ root, receiptPath: join(root, 'output/renderer-updater-r78-2026-11-02/build/840bb5d8-41b3-43c8-b40d-c3595b8925fb/receipt.json'), authoredFiles: [] })
  assert.equal(updater.provenanceSha256, PROVENANCE[2])
  const identity = await captureZtoolsSettingsInputIdentity({ root, authoredFiles })
  const validation = await validateZtoolsSettingsInputIdentity({ root, identity })
  assert.deepEqual(validation.errors, [])
  return { identity, validation, updater, trees: actual, receiptSha256: RECEIPT }
}
