import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { verifyPinnedConsumerSet, verifyReachableCommonJsClosure } from './builtin-runtime-package-closure.mjs';

export const LIMITS = Object.freeze({ files: 16000, directories: 8000, depth: 64,
  pathBytes: 2048, fileBytes: 16 * 1024 * 1024, treeBytes: 256 * 1024 * 1024, chunkBytes: 64 * 1024 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const utf8Compare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const canon = value => JSON.stringify(value);
const failure = code => Object.assign(new Error(code), { code });

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > LIMITS.pathBytes
    || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) throw failure('BUILTIN_STAGE_UNSAFE_PATH');
  const parts = value.split('/');
  if (parts.length > LIMITS.depth || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw failure('BUILTIN_STAGE_UNSAFE_PATH');
  return value;
}

async function readRegular(root, relative, expected) {
  const name = safeRelative(relative), absolute = path.join(root, ...name.split('/'));
  await assertSafeParents(root, name);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > LIMITS.fileBytes) throw failure('BUILTIN_STAGE_UNSAFE_FILE');
  if (expected && (before.size !== expected.bytes || (expected.dev !== undefined && before.dev !== expected.dev)
    || (expected.ino !== undefined && before.ino !== expected.ino))) throw failure('BUILTIN_STAGE_SOURCE_CHANGED');
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) throw failure('BUILTIN_STAGE_SOURCE_CHANGED');
    const chunks = []; let total = 0; let position = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(LIMITS.chunkBytes, LIMITS.fileBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > LIMITS.fileBytes || total > LIMITS.treeBytes) throw failure('BUILTIN_STAGE_FILE_LIMIT');
      chunks.push(chunk.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await handle.stat();
    const entryAfter = await lstat(absolute);
    if (!entryAfter.isFile() || entryAfter.isSymbolicLink() || after.size !== before.size || total !== before.size
      || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs
      || entryAfter.dev !== before.dev || entryAfter.ino !== before.ino) throw failure('BUILTIN_STAGE_SOURCE_CHANGED');
    const bytes = Buffer.concat(chunks, total);
    return { bytes, sha256: sha256(bytes), mode: before.mode & 0o777 };
  } finally { await handle.close(); }
}

async function assertSafeParents(root, relative) {
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw failure('BUILTIN_STAGE_UNSAFE_PARENT');
  }
}

export async function inspectBuiltinTree(sourceRoot) {
  const root = path.resolve(sourceRoot), rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw failure('BUILTIN_STAGE_ROOT_UNSAFE');
  const entries = []; let totalBytes = 0, fileCount = 0, directoryCount = 0;
  async function walk(relative, depth) {
    if (depth > LIMITS.depth) throw failure('BUILTIN_STAGE_DEPTH_LIMIT');
    const absolute = relative ? path.join(root, ...relative.split('/')) : root;
    if (await realpath(absolute) !== absolute) throw failure('BUILTIN_STAGE_UNSAFE_PARENT');
    const names = await readdir(absolute); names.sort(utf8Compare);
    for (const name of names) {
      const child = safeRelative(relative ? `${relative}/${name}` : name), childPath = path.join(root, ...child.split('/'));
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) throw failure('BUILTIN_STAGE_SYMLINK');
      if (metadata.isDirectory()) {
        if (++directoryCount > LIMITS.directories) throw failure('BUILTIN_STAGE_DIRECTORY_LIMIT');
        entries.push({ path: child, kind: 'directory', mode: metadata.mode & 0o777 });
        await walk(child, depth + 1); continue;
      }
      if (!metadata.isFile()) throw failure('BUILTIN_STAGE_SPECIAL_FILE');
      if (++fileCount > LIMITS.files || metadata.size > LIMITS.fileBytes) throw failure('BUILTIN_STAGE_FILE_LIMIT');
      const file = await readRegular(root, child, { bytes: metadata.size, dev: metadata.dev, ino: metadata.ino });
      totalBytes += metadata.size;
      if (totalBytes > LIMITS.treeBytes) throw failure('BUILTIN_STAGE_TREE_LIMIT');
      entries.push({ path: child, kind: 'file', bytes: metadata.size, sha256: file.sha256, mode: file.mode,
        dev: metadata.dev, ino: metadata.ino, mtimeMs: metadata.mtimeMs });
    }
  }
  await walk('', 0);
  entries.sort((a, b) => utf8Compare(a.path, b.path));
  const publicEntries = entries.map(({ dev, ino, mtimeMs, ...entry }) => entry);
  const digest = sha256(Buffer.from(canon({ schemaVersion: 1, entries: publicEntries }), 'utf8'));
  return { root, entries, publicEntries, fileCount, directoryCount, bytes: totalBytes, sha256: digest };
}

