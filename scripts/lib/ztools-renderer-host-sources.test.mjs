import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertRendererHostSources, captureRendererHostSources } from './ztools-renderer-host-sources.mjs';

const actualPackage = fileURLToPath(new URL('../../packages/ztools-renderer/', import.meta.url));
test('native snapshot matches current R69 formal source provenance including both compatibility helpers', async () => {
  const provenance = JSON.parse(await readFile(join(actualPackage, 'dist/build-provenance.json'), 'utf8'));
  const sources = await assertRendererHostSources(actualPackage, provenance);
  for (const path of ['upstream-compatibility-patches.mjs', 'src/builtinShortcutsCompatibility.mjs']) {
    assert.ok(sources.some(source => source.path === path));
  }
});

test('actual root or nested helper changes are rejected against the frozen provenance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atools-host-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'source-manifest.json'), JSON.stringify({ build: {
    hostAdapterSourceExtensions: ['.ts', '.mjs'], hostBuildHelperModules: ['compatibility.mjs'],
  } }));
  await writeFile(join(root, 'src/adapter.ts'), 'adapter');
  await writeFile(join(root, 'src/nested.mjs'), 'nested helper');
  await writeFile(join(root, 'compatibility.mjs'), 'root helper');
  const provenance = { hostAdapterSources: await captureRendererHostSources(root) };
  for (const path of ['compatibility.mjs', 'src/nested.mjs']) {
    const before = await readFile(join(root, path));
    await writeFile(join(root, path), 'tampered');
    await assert.rejects(assertRendererHostSources(root, provenance), /differ from formal dist provenance/);
    await writeFile(join(root, path), before);
  }
  await assertRendererHostSources(root, provenance);
  await writeFile(join(root, 'source-manifest.json'), JSON.stringify({ build: {
    hostAdapterSourceExtensions: ['.ts'], hostBuildHelperModules: ['../outside.mjs'],
  } }));
  await assert.rejects(captureRendererHostSources(root), /relative build helpers/);
});
