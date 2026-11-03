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
import { assertUpdaterBuildReceipt } from './ztools-updater-native-protocol.mjs';

import { ABOUT_RUNNER_FILES, ABOUT_MAIN_PROVENANCE, ABOUT_MILESTONE, ABOUT_SETTINGS_FORMAL, ABOUT_REPORT_SCHEMA, assertAboutSettingsFreeze } from './ztools-about-native-protocol.mjs';

export async function captureAboutRuntimeAssets(root) {
  assert.equal(sha256(await readFile(join(root, ABOUT_REPORT_SCHEMA.path))), ABOUT_REPORT_SCHEMA.sha256, 'Frozen Native report schema drift');
  const upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE;
  assert.equal(upstreamPath, '/Users/harris/Desktop/ZTools', 'Use the fixed pinned upstream checkout');
  const packageRoot = join(root, 'packages/ztools-renderer'), distRoot = join(packageRoot, 'dist');
  const main = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles: ABOUT_RUNNER_FILES });
  assert.deepEqual(main.snapshot.errors, []);
  const mainManifest = JSON.parse(await readFile(join(packageRoot, 'source-manifest.json')));
  const mainProvenance = JSON.parse(await readFile(join(distRoot, 'build-provenance.json')));
  const actualSources = await main.sourceLock.readHostAdapterSources();
  assertCatalogNativeSourceRecords(actualSources, mainProvenance.hostAdapterSources);
  let jsBytes = 0;
  for (const path of Object.keys(main.snapshot.distFiles).filter(path => /\.m?js$/.test(path))) jsBytes += (await readFile(join(root, path))).length;
  validateRendererNativeProvenance(mainManifest, mainProvenance, main.snapshot.upstream, jsBytes);
  assert.equal(mainManifest.build.budgetMilestone, ABOUT_MILESTONE, 'Reject stale R77 Main artifacts');
  assert.equal(sha256(await readFile(join(distRoot, 'build-provenance.json'))), ABOUT_MAIN_PROVENANCE);
  const settings = await captureSettingsNativeSources(root);
  assertAboutSettingsFreeze(settings);
  const formalPath = join(root, ABOUT_SETTINGS_FORMAL.path);
  const formalBytes = await readFile(formalPath);
  assert.equal(sha256(formalBytes), ABOUT_SETTINGS_FORMAL.sha256, 'Settings formal receipt drift');
  const formal = await readJsonNoFollow(formalPath, 1024 * 1024);
  assert.equal(formal.buildExitCode, 0); assert.equal(formal.strictTypecheckPassed, true);
  assert.equal(formal.oldReaderRejected, true); assert.equal(formal.newReaderExitCode, 0);
  assert.equal(formal.buildInputsStable, true); assert.equal(formal.buildInputsMatchProvenance, true);
  assert.equal(formal.settings.provenanceSha256, settings.bundle.provenanceSha256);
  assert.equal(formal.settings.files, settings.bundle.fileCount);
  assert.equal(formal.settings.totalBytes, settings.bundle.totalBytes);
  assert.equal(formal.settings.emittedResourcesBytes, settings.bundle.resourceBytes);
  const updater = await captureUpdaterNativeAssets(root, ABOUT_RUNNER_FILES);
  return { main: main.snapshot, settings, updater };
}

export async function validateAboutCompiledInputs(root, receiptPath, receipt, assets) {
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
  for (const [prefix, files] of [['packages/ztools-settings/dist/', assets.settings.bundle.files], ['packages/ztools-renderer/dist/', Object.entries(assets.main.distFiles).filter(([path]) => path.startsWith('packages/ztools-renderer/dist/')).map(([path, value]) => ({ path: path.slice('packages/ztools-renderer/dist/'.length), ...(typeof value === 'string' ? { sha256: value } : value) }))]]) {
    for (const file of files) assert.ok(current.some(record => record.path === prefix + file.path && record.sha256 === file.sha256 && (file.bytes === undefined || record.bytes === file.bytes)), 'All actual Main/Settings resources must be fresh compiled inputs');
  }
  return { native: nativeCurrent, supplemental: after };
}

export async function preflightAboutNative(root, cli) {
  const assets = await captureAboutRuntimeAssets(root);
  assert.equal(await realpath(cli.binary), cli.binary); const binaryInfo = await lstat(cli.binary);
  assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink());
  const binary = await fingerprintNativeExecutable(cli.binary);
  const receipt = await readJsonNoFollow(cli.buildReceipt, 1024 * 1024);
  const compiled = await validateAboutCompiledInputs(root, cli.buildReceipt, receipt, assets);
  assert.equal(validateNativeBuildReceipt({ exists: true, value: receipt }, compiled.native, binary.sha256).valid, true);
  assertUpdaterBuildReceipt(receipt, { binary, nativeSources: compiled.native, updaterFiles: assets.updater.files });
  const receiptBytes = await readFile(cli.buildReceipt);
  assert.deepEqual(await fingerprintNativeExecutable(cli.binary), binary, 'Binary changed during preflight');
  return { assets, binary, compiled, receipt, receiptSha256: sha256(receiptBytes) };
}
