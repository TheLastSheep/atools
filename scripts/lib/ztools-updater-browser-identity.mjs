import assert from 'node:assert/strict';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { capturePinnedSource, captureDependencyClosure, snapshotFiles, sha256 } from '../../packages/ztools-build/pinned-inputs.mjs';
import { createRendererPostMinifier } from '../../packages/ztools-renderer/post-minifier.mjs';
import { patchUpdater, UPDATER_PATCH, updaterPatchReceipt } from '../../packages/ztools-updater/src/sourceCompatibility.mjs';

export const UPDATER_COMMIT = '9b15fb1a2a9f3ec886016632761c7bb21e39557a';
export const UPDATER_LIMITS = Object.freeze({ javascript: 120714, resources: 300982 });
const metadata = ['ZTools-LICENSE', 'build-provenance.json', 'source-manifest.json'];
export function validateUpdaterResources(receipt, provenance, files) {
  assert.equal(receipt.passed, true); assert.equal(receipt.published, true);
  assert.equal(receipt.output, 'dist-ztools-updater');
  assert.equal(provenance.schemaVersion, 1); assert.equal(provenance.owner, 'atools');
  assert.equal(provenance.role, 'original-updater'); assert.equal(provenance.sourceCommit, UPDATER_COMMIT);
  assert.equal(provenance.nodeVersion, 'v22.23.3');
  assert.deepEqual(receipt.bundle, provenance.bundle);
  const resources = provenance.bundle.resources;
  assert.ok(resources.length && resources.some(f => f.path === 'updater.html'));
  assert.equal(new Set(resources.map(f => f.path)).size, resources.length);
  let total = 0, js = 0;
  for (const item of resources) {
    assert.match(item.path, /^(?:updater\.html|assets\/[A-Za-z0-9_.-]+\.(?:js|css|png))$/);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0);
    assert.deepEqual(files[item.path], { bytes: item.bytes, sha256: item.sha256 }, `Actual resource mismatch: ${item.path}`);
    total += item.bytes; if (item.path.endsWith('.js')) js += item.bytes;
  }
  assert.deepEqual(Object.keys(files).sort(), [...resources.map(f => f.path), ...metadata].sort(), 'No extra or unbound dist files');
  assert.equal(total, provenance.bundle.totalResourceBytes); assert.equal(js, provenance.bundle.totalJavaScriptBytes);
  assert.ok(js > 0 && js <= UPDATER_LIMITS.javascript && total <= UPDATER_LIMITS.resources, 'Both immutable budget caps apply');
  assert.deepEqual(provenance.budget.javascript, { baselineBytes: 104330, maxIncreaseBytes: 16384, maxBytes: 120714 });
  assert.deepEqual(provenance.budget.resources, { baselineBytes: 284598, maxIncreaseBytes: 16384, maxBytes: 300982 });
  assert.equal(provenance.budget.passed, true);
  assert.ok(provenance.typeChecks.length && provenance.typeChecks.every(c => c.success && c.exitCode === 0));
  return resources.map(f => f.path).sort();
}

export async function captureUpdaterBrowserIdentity({ root, receiptPath, authoredFiles }) {
  assert.equal(await realpath(root), root);
  const dist = join(root, 'dist-ztools-updater');
  const files = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name), info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), 'Dist symlink denied');
      if (info.isDirectory()) await walk(absolute);
      else {
        assert.ok(info.isFile());
        const bytes = await readFile(absolute);
        files[relative(dist, absolute).split('\\').join('/')] = { bytes: bytes.length, sha256: sha256(bytes) };
      }
    }
  }
  await walk(dist);
  const receiptBytes = await readFile(receiptPath), receipt = JSON.parse(receiptBytes);
  const provenanceBytes = await readFile(join(dist, 'build-provenance.json'));
  assert.equal(sha256(provenanceBytes), receipt.provenanceSha256, 'Formal publication receipt must bind exact provenance');
  const provenance = JSON.parse(provenanceBytes);
  const servedPaths = validateUpdaterResources(receipt, provenance, files);
  const manifestBytes = await readFile(join(root, 'packages/ztools-updater/source-manifest.json'));
  assert.equal(files['source-manifest.json'].sha256, sha256(manifestBytes));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.source.commit, UPDATER_COMMIT);
  const source = await capturePinnedSource('/Users/harris/Desktop/ZTools', UPDATER_COMMIT, manifest.source.files);
  assert.equal(source.snapshot.sha256, provenance.sourceTreeSha256);
  assert.equal(source.snapshot.files, provenance.sourceFiles); assert.equal(source.snapshot.bytes, provenance.sourceBytes);
  const host = await snapshotFiles(root, provenance.hostAdapterSources.map(f => f.path));
  assert.deepEqual(host, provenance.hostAdapterSources, 'Current host/build sources must match compiled provenance');
  for (const name of await readdir(join(root, 'packages/ztools-updater/src'))) {
    if (/\.(?:ts|mjs)$/.test(name)) assert.ok(host.some(f => f.path === `packages/ztools-updater/src/${name}`), `Unbound runtime source ${name}`);
  }
  const staged = new Map(provenance.compiledStageInputs.map(f => [f.path, f]));
  for (const file of source.files) {
    let bytes = await readFile(join(source.root, file));
    if (file === UPDATER_PATCH.path) {
      const before = bytes.toString('utf8'), after = patchUpdater(before);
      assert.deepEqual(provenance.upstreamCompatibilityPatches, [updaterPatchReceipt(before, after)]);
      bytes = Buffer.from(after);
    }
    if (file.endsWith('/updater-main.ts')) bytes = Buffer.concat([Buffer.from("import '@atools-updater/entry'\n"), bytes]);
    const entry = staged.get('upstream/' + file);
    assert.ok(entry, `Missing actual staged source ${file}`);
    assert.equal(entry.sha256, sha256(bytes)); assert.equal(entry.bytes, bytes.length);
  }
  for (const file of host.filter(f => /^packages\/ztools-updater\/src\/[^/]+\.ts$/.test(f.path))) {
    const entry = staged.get('host/' + file.path.split('/').at(-1));
    assert.ok(entry); assert.equal(entry.sha256, file.sha256); assert.equal(entry.bytes, file.bytes);
  }
  const logo = await readFile(join(source.root, 'src/renderer/src/assets/logo.png'));
  assert.ok(provenance.bundle.resources.some(f => f.path.endsWith('.png') && f.sha256 === sha256(logo) && f.bytes === 170073));
  assert.equal(files['ZTools-LICENSE'].sha256, sha256(await readFile(join(source.root, 'LICENSE'))));
  const upstreamDeps = await captureDependencyClosure(source.root, manifest.reusedDependencies);
  const repositoryDeps = await captureDependencyClosure(root, manifest.repositoryDependencies);
  const dependencies = [...upstreamDeps.packages, ...repositoryDeps.packages].map(record => ({
    name: record.name, version: record.version, path: record.path, files: record.files.length,
    bytes: record.files.reduce((n, f) => n + f.bytes, 0), sha256: sha256(JSON.stringify(record.files)),
  }));
  assert.deepEqual(dependencies, provenance.dependencies, 'Exact current recursive dependency closure');
  const post = await createRendererPostMinifier({ packageRoot: join(root, 'packages/ztools-renderer'), expectedVersion: '5.51.2' });
  assert.deepEqual(post.provenance, provenance.postMinifier);
  const authored = await snapshotFiles(root, authoredFiles);
  return { receiptSha256: sha256(receiptBytes), provenanceSha256: sha256(provenanceBytes), source: source.snapshot,
    host, dependencies, postMinifier: post.provenance, files, authored, servedPaths };
}
