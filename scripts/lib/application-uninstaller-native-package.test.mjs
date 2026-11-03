import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { copyApplicationPackageTree } from './application-uninstaller-native-package.mjs';

async function makeFixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'atools-source-copy-contract-'));
  const source = join(scratch, 'source');
  const destination = join(scratch, 'copy');
  const outside = join(scratch, 'absolute-target.js');
  await mkdir(join(source, 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(source, 'node_modules', 'pkg', 'bin'), { recursive: true });
  await mkdir(join(source, 'outside'), { recursive: true });
  await writeFile(join(source, 'node_modules', 'pkg', 'bin', 'tool.js'), 'tool');
  await writeFile(join(source, 'outside', 'relative.js'), 'relative external target');
  await writeFile(outside, 'absolute external target');
  await symlink('../pkg/bin/tool.js', join(source, 'node_modules', '.bin', 'tool'));
  await symlink('pkg', join(source, 'node_modules', 'pkg-alias'));
  await symlink('../outside/relative.js', join(source, 'node_modules', 'relative-escape'));
  await symlink(outside, join(source, 'node_modules', 'absolute-escape'));
  return { scratch, source, destination, outside };
}

async function inside(root, candidate) {
  const rel = relative(await realpath(root), candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

test('copy preserves internal relative links and keeps external links visibly external', async () => {
  const fixture = await makeFixture();
  try {
    const sourceDependencies = join(fixture.source, 'node_modules');
    const copiedDependencies = join(fixture.destination, 'node_modules');
    const originalTargets = new Map([
      ['.bin/tool', await readlink(join(sourceDependencies, '.bin', 'tool'))],
      ['pkg-alias', await readlink(join(sourceDependencies, 'pkg-alias'))],
      ['relative-escape', await readlink(join(sourceDependencies, 'relative-escape'))],
      ['absolute-escape', await readlink(join(sourceDependencies, 'absolute-escape'))],
    ]);

    await copyApplicationPackageTree(fixture.source, fixture.destination);

    const internalPaths = [
      ['.bin/tool', join(copiedDependencies, '.bin', 'tool')],
      ['pkg-alias', join(copiedDependencies, 'pkg-alias')],
    ];
    for (const [name, path] of internalPaths) {
      assert.equal(await readlink(path), originalTargets.get(name));
      assert.equal(await inside(copiedDependencies, await realpath(path)), true, `${name} resolves within copied node_modules`);
    }

    const relativeEscape = join(copiedDependencies, 'relative-escape');
    const absoluteEscape = join(copiedDependencies, 'absolute-escape');
    assert.equal(await readlink(relativeEscape), originalTargets.get('relative-escape'));
    assert.equal(await readlink(absoluteEscape), originalTargets.get('absolute-escape'));
    assert.equal(await inside(copiedDependencies, await realpath(relativeEscape)), false);
    assert.equal(await inside(copiedDependencies, await realpath(absoluteEscape)), false);
    assert.equal(await realpath(relativeEscape), await realpath(join(fixture.destination, 'outside', 'relative.js')));
    assert.equal(await realpath(absoluteEscape), await realpath(fixture.outside));

    for (const [name, rawTarget] of originalTargets) {
      assert.equal(await readlink(join(sourceDependencies, ...name.split('/'))), rawTarget, `source link ${name} remains unchanged`);
    }
  } finally {
    await rm(fixture.scratch, { recursive: true, force: true });
  }
});
