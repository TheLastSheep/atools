import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../../packages/ztools-build/pinned-inputs.mjs';
import { stageSettingsNativeBundle } from './ztools-settings-native-sources.mjs';

async function tree(root) {
  const files = {};
  async function visit(directory, prefix = '') {
    assert.equal(await realpath(directory), directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name), path = prefix + entry.name, info = await lstat(full);
      assert.equal(info.isSymbolicLink(), false, 'About resource symlink rejected');
      if (info.isDirectory()) await visit(full, path + '/');
      else {
        assert.ok(info.isFile() && info.size <= 2 * 1024 * 1024);
        files[path] = { bytes: info.size, sha256: sha256(await readFile(full)) };
        assert.ok(Object.keys(files).length <= 128);
      }
    }
  }
  await visit(root); return files;
}
function mainFiles(assets) {
  const prefix = 'packages/ztools-renderer/dist/';
  return Object.fromEntries(Object.entries(assets.main.distFiles).map(([path, hash]) => {
    assert.ok(path.startsWith(prefix)); return [path.slice(prefix.length), hash];
  }));
}
export async function verifyAboutStagedAssets({ assets, staged }) {
  const resources = join(staged.bundlePath, 'Contents/Resources');
  const main = await tree(join(resources, 'ztools-renderer'));
  assert.deepEqual(Object.fromEntries(Object.entries(main).map(([p, f]) => [p, f.sha256])), mainFiles(assets));
  const settings = await tree(join(resources, 'ztools-settings'));
  assert.deepEqual(settings, Object.fromEntries(assets.settings.bundle.files.map(({ path, bytes, sha256 }) => [path, { bytes, sha256 }])));
}
export async function stageAboutNativeAssets({ assets, staged }) {
  assert.equal(staged.identifier, `dev.atools.renderer-smoke.${staged.runId}`);
  const info = await lstat(staged.bundlePath, { bigint: true });
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(`${info.dev}:${info.ino}`, staged.ownerIdentity);
  const mainDist = join(staged.bundlePath, 'Contents/Resources/ztools-renderer');
  const source = join(assets.settings.repositoryRoot, 'packages/ztools-renderer/dist');
  const captured = await tree(source);
  assert.deepEqual(Object.fromEntries(Object.entries(captured).map(([p, f]) => [p, f.sha256])), mainFiles(assets));
  await mkdir(mainDist, { mode: 0o700 });
  for (const path of Object.keys(captured)) {
    assert.ok(path.split('/').every(p => p && p !== '.' && p !== '..') && !path.includes('\\'));
    let parent = mainDist;
    for (const part of path.split('/').slice(0, -1)) {
      parent = join(parent, part); await mkdir(parent, { recursive: true, mode: 0o700 });
    }
    await copyFile(join(source, path), join(mainDist, path), constants.COPYFILE_EXCL);
    await chmod(join(mainDist, path), 0o600);
  }
  const settings = await stageSettingsNativeBundle({ snapshot: assets.settings, appBundlePath: staged.bundlePath });
  await verifyAboutStagedAssets({ assets, staged });
  assert.deepEqual(await tree(source), captured, 'Main resources changed during staging');
  return { mainDist, main: captured, settings };
}
