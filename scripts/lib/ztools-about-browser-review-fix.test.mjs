import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { validateFrozenRecords, validateFormalReceipt, assertAboutIdentityStable } from './ztools-about-browser-preflight.mjs'
import { finishAboutCleanup } from './ztools-about-browser-cleanup.mjs'

test('fixed records reject a forged same-size JS replacement and source-record replacement', async () => {
  const tree = await readFile('output/renderer-about-update-r79-2026-11-02/frontend/lifecycle-close/formal-build/trees-after.json')
  const sources = await readFile('output/renderer-about-update-r79-2026-11-02/browser-driver/lifecycle-pins/source-current.json')
  assert.doesNotThrow(() => validateFrozenRecords(tree, sources))
  const entries = JSON.parse(tree), entry = entries.find(x => x.path.startsWith('packages/ztools-renderer/dist/assets/') && x.path.endsWith('.js'))
  const original = await readFile(entry.path), replacement = Buffer.from(original); replacement[0] ^= 1
  assert.equal(replacement.length, original.length)
  const forgedHash = createHash('sha256').update(replacement).digest('hex')
  const forgedTree = Buffer.from(tree.toString().replace(entry.sha256, forgedHash))
  assert.equal(forgedTree.length, tree.length); assert.notDeepEqual(forgedTree, tree)
  assert.throws(() => validateFrozenRecords(forgedTree, sources), /tree record changed/)
  const sourceHash = JSON.parse(sources)[0].sha256; const replacementHash = sourceHash[0] === 'f' ? 'e'.repeat(64) : 'f'.repeat(64)
  const forgedSources = Buffer.from(sources.toString().replace(sourceHash, replacementHash))
  assert.equal(forgedSources.length, sources.length); assert.throws(() => validateFrozenRecords(tree, forgedSources), /source record changed/)
})
test('postflight refuses any dependency or resource drift', () => {
  const before = { trees: [{ path: 'asset.js', sha256: 'one' }], updater: { host: 'one' } }
  assert.doesNotThrow(() => assertAboutIdentityStable(before, structuredClone(before)))
  assert.throws(() => assertAboutIdentityStable(before, { ...before, updater: { host: 'two' } }))
  assert.throws(() => assertAboutIdentityStable(before, { ...before, trees: [{ path: 'asset.js', sha256: 'two' }] }))
})
test('never-settling Native request times out while caller cleanup and report still run', async () => {
  const pending = new Set([new Promise(() => {})]), reached = [], report = { errors: [] }
  await finishAboutCleanup({ pending, timeoutMs: 25, onTimeout: () => report.errors.push('pending Native deadline'),
    cleanup: async () => reached.push('cleanup'), writeReport: async () => reached.push('report') })
  assert.deepEqual(reached, ['cleanup', 'report']); assert.deepEqual(report.errors, ['pending Native deadline'])
})


test('new formal receipt and records reject the previously frozen About bundle', async () => {
  const current = await readFile('output/renderer-about-update-r79-2026-11-02/frontend/lifecycle-close/formal-build/receipt.json')
  const old = await readFile('output/renderer-about-update-r79-2026-11-02/frontend/formal-build/receipt.json')
  const oldTree = await readFile('output/renderer-about-update-r79-2026-11-02/frontend/formal-build/after-settings.json')
  const oldSource = await readFile('output/renderer-about-update-r79-2026-11-02/frontend/source-freeze/source-final.json')
  const currentTree = await readFile('output/renderer-about-update-r79-2026-11-02/frontend/lifecycle-close/formal-build/trees-after.json')
  const currentSource = await readFile('output/renderer-about-update-r79-2026-11-02/browser-driver/lifecycle-pins/source-current.json')
  assert.doesNotThrow(() => validateFormalReceipt(current)); assert.throws(() => validateFormalReceipt(old))
  assert.throws(() => validateFrozenRecords(oldTree,currentSource)); assert.throws(() => validateFrozenRecords(currentTree,oldSource))
})