const byPath = manifest => new Map(manifest.entries.map(entry => [entry.path, entry]));
function resolvePackageRoot(importer, packageName, entries) {
  let cursor = path.posix.dirname(importer);
  while (cursor !== '.') {
    const candidate = `${cursor}/node_modules/${packageName}`;
    if (entries.has(`${candidate}/package.json`)) return candidate;
    cursor = path.posix.dirname(cursor);
  }
  const rootCandidate = `node_modules/${packageName}`;
  return entries.has(`${rootCandidate}/package.json`) ? rootCandidate : null;
}
function validPackageName(value) { return typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(value); }

async function readManifestFile(sourceRoot, manifest, relative) {
  const record = byPath(manifest).get(relative);
  if (!record || record.kind !== 'file') throw failure('BUILTIN_STAGE_RULE_EVIDENCE_MISSING');
  const file = await readRegular(sourceRoot, relative, record);
  if (file.sha256 !== record.sha256) throw failure('BUILTIN_STAGE_SOURCE_CHANGED');
  return file.bytes;
}

async function verifyPackageRule(sourceRoot, manifest, rule) {
  if (!rule || rule.kind !== 'package-format-prune' || rule.enabled !== true) return { excluded: [], decision: 'preserved-unapproved-rule' };
  const entries = byPath(manifest), packageRoot = safeRelative(rule.packageRoot), packageRecord = entries.get(`${packageRoot}/package.json`);
  const packageSuffix = `node_modules/${rule.package?.name}`;
  if (!validPackageName(rule.package?.name) || (packageRoot !== packageSuffix && !packageRoot.endsWith(`/${packageSuffix}`))) throw failure('BUILTIN_STAGE_PACKAGE_SELECTOR_INVALID');
  if (!packageRecord || packageRecord.kind !== 'file' || packageRecord.sha256 !== rule.package.packageJsonSha256) throw failure('BUILTIN_STAGE_PACKAGE_PIN_MISMATCH');
  const metadata = JSON.parse((await readManifestFile(sourceRoot, manifest, `${packageRoot}/package.json`)).toString('utf8'));
  if (metadata.name !== rule.package.name || metadata.version !== rule.package.version || metadata.main !== rule.package.main
    || (metadata.type && metadata.type !== 'commonjs')
    || Object.hasOwn(metadata, 'exports') || Object.hasOwn(metadata, 'browser') || Object.hasOwn(metadata, 'imports')) throw failure('BUILTIN_STAGE_PACKAGE_LAYOUT_UNKNOWN');
  const actualDependencies = Object.keys(metadata.dependencies || {}).sort(utf8Compare);
  const expectedDependencies = [...rule.dependencyClosure].sort(utf8Compare);
  if (actualDependencies.some(name => !validPackageName(name)) || JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) throw failure('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
  const mainPath = safeRelative(`${packageRoot}/${metadata.main.replace(/^\.\//, '')}`);
  if (!entries.has(mainPath) || rule.dropDirectories.some(directory => mainPath.startsWith(`${packageRoot}/${directory}/`))) throw failure('BUILTIN_STAGE_PACKAGE_MAIN_NOT_RETAINED');
  for (const pathValue of rule.retainPaths) if (!entries.has(`${packageRoot}/${safeRelative(pathValue)}`)) throw failure('BUILTIN_STAGE_PACKAGE_PRESERVATION_PIN_MISSING');
  const consumer = rule.consumer;
  const consumerRecord = entries.get(consumer.path);
  if (!consumerRecord || consumerRecord.kind !== 'file' || consumerRecord.sha256 !== consumer.sha256) throw failure('BUILTIN_STAGE_CONSUMER_PIN_MISMATCH');
  const importerRoot = safeRelative(consumer.scopeRoot);
  if (!consumer.path.startsWith(`${importerRoot}/`) || resolvePackageRoot(consumer.path, metadata.name, entries) !== packageRoot) throw failure('BUILTIN_STAGE_CONSUMER_RESOLUTION_MISMATCH');
  if (consumer.exactCalls < 1) throw failure('BUILTIN_STAGE_CONSUMER_IMPORT_MISMATCH');
  const readPinnedFile = relative => readManifestFile(sourceRoot, manifest, relative);
  const excludedRoots = rule.dropDirectories.map(value => `${packageRoot}/${safeRelative(value)}`);
  await verifyPinnedConsumerSet({ manifest, packageRoot, mainPath, consumer, otherReferences: rule.otherReferences || [],
    otherRelativeReferences: rule.otherRelativeReferences || [], packageName: metadata.name, readFile: readPinnedFile, excludedRoots, ruleId: rule.id });
  const closure = await verifyReachableCommonJsClosure({ packageRoot, mainPath, manifest, readFile: readPinnedFile, excludedRoots, ruleId: rule.id });
  const excluded = [];
  if (new Set(rule.dropDirectories).size !== rule.dropDirectories.length || rule.dropDirectories.some(value => value.includes('/'))) throw failure('BUILTIN_STAGE_PACKAGE_DROP_UNKNOWN');
  for (const directory of rule.dropDirectories) {
    const prefix = `${packageRoot}/${safeRelative(directory)}`;
    if (!entries.has(prefix) || entries.get(prefix).kind !== 'directory' || mainPath.startsWith(`${prefix}/`)
      || rule.retainPaths.some(retained => retained === directory || retained.startsWith(`${directory}/`))) throw failure('BUILTIN_STAGE_PACKAGE_DROP_UNKNOWN');
    excluded.push(prefix);
  }
  return { excluded, decision: 'candidate-package-format-prune', packageName: metadata.name, packageVersion: metadata.version,
    verifiedReachableModules: closure.visitedModuleCount, closureScannedBytes: closure.scannedBytes,
    verifiedForeignRelativeReferences: (rule.otherRelativeReferences || []).filter(item => item.domain === 'foreign').length };
}

async function verifyTargetFileRule(sourceRoot, manifest, rule, target) {
  if (!rule || rule.kind !== 'target-file-set' || rule.enabled !== true) return { excluded: [], decision: 'preserved-unapproved-rule' };
  if (!target || target.platform !== rule.platform || target.arch === 'universal' || !['arm64', 'x64'].includes(target.arch)) return { excluded: [], decision: 'preserved-target-unknown' };
  const entries = byPath(manifest), loader = entries.get(rule.loader.path), caller = entries.get(rule.caller.path);
  if (!loader || !caller || loader.sha256 !== rule.loader.sha256 || caller.sha256 !== rule.caller.sha256) throw failure('BUILTIN_STAGE_TARGET_LOADER_PIN_MISMATCH');
  const loaderSource = (await readManifestFile(sourceRoot, manifest, rule.loader.path)).toString('utf8');
  const callerSource = (await readManifestFile(sourceRoot, manifest, rule.caller.path)).toString('utf8');
  if (!loaderSource.includes('process.arch') || !loaderSource.includes('process.platform') || !loaderSource.includes("path.join(__dirname, 'bin', filename)")
    || /createSidecarClient\(\{[^}]*\b(?:arch|platform)\s*:/s.test(callerSource)) throw failure('BUILTIN_STAGE_TARGET_SELECTION_UNPROVEN');
  const removeArch = target.arch === 'arm64' ? 'x64' : 'arm64';
  const asset = rule.assets.find(item => item.arch === removeArch && item.platform === target.platform);
  const selectedAsset = rule.assets.find(item => item.arch === target.arch && item.platform === target.platform);
  if (!asset || !selectedAsset) throw failure('BUILTIN_STAGE_TARGET_ASSET_PIN_MISSING');
  const entry = entries.get(asset.path);
  const selected = entries.get(selectedAsset.path);
  if (!entry || entry.kind !== 'file' || entry.sha256 !== asset.sha256 || entry.bytes !== asset.bytes
    || !selected || selected.kind !== 'file' || selected.sha256 !== selectedAsset.sha256 || selected.bytes !== selectedAsset.bytes) throw failure('BUILTIN_STAGE_TARGET_ASSET_PIN_MISMATCH');
  return { excluded: [asset.path], decision: 'candidate-target-asset-prune', removedArchitecture: removeArch };
}

export async function planBuiltinRuntimeStage(sourceRoot, { candidateRules = [], target = null, applyCandidateRules = false, expectedSourceTreeSha256 = null } = {}) {
  const source = await inspectBuiltinTree(sourceRoot);
  if (expectedSourceTreeSha256 && source.sha256 !== expectedSourceTreeSha256) throw failure('BUILTIN_STAGE_SOURCE_TREE_PIN_MISMATCH');
  const decisions = [], excluded = new Set();
  if (applyCandidateRules) for (const rule of candidateRules) {
    let result;
    try {
      result = rule.kind === 'package-format-prune'
        ? await verifyPackageRule(source.root, source, rule)
        : await verifyTargetFileRule(source.root, source, rule, target);
    } catch (error) {
      if (error && typeof error === 'object') error.ruleId ||= rule.id;
      throw error;
    }
    decisions.push({ id: rule.id, ...result });
    for (const value of result.excluded) excluded.add(value);
  } else {
    for (const rule of candidateRules) decisions.push({ id: rule.id, decision: 'preserved-dry-run' });
  }
  const stagedEntries = source.publicEntries.filter(entry => ![...excluded].some(pathValue => entry.path === pathValue || entry.path.startsWith(`${pathValue}/`)));
  const stagedBytes = stagedEntries.filter(entry => entry.kind === 'file').reduce((sum, entry) => sum + entry.bytes, 0);
  return { source, stagedEntries, stagedBytes, excluded: [...excluded].sort(utf8Compare), decisions,
    bytesSaved: source.bytes - stagedBytes,
    stagedTreeSha256: sha256(Buffer.from(canon({ schemaVersion: 1, entries: stagedEntries }), 'utf8')) };
}

export async function stageBuiltinRuntimeTree(sourceRoot, destinationRoot, options = {}) {
  const plan = await planBuiltinRuntimeStage(sourceRoot, options);
  const destination = path.resolve(destinationRoot);
  const [sourceReal, destinationParent] = await Promise.all([realpath(plan.source.root), realpath(path.dirname(destination))]);
  if (destination === sourceReal || destination.startsWith(`${sourceReal}${path.sep}`) || sourceReal.startsWith(`${destination}${path.sep}`)) throw failure('BUILTIN_STAGE_SOURCE_DESTINATION_OVERLAP');
  if (path.dirname(destination) !== destinationParent || destinationParent.includes(path.sep + '..' + path.sep)) throw failure('BUILTIN_STAGE_DESTINATION_PARENT_UNSAFE');
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const excluded = new Set(plan.excluded);
  try {
    for (const entry of plan.stagedEntries) {
      if (entry.kind === 'directory') {
        const target = path.join(destination, ...entry.path.split('/'));
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      if ([...excluded].some(pathValue => entry.path.startsWith(`${pathValue}/`))) continue;
      const bytes = await readRegular(plan.source.root, entry.path, plan.source.entries.find(item => item.path === entry.path));
      if (bytes.sha256 !== entry.sha256 || bytes.bytes.length !== entry.bytes) throw failure('BUILTIN_STAGE_SOURCE_CHANGED');
      const target = path.join(destination, ...entry.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), entry.mode || 0o600);
      try { await handle.writeFile(bytes.bytes); await handle.chmod(entry.mode || 0o600); }
      finally { await handle.close(); }
    }
    for (const entry of plan.stagedEntries.filter(item => item.kind === 'directory').sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
      const target = path.join(destination, ...entry.path.split('/'));
      const directoryInfo = await lstat(target);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw failure('BUILTIN_STAGE_OUTPUT_UNSAFE');
      await chmod(target, entry.mode || 0o755);
    }
    const after = await inspectBuiltinTree(plan.source.root);
    if (after.sha256 !== plan.source.sha256) throw failure('BUILTIN_STAGE_SOURCE_CHANGED');
    const staged = await inspectBuiltinTree(destination);
    if (staged.sha256 !== plan.stagedTreeSha256) throw failure('BUILTIN_STAGE_OUTPUT_MISMATCH');
    return { sourceManifestSha256: plan.source.sha256, stagedManifestSha256: staged.sha256, sourceFiles: plan.source.fileCount,
      stagedFiles: staged.fileCount, sourceBytes: plan.source.bytes, stagedBytes: staged.bytes, bytesSaved: plan.bytesSaved,
      sourceUnchanged: true, excluded: plan.excluded, decisions: plan.decisions, entries: plan.stagedEntries };
  } catch (error) { error.partialDestination = destination; throw error; }
}

export function canonicalJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
export function sha256Bytes(value) { return sha256(value); }
