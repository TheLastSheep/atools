import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { captureUpdaterBrowserIdentity } from './ztools-updater-browser-identity.mjs';
import { sha256 } from '../../packages/ztools-build/pinned-inputs.mjs';
import { UPDATER_FORMAL_RECEIPT, UPDATER_PROVENANCE_SHA } from './ztools-updater-native-protocol.mjs';

export async function hashUpdaterTree(root) {
  assert.equal(await realpath(root), root); const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = join(directory, entry.name), path = prefix + entry.name, info = await lstat(full);
      assert.equal(info.isSymbolicLink(), false, 'Updater tree symlink rejected');
      if (info.isDirectory()) { assert.equal(path, 'assets', 'Extra updater directory'); await walk(full, path + '/'); }
      else {
        assert.ok(info.isFile() && info.size <= 512 * 1024, 'Bounded regular updater file required');
        const bytes = await readFile(full); files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
        assert.ok(files.length <= 7, 'Extra updater file');
      }
    }
  }
  await walk(root); assert.equal(files.length, 7, 'Exactly seven updater files required');
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function captureUpdaterNativeAssets(root, authoredFiles) {
  const identity = await captureUpdaterBrowserIdentity({ root, receiptPath: join(root, UPDATER_FORMAL_RECEIPT), authoredFiles });
  assert.equal(identity.provenanceSha256, UPDATER_PROVENANCE_SHA);
  const distRoot = join(root, 'dist-ztools-updater'), files = await hashUpdaterTree(distRoot);
  for (const file of files) assert.deepEqual(identity.files[file.path], { bytes: file.bytes, sha256: file.sha256 });
  return { distRoot, files, identity };
}
export async function stageUpdaterNativeAssets({ snapshot, staged }) {
  assert.equal(staged.identifier, `dev.atools.renderer-smoke.${staged.runId}`);
  assert.equal(staged.bundlePath, join(staged.runDirectory, 'case-never.app'));
  assert.equal(staged.mode, 'multiwebview');
  const appInfo = await lstat(staged.bundlePath, { bigint: true });
  assert.ok(appInfo.isDirectory() && !appInfo.isSymbolicLink());
  assert.equal(`${appInfo.dev}:${appInfo.ino}`, staged.ownerIdentity, 'Owned app identity changed');
  for (const directory of [staged.bundlePath, join(staged.bundlePath, 'Contents'), join(staged.bundlePath, 'Contents/Resources')]) {
    assert.equal(await realpath(directory), directory); const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
  }
  assert.deepEqual(await hashUpdaterTree(snapshot.distRoot), snapshot.files, 'Updater input changed before staging');
  const target = join(staged.bundlePath, 'Contents/Resources/ztools-updater');
  await mkdir(target, { mode: 0o700 });
  for (const file of snapshot.files) {
    const pieces = file.path.split('/');
    assert.ok(pieces.every(piece => piece && piece !== '.' && piece !== '..') && !file.path.includes('\\'));
    if (pieces.length > 1) await mkdir(join(target, ...pieces.slice(0, -1)), { recursive: true, mode: 0o700 });
    await copyFile(join(snapshot.distRoot, file.path), join(target, file.path), constants.COPYFILE_EXCL);
    await chmod(join(target, file.path), 0o600);
  }
  assert.deepEqual(await hashUpdaterTree(target), snapshot.files, 'Staged updater differs by set/size/SHA');
  assert.deepEqual(await hashUpdaterTree(snapshot.distRoot), snapshot.files, 'Updater input drift during staging');
  return { resourcePath: 'Contents/Resources/ztools-updater', files: snapshot.files,
    provenanceSha256: snapshot.identity.provenanceSha256, staged: true };
}
