import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Read the formal build's declared adapter extensions and root helpers. */
export async function captureRendererHostSources(packageRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'source-manifest.json'), 'utf8'));
  const extensions = manifest.build?.hostAdapterSourceExtensions;
  const helpers = manifest.build?.hostBuildHelperModules;
  assert.ok(Array.isArray(extensions) && extensions.length > 0 && extensions.length <= 8
    && new Set(extensions).size === extensions.length
    && extensions.every(value => typeof value === 'string' && /^\.[a-z]+$/.test(value)),
  'Formal renderer manifest must declare bounded unique host source extensions');
  assert.ok(Array.isArray(helpers) && helpers.length > 0 && helpers.length <= 16
    && new Set(helpers).size === helpers.length
    && helpers.every(value => typeof value === 'string' && !isAbsolute(value)
      && value.split('/').every(part => part && part !== '.' && part !== '..') && !value.includes('\\')),
  'Formal renderer manifest must declare bounded relative build helpers');
  const paths = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Host source snapshots reject symbolic links');
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && extensions.some(extension => entry.name.endsWith(extension))) paths.push(absolute);
    }
  }
  await walk(join(packageRoot, 'src'));
  for (const helper of helpers) {
    let absolute = packageRoot;
    for (const part of helper.split('/')) {
      absolute = join(absolute, part);
      assert.ok(!(await lstat(absolute)).isSymbolicLink(), 'Build helpers reject symbolic links');
    }
    assert.ok((await lstat(absolute)).isFile(), 'Build helper must be a regular file');
    paths.push(absolute);
  }
  assert.equal(new Set(paths).size, paths.length, 'Duplicate host source input');
  const sources = await Promise.all(paths.map(async file => {
    const bytes = await readFile(file);
    return { path: relative(packageRoot, file).split(sep).join('/'),
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
  }));
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertRendererHostSources(packageRoot, provenance) {
  const sources = await captureRendererHostSources(packageRoot);
  assert.deepEqual(sources, provenance?.hostAdapterSources,
    'Current host source inputs differ from formal dist provenance');
  return sources;
}
