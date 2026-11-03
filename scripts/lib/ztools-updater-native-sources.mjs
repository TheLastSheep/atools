import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { captureNativeSourceSnapshot, fingerprintNativeExecutable, validateNativeBuildReceipt } from './ztools-renderer-native-source-binding.mjs';
import { setupNativeRendererSourceLock } from './ztools-renderer-native-source-snapshots.mjs';
import { validateRendererNativeProvenance } from './ztools-renderer-native-provenance.mjs';
import { assertCatalogNativeSourceRecords } from './ztools-catalog-native-source-records.mjs';
import { captureSettingsNativeSources } from './ztools-settings-native-sources.mjs';
import { readJsonNoFollow } from './ztools-renderer-native-runtime.mjs';
import { snapshotFiles, sha256 } from '../../packages/ztools-build/pinned-inputs.mjs';
import { captureUpdaterNativeAssets } from './ztools-updater-native-assets.mjs';
import { NATIVE_RUNNER_FILES, assertUpdaterBuildReceipt } from './ztools-updater-native-protocol.mjs';

export async function captureUpdaterRuntimeAssets(root) {
  const upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE;
  assert.equal(upstreamPath, '/Users/harris/Desktop/ZTools', 'Use the fixed pinned upstream checkout');
  const packageRoot = join(root, 'packages/ztools-renderer'), distRoot = join(packageRoot, 'dist');
  const main = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles: NATIVE_RUNNER_FILES });
  assert.deepEqual(main.snapshot.errors, []);
  const mainManifest = JSON.parse(await readFile(join(packageRoot, 'source-manifest.json')));
  const mainProvenance = JSON.parse(await readFile(join(distRoot, 'build-provenance.json')));
  const actualSources = await main.sourceLock.readHostAdapterSources();
  assertCatalogNativeSourceRecords(actualSources, mainProvenance.hostAdapterSources);
  let jsBytes = 0;
  for (const path of Object.keys(main.snapshot.distFiles).filter(path => /\.m?js$/.test(path))) jsBytes += (await readFile(join(root, path))).length;
  validateRendererNativeProvenance(mainManifest, mainProvenance, main.snapshot.upstream, jsBytes);
  assert.equal(mainManifest.build.budgetMilestone, 'original-vue-main-updater-2026-11-02', 'Reject stale R77 Main artifacts');
  const settings = await captureSettingsNativeSources(root);
  const updater = await captureUpdaterNativeAssets(root, NATIVE_RUNNER_FILES);
  return { main: main.snapshot, settings, updater };
}

export async function validateUpdaterCompiledInputs(root, receiptPath, receipt, assets) {
  assert.equal(await realpath(receiptPath), receiptPath);
  const records = {};
  for (const name of ['native-sources-before.json', 'native-sources-after.json', 'compiled-inputs-before.json', 'compiled-inputs-after.json']) {
    records[name] = await readJsonNoFollow(join(dirname(receiptPath), name), 8 * 1024 * 1024);
  }
  const nativeBefore = records['native-sources-before.json'], nativeAfter = records['native-sources-after.json'];
  assert.deepEqual(nativeBefore, nativeAfter, 'Actual fresh compile Native inputs must be stable');
  const nativeCurrent = await captureNativeSourceSnapshot(root);
  assert.deepEqual(nativeCurrent, nativeAfter, 'Current Native closure must match fresh compiled inputs');
  const before = records['compiled-inputs-before.json'], after = records['compiled-inputs-after.json'];
  assert.deepEqual(before, after, 'Actual supplemental compile inputs must be stable');
  assert.deepEqual(after.unresolved, []); assert.equal(receipt.supplementalCompiledInputs.stable, true);
  assert.deepEqual(receipt.supplementalCompiledInputs.unresolved, []);
  assert.ok(Array.isArray(after.files) && after.files.length > 0 && after.files.length <= 4096);
  const current = await snapshotFiles(root, after.files.map(file => file.path));
  assert.deepEqual(current, after.files, 'Current compiled asset/source inputs must match fresh build');
  const digest = sha256(JSON.stringify(current));
  assert.equal(after.sha256, digest); assert.equal(after.fileCount, current.length);
  assert.equal(after.totalBytes, current.reduce((total, file) => total + file.bytes, 0));
  for (const key of ['sha256', 'fileCount', 'totalBytes']) assert.equal(receipt.supplementalCompiledInputs[key], after[key]);
  for (const file of assets.updater.files) assert.ok(current.some(record => record.path === `dist-ztools-updater/${file.path}` && record.bytes === file.bytes && record.sha256 === file.sha256), 'All seven updater files must be actual fresh compiled inputs');
  return { native: nativeCurrent, supplemental: after };
}

export async function preflightUpdaterNative(root, cli) {
  const assets = await captureUpdaterRuntimeAssets(root);
  assert.equal(await realpath(cli.binary), cli.binary); const binaryInfo = await lstat(cli.binary);
  assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink());
  const binary = await fingerprintNativeExecutable(cli.binary);
  const receipt = await readJsonNoFollow(cli.buildReceipt, 1024 * 1024);
  const compiled = await validateUpdaterCompiledInputs(root, cli.buildReceipt, receipt, assets);
  assert.equal(validateNativeBuildReceipt({ exists: true, value: receipt }, compiled.native, binary.sha256).valid, true);
  assertUpdaterBuildReceipt(receipt, { binary, nativeSources: compiled.native, updaterFiles: assets.updater.files });
  const receiptBytes = await readFile(cli.buildReceipt);
  assert.deepEqual(await fingerprintNativeExecutable(cli.binary), binary, 'Binary changed during preflight');
  return { assets, binary, compiled, receipt, receiptSha256: sha256(receiptBytes) };
}
