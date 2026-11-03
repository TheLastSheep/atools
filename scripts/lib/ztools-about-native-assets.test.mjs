import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, lstat, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stageAboutNativeAssets, verifyAboutStagedAssets } from './ztools-about-native-assets.mjs';
import { captureAboutRuntimeAssets } from './ztools-about-native-sources.mjs';

test('actual formal Main+Settings stage under one owned App; altered tree and foreign ownership reject', async () => {
  process.env.ATOOLS_ZTOOLS_SOURCE = '/Users/harris/Desktop/ZTools';
  const assets = await captureAboutRuntimeAssets(process.cwd());
  const scratch = await mkdtemp('/private/tmp/atools-about-node-test-');
  try {
    const bundlePath = join(scratch, 'case-never.app');
    await mkdir(join(bundlePath, 'Contents/Resources'), { recursive: true, mode: 0o700 });
    const info = await lstat(bundlePath, { bigint: true }), runId = 'a'.repeat(32);
    const staged = { bundlePath, runId, identifier: `dev.atools.renderer-smoke.${runId}`, ownerIdentity: `${info.dev}:${info.ino}` };
    await assert.rejects(stageAboutNativeAssets({ assets, staged: { ...staged, ownerIdentity: 'foreign' } }));
    const result = await stageAboutNativeAssets({ assets, staged });
    assert.equal(result.mainDist, join(bundlePath, 'Contents/Resources/ztools-renderer'));
    assert.equal(result.settings.fileCount, 55);
    await verifyAboutStagedAssets({ assets, staged });
    await writeFile(join(result.mainDist, 'extra.js'), 'untrusted');
    await assert.rejects(verifyAboutStagedAssets({ assets, staged }));
    await rm(join(result.mainDist, 'extra.js'));
    await symlink('/private/tmp', join(result.mainDist, 'link'));
    await assert.rejects(verifyAboutStagedAssets({ assets, staged }));
  } finally { await rm(scratch, { recursive: true }); }
});
