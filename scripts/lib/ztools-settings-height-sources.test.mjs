import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ROOT, assertHeightMainDist, assertHeightSourcesStable } from './ztools-settings-height-sources.mjs';
import { parseHeightRunnerArgs } from '../test-ztools-settings-height-native.mjs';
import { validateNativeBuildReceipt } from './ztools-renderer-native-source-binding.mjs';

test('CLI accepts only the two absolute input paths, no eval/seed/case override', () => {
  assert.deepEqual(parseHeightRunnerArgs(['--binary', '/tmp/bin', '--build-receipt', '/tmp/receipt']), { binary: '/tmp/bin', receipt: '/tmp/receipt' });
  for (const args of [[], ['--binary', 'relative'], ['--eval', '1'], ['--binary', '/tmp/bin', '--binary', '/tmp/other'],
    ['--binary', '/tmp/bin', '--build-receipt', '/tmp/r', '--height-case', 'a'], ['--seed', '/tmp/seed']]) {
    assert.throws(() => parseHeightRunnerArgs(args));
  }
});

test('source closure rejects native, binary, helper, dist and receipt drift', () => {
  const before = { native: { sha256: 'a' }, executable: { inode: '1' }, receiptSha256: 'b', main: { packageFiles: { helper: 'c' } }, settings: { distSha256: 'd' } };
  assert.doesNotThrow(() => assertHeightSourcesStable(before, structuredClone(before)));
  for (const key of Object.keys(before)) {
    const after = structuredClone(before); after[key] = null;
    assert.throws(() => assertHeightSourcesStable(before, after), /drifted/);
  }
});

test('reuses strict R68 native receipt binding rather than accepting a filename', () => {
  const native = { sha256: 'a'.repeat(64), fileCount: 3 }, binarySha = 'b'.repeat(64);
  const value = { schemaVersion: 1, binary: { sha256: binarySha }, nativeSources: { ...native, stable: true } };
  assert.equal(validateNativeBuildReceipt({ exists: true, value }, native, binarySha).valid, true);
  for (const mutate of [r => { r.binary.sha256 = 'c'.repeat(64); }, r => { r.nativeSources.stable = false; }, r => { r.nativeSources.sha256 = 'c'.repeat(64); }]) {
    const copy = structuredClone(value); mutate(copy);
    assert.equal(validateNativeBuildReceipt({ exists: true, value: copy }, native, binarySha).valid, false);
  }
});

test('same-size Main JS substitution cannot hide behind unchanged build provenance', async () => {
  const frozen = JSON.parse(await readFile(`${ROOT}/output/renderer-settings-height-r75-2026-11-02/frontend/main-before.json`, 'utf8'));
  const files = Object.fromEntries(Object.entries(frozen).map(([path, hash]) => [`packages/ztools-renderer/dist/${path}`, hash]));
  assert.doesNotThrow(() => assertHeightMainDist(files));
  const changed = structuredClone(files), javascript = Object.keys(changed).find(path => path.endsWith('.js'));
  changed[javascript] = '0'.repeat(64);
  assert.throws(() => assertHeightMainDist(changed));
});
