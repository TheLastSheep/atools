//! Download pinned official bytes, preflight them, then materialize an owned private fixture.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchBounded } from '../audit-ztools-published-artifacts.mjs';
import { inspectZip } from './published-artifact-zip.mjs';
import { inspectPackage } from './published-artifact-package.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function confinedPath(root, name) {
  if (typeof name !== 'string' || !name || /[\\\u0000-\u001f]/.test(name) || name.startsWith('/')
    || /^[a-z]:/i.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Rejected fixture file path');
  }
  const target = path.resolve(root, ...name.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Fixture path escapes owned root');
  return target;
}
async function privateFile(filename, bytes) {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

export async function materializeInspectedFiles(files, parent = tmpdir()) {
  let owned = null;
  try {
    // Validate every path before creating a directory or writing archive content.
    for (const [name, bytes] of files) {
      confinedPath(path.resolve(parent), name);
      if (!Buffer.isBuffer(bytes)) throw new Error('Fixture file content must be a Buffer');
    }
    owned = await mkdtemp(path.join(parent, 'atools-published-plugin-fixture-'));
    await chmod(owned, 0o700);
    const root = await realpath(owned), contentRoot = path.join(root, 'plugin');
    await mkdir(contentRoot, { mode: 0o700 });
    const metadata = [];
    for (const [name, bytes] of files) {
      const target = confinedPath(contentRoot, name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const canonicalParent = await realpath(path.dirname(target));
      if (canonicalParent !== contentRoot && !canonicalParent.startsWith(`${contentRoot}${path.sep}`)) throw new Error('Fixture parent escaped owned root');
      await privateFile(target, bytes);
      const info = await lstat(target), actualSha256 = sha256(await readFile(target));
      if (!info.isFile() || info.isSymbolicLink() || actualSha256 !== sha256(bytes)) throw new Error('Materialized file identity mismatch');
      metadata.push({ path: name, bytes: bytes.length, sha256: actualSha256, mode: (info.mode & 0o777).toString(8), verifiedUnchanged: true });
    }
    return { ownedRoot: root, contentRoot, files: metadata, rootMode: ((await lstat(root)).mode & 0o777).toString(8) };
  } catch (error) {
    if (owned) await rm(owned, { recursive: true, force: true });
    throw error;
  }
}

export async function preparePublishedPluginFixture(observed, { request = fetch, temporaryParent = tmpdir() } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(observed?.id || '') || !/^[a-f0-9]{64}$/.test(observed.archive?.locallyComputedSha256 || '')) {
    throw new Error('Expected a pinned published-artifact audit candidate');
  }
  const expectedVersion = observed.package?.version;
  if (!expectedVersion || observed.status !== 'static_package_reviewable') throw new Error('Candidate is not statically reviewable in the source audit');
  const http = [], resolverUrl = `https://z-tools.top/api/market/plugins/download?name=${encodeURIComponent(observed.id)}`;
  const resolved = await fetchBounded(resolverUrl, 'json', http, request);
  const metadata = JSON.parse(resolved.bytes.toString('utf8'));
  if (typeof metadata.downloadUrl !== 'string') throw new Error('Official resolver did not return downloadUrl');
  const downloaded = await fetchBounded(metadata.downloadUrl, 'package', http, request);
  const archiveSha256 = sha256(downloaded.bytes);
  if (archiveSha256 !== observed.archive.locallyComputedSha256) throw new Error('Current official ZIP differs from the pinned audited SHA-256');
  // All central/local metadata and content CRCs are checked before materialization.
  const inspected = inspectZip(downloaded.bytes), packageInfo = inspectPackage(inspected.files, observed.id);
  if (inspected.summary.nativeFiles.length || !packageInfo.staticEntryComplete || packageInfo.version !== expectedVersion) {
    throw new Error('Current official ZIP failed pinned version/static/native preconditions');
  }
  let fixture = null;
  try {
    fixture = await materializeInspectedFiles(inspected.files, temporaryParent);
    const archivePath = path.join(fixture.ownedRoot, 'source.zip');
    await privateFile(archivePath, downloaded.bytes);
    if (sha256(await readFile(archivePath)) !== archiveSha256) throw new Error('Retained original archive identity mismatch');
    const packageDirectory = path.posix.dirname(packageInfo.manifestPath);
    const pluginRoot = packageDirectory === '.' ? fixture.contentRoot : confinedPath(fixture.contentRoot, packageDirectory);
    return { ...fixture, pluginRoot, archivePath, archiveSha256, archiveBytes: downloaded.bytes.length,
      id: observed.id, version: packageInfo.version, sourceUrl: downloaded.url, resolverUrl, http,
      zip: inspected.summary, package: packageInfo, expectedSha256Matched: true, expectedVersionMatched: true,
      retainedForParent: true, noPluginCodeExecuted: true, isolationBoundary: '0700 owned directory and 0600 files protect local fixture ownership only; neither a private HOME nor this directory is an OS sandbox.' };
  } catch (error) {
    if (fixture) await rm(fixture.ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function readVerifiedPublishedPluginFixture(fixture, expectedSha256) {
  const root = await realpath(fixture.ownedRoot), info = await lstat(fixture.ownedRoot);
  if (root !== path.resolve(fixture.ownedRoot) || !path.basename(root).startsWith('atools-published-plugin-fixture-')
    || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
    || fixture.contentRoot !== path.join(root, 'plugin') || fixture.archivePath !== path.join(root, 'source.zip')) {
    throw new Error('Fixture ownership/path/mode verification failed');
  }
  const archiveInfo = await lstat(fixture.archivePath);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 50 * 1024 * 1024) throw new Error('Retained ZIP is not a bounded regular file');
  const archive = await readFile(fixture.archivePath);
  if (sha256(archive) !== expectedSha256) throw new Error('Retained ZIP no longer matches the expected audited SHA-256');
  const inspected = inspectZip(archive), packageInfo = inspectPackage(inspected.files, fixture.id);
  const contentInfo = await lstat(fixture.contentRoot);
  if (!contentInfo.isDirectory() || contentInfo.isSymbolicLink()) throw new Error('Fixture content root is not an owned directory');
  const actualFiles = [];
  let filesystemEntries = 0;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > 32) throw new Error('Fixture directory depth exceeded');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++filesystemEntries > 8192) throw new Error('Fixture filesystem entry quota exceeded');
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, filename = confinedPath(fixture.contentRoot, name);
      const item = await lstat(filename);
      if (item.isSymbolicLink()) throw new Error('Fixture now contains a symlink');
      if (item.isDirectory()) await walk(filename, name, depth + 1);
      else if (item.isFile()) actualFiles.push(name);
      else throw new Error('Fixture now contains a special filesystem entry');
    }
  }
  await walk(fixture.contentRoot);
  if (actualFiles.length !== inspected.files.size) throw new Error('Fixture file count changed');
  for (const [name, bytes] of inspected.files) {
    const filename = confinedPath(fixture.contentRoot, name), item = await lstat(filename);
    if (!item.isFile() || item.isSymbolicLink() || item.size !== bytes.length || sha256(await readFile(filename)) !== sha256(bytes)) {
      throw new Error(`Fixture source bytes changed: ${name}`);
    }
  }
  const manifestDirectory = path.posix.dirname(packageInfo.manifestPath);
  const expectedRoot = manifestDirectory === '.' ? fixture.contentRoot : confinedPath(fixture.contentRoot, manifestDirectory);
  if (fixture.pluginRoot !== expectedRoot || packageInfo.version !== fixture.version) throw new Error('Fixture manifest root/version changed');
  const verification = { verifiedAt: new Date().toISOString(), unchangedFileCount: inspected.files.size, archiveSha256: expectedSha256,
    sourceBytesUnchanged: true, package: packageInfo, noPluginCodeExecuted: true };
  // This Map is an explicit in-process API result, never report metadata. Reviewers use
  // these exact pinned-ZIP buffers instead of reopening same-UID-mutable source paths.
  return { verification, files: inspected.files };
}

export async function verifyPublishedPluginFixture(fixture, expectedSha256) {
  return (await readVerifiedPublishedPluginFixture(fixture, expectedSha256)).verification;
}
