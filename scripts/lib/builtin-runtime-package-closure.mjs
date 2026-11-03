import path from 'node:path';
import { scanCommonJsRequests } from './builtin-runtime-js-lexer.mjs';

const diagnosticPath = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 512
  && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value)
  && !value.split('/').includes('..') ? value : null;
const diagnosticRule = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value) ? value : null;
const fail = (code, context = {}) => Object.assign(new Error(code), { code,
  ruleId: diagnosticRule(context.ruleId), relativePath: diagnosticPath(context.relativePath) });
const textFile = entry => /\.(?:[cm]?js|jsx|ts|tsx|vue|svelte|html?)$/iu.test(entry.path);
const inside = (root, value) => value === root || value.startsWith(`${root}/`);
const packageRequest = request => {
  const parts = request.split('/');
  return request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};
const builtinNames = new Set(['assert','async_hooks','buffer','child_process','cluster','console','constants','crypto','dgram',
  'diagnostics_channel','dns','domain','events','fs','http','http2','https','module','net','os','path','perf_hooks','process',
  'punycode','querystring','readline','repl','stream','string_decoder','sys','timers','tls','trace_events','tty','url','util',
  'v8','vm','wasi','worker_threads','zlib']);
const assetOrLoaderBuiltins = new Set(['fs','child_process','module','worker_threads','process','vm','v8','wasi']);

function specifierMentions(source, name, context) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = [];
  const patterns = [
    { mode: 'require', regex: new RegExp(`\\brequire\\s*\\(\\s*(['"])([^'"\\\\]+)\\1\\s*\\)`, 'g') },
    { mode: 'runtimeRequire', regex: new RegExp(`\\bruntimeRequire\\s*\\(\\s*(['"])([^'"\\\\]+)\\1\\s*\\)`, 'g') },
    { mode: 'import', regex: new RegExp(`\\bimport\\s*\\(\\s*(['"])([^'"\\\\]+)\\1\\s*\\)|\\bimport\\s*(['"])([^'"\\\\]+)\\3`, 'g') },
    { mode: 'from', regex: new RegExp(`\\b(?:import\\s+[^;]*?\\s+from|export\\s+[^;]*?\\s+from)\\s*(['"])([^'"\\\\]+)\\1`, 'g') }
  ];
  const ranges = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern.regex)) {
      const request = match[2] || match[4];
      const packageReference = request === name || request.startsWith(`${name}/`);
      const relativeReference = request.startsWith('.');
      if (packageReference || relativeReference) {
        result.push({ mode: relativeReference ? `relative-${pattern.mode}` : pattern.mode, request });
        ranges.push([match.index, match.index + match[0].length]);
      }
    }
  }
  const mention = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?:/[^\\s'"<>]+)?(?=$|[^A-Za-z0-9_-])`, 'g');
  for (const match of source.matchAll(mention)) {
    const start = match.index + match[1].length;
    if (!ranges.some(([left, right]) => start >= left && start < right)) throw fail('BUILTIN_STAGE_CONSUMER_REFERENCE_UNKNOWN', context);
  }
  return result;
}

export async function verifyPinnedConsumerSet({ manifest, packageRoot, mainPath, consumer, otherReferences = [], otherRelativeReferences = [],
  packageName, readFile, excludedRoots = [], ruleId }) {
  const expected = new Map();
  const add = item => expected.set(item.path, [...(expected.get(item.path) || []), item]);
  add({ ...consumer, calls: consumer.exactCalls, mode: 'require', request: packageName, resolution: packageRoot });
  for (const item of otherReferences) add({ request: packageName, ...item });
  for (const item of otherRelativeReferences) add(item);
  const seen = new Set(); let scannedBytes = 0, relativeChecks = 0;
  const entries = new Map(manifest.entries.map(value => [value.path, value]));
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file' || !textFile(entry) || inside(packageRoot, entry.path)) continue;
    const context = { ruleId, relativePath: entry.path };
    let bytes;
    try { bytes = await readFile(entry.path); }
    catch { throw fail('BUILTIN_STAGE_CONSUMER_READ_FAILED', context); }
    scannedBytes += bytes.length;
    if (scannedBytes > 32 * 1024 * 1024) throw fail('BUILTIN_STAGE_CONSUMER_SCAN_LIMIT', context);
    const mentions = specifierMentions(bytes.toString('utf8'), packageName, context);
    if (!mentions.length) continue;
    const records = expected.get(entry.path) || [];
    const relevant = [];
    for (const mention of mentions) {
      let relativeDomain = null;
      if (mention.mode.startsWith('relative-')) {
        relativeChecks += 1;
        if (relativeChecks > 8192) throw fail('BUILTIN_STAGE_CONSUMER_RELATIVE_LIMIT', context);
        relativeDomain = await resolveRelativeDomain({ importer: entry.path, request: mention.request, entries, readFile,
          packageRoot, mainPath, excludedRoots, context });
        const lexicalPackageName = mention.request.split('/').includes(packageName);
        if (relativeDomain.domain !== 'candidate' && !lexicalPackageName && relativeDomain.packageName !== packageName) continue;
      }
      relevant.push({ mention, relativeDomain });
    }
    if (!relevant.length) continue;
    if (!records.length) {
      const relative = relevant.find(item => item.relativeDomain);
      if (relative) {
        const code = relative.relativeDomain.domain === 'candidate'
          ? 'BUILTIN_STAGE_RELATIVE_CANDIDATE_UNPINNED' : 'BUILTIN_STAGE_RELATIVE_FOREIGN_UNPINNED';
        throw fail(code, context);
      }
      throw fail('BUILTIN_STAGE_CONSUMER_SET_CHANGED', context);
    }
    if (records.some(record => record.sha256 !== entry.sha256)) throw fail('BUILTIN_STAGE_CONSUMER_SET_CHANGED', context);
    const actualCounts = new Map();
    for (const { mention, relativeDomain } of relevant) {
      const record = records.find(candidate => candidate.mode === mention.mode && candidate.request === mention.request);
      if (!record) {
        if (records.some(candidate => candidate.request === mention.request)) throw fail('BUILTIN_STAGE_CONSUMER_MODE_MISMATCH', context);
        if (!mention.mode.startsWith('relative-') && mention.request !== packageName) throw fail('BUILTIN_STAGE_CONSUMER_SUBPATH_UNKNOWN', context);
        if (mention.mode.startsWith('relative-')) {
          if (relativeDomain.domain === 'candidate') throw fail('BUILTIN_STAGE_RELATIVE_CANDIDATE_UNPINNED', context);
          throw fail('BUILTIN_STAGE_RELATIVE_FOREIGN_UNPINNED', context);
        }
        throw fail('BUILTIN_STAGE_CONSUMER_SET_CHANGED', context);
      }
      const key = `${record.mode}\u0000${record.request}`;
      actualCounts.set(key, (actualCounts.get(key) || 0) + 1);
      if (mention.mode.startsWith('relative-')) {
        if (relativeDomain.domain !== record.domain || relativeDomain.targetPath !== record.targetPath || relativeDomain.status !== record.status
          || relativeDomain.resolvedModule !== (record.resolvedModule ?? null)
          || (record.domain === 'foreign' && relativeDomain.packageName !== (record.packageName ?? null))) {
          throw fail('BUILTIN_STAGE_RELATIVE_RESOLUTION_MISMATCH', context);
        }
      } else {
        if (mention.request !== packageName) throw fail('BUILTIN_STAGE_CONSUMER_SUBPATH_UNKNOWN', context);
        const resolved = record.mode === 'require' ? resolvePackageRoot(entry.path, packageName, entries) : null;
        if (resolved !== record.resolution) throw fail('BUILTIN_STAGE_CONSUMER_RESOLUTION_MISMATCH', context);
        if (record.mode === 'runtimeRequire' && record.resolution !== null) throw fail('BUILTIN_STAGE_CONSUMER_RESOLUTION_MISMATCH', context);
      }
    }
    for (const record of records) {
      const key = `${record.mode}\u0000${record.request}`;
      if (actualCounts.get(key) !== record.calls) throw fail('BUILTIN_STAGE_CONSUMER_MODE_MISMATCH', context);
      seen.add(`${entry.path}\u0000${key}`);
    }
  }
  for (const [sourcePath, records] of expected) for (const record of records) {
    if (!seen.has(`${sourcePath}\u0000${record.mode}\u0000${record.request}`)) {
      throw fail('BUILTIN_STAGE_CONSUMER_SET_CHANGED', { ruleId, relativePath: sourcePath });
    }
  }
}

function resolveFile(base, entries) {
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}.node`, `${base}/index.js`, `${base}/index.cjs`, `${base}/index.json`];
  const found = candidates.find(value => entries.get(value)?.kind === 'file');
  return found || null;
}

function resolvePackageRoot(importer, packageName, entries) {
  let cursor = path.posix.dirname(importer);
  while (cursor !== '.') {
    const candidate = `${cursor}/node_modules/${packageName}`;
    if (entries.get(`${candidate}/package.json`)?.kind === 'file') return candidate;
    cursor = path.posix.dirname(cursor);
  }
  const root = `node_modules/${packageName}`;
  return entries.get(`${root}/package.json`)?.kind === 'file' ? root : null;
}

function selectCommonJsRootExport(value, depth = 0) {
  if (typeof value === 'string') return value;
  if (depth >= 8 || !value || typeof value !== 'object' || Array.isArray(value)) throw fail('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'import' || condition === 'module') continue;
    if (condition !== 'node' && condition !== 'require' && condition !== 'default') {
      throw fail('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
    }
    return selectCommonJsRootExport(target, depth + 1);
  }
  throw fail('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
}

function commonJsRootExport(exportsValue) {
  if (typeof exportsValue === 'string') return exportsValue;
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) throw fail('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
  let rootValue = exportsValue;
  if (Object.hasOwn(exportsValue, '.')) {
    for (const key of Object.keys(exportsValue)) {
      if (key === '.') continue;
      if (key === './' && exportsValue[key] === './') continue;
      throw fail('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
    }
    rootValue = exportsValue['.'];
  } else if (Object.keys(exportsValue).some(key => key.startsWith('.'))) {
    throw fail('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
  }
  return selectCommonJsRootExport(rootValue);
}

function exactExportTarget(root, target, entries, excludedRoots) {
  if (typeof target !== 'string' || !target.startsWith('./') || target.length < 3 || target.includes('\\')
    || /[%?#\u0000-\u001f\u007f*]/u.test(target)) throw fail('BUILTIN_STAGE_DEPENDENCY_ENTRY_UNKNOWN');
  const relative = target.slice(2);
  if (relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('BUILTIN_STAGE_DEPENDENCY_ENTRY_UNKNOWN');
  const resolved = path.posix.normalize(path.posix.join(root, relative));
  if (!inside(root, resolved) || resolved === root) throw fail('BUILTIN_STAGE_DEPENDENCY_ENTRY_UNKNOWN');
  if (excludedRoots.some(excluded => inside(excluded, resolved))) throw fail('BUILTIN_STAGE_CLOSURE_ESCAPES_PRUNED_ASSET');
  if (entries.get(resolved)?.kind !== 'file') throw fail('BUILTIN_STAGE_DEPENDENCY_ENTRY_MISSING');
  return resolved;
}

function packageEntry(root, metadata, entries, { useExports = true, excludedRoots = [] } = {}) {
  if ((metadata.type && metadata.type !== 'commonjs')) throw fail('BUILTIN_STAGE_DEPENDENCY_LAYOUT_UNKNOWN');
  if (useExports && Object.hasOwn(metadata, 'exports')) {
    return exactExportTarget(root, commonJsRootExport(metadata.exports), entries, excludedRoots);
  }
  const requested = typeof metadata.main === 'string' && metadata.main ? metadata.main : 'index.js';
  if (requested.startsWith('/') || requested.split('/').includes('..') || requested.includes('\\')) throw fail('BUILTIN_STAGE_DEPENDENCY_ENTRY_UNKNOWN');
  const resolved = resolveFile(path.posix.join(root, requested.replace(/^\.\//u, '')), entries);
  if (!resolved) throw fail('BUILTIN_STAGE_DEPENDENCY_ENTRY_MISSING');
  return resolved;
}

async function resolveRelativeDomain({ importer, request, entries, readFile, packageRoot, mainPath, excludedRoots, context }) {
  if (typeof request !== 'string' || !request.startsWith('.') || request.includes('\\') || Buffer.byteLength(request, 'utf8') > 2048
    || /[\u0000-\u001f\u007f]/u.test(request)) throw fail('BUILTIN_STAGE_RELATIVE_PATH_UNKNOWN', context);
  const targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(importer), request));
  if (targetPath === '..' || targetPath.startsWith('../') || targetPath.startsWith('/')) throw fail('BUILTIN_STAGE_RELATIVE_PATH_ESCAPE', context);
  if (excludedRoots.some(root => inside(root, targetPath))) throw fail('BUILTIN_STAGE_RELATIVE_TARGET_PRUNED', context);
  if (inside(packageRoot, targetPath)) {
    let resolvedModule = targetPath === packageRoot ? mainPath : resolveFile(targetPath, entries);
    if (resolvedModule && excludedRoots.some(root => inside(root, resolvedModule))) throw fail('BUILTIN_STAGE_RELATIVE_TARGET_PRUNED', context);
    if (!resolvedModule) throw fail('BUILTIN_STAGE_RELATIVE_CANDIDATE_UNRESOLVED', context);
    if (resolvedModule.endsWith('.node')) throw fail('BUILTIN_STAGE_CLOSURE_NATIVE_ADDON', context);
    return { domain: 'candidate', targetPath, status: 'present', resolvedModule };
  }
  let resolvedModule = null;
  const packageManifest = entries.get(`${targetPath}/package.json`);
  if (packageManifest?.kind === 'file') {
    let metadata;
    try { metadata = JSON.parse((await readFile(`${targetPath}/package.json`)).toString('utf8')); }
    catch { throw fail('BUILTIN_STAGE_RELATIVE_FOREIGN_LAYOUT_UNKNOWN', context); }
    try { resolvedModule = packageEntry(targetPath, metadata, entries, { useExports: false, excludedRoots }); }
    catch { throw fail('BUILTIN_STAGE_RELATIVE_FOREIGN_LAYOUT_UNKNOWN', context); }
  } else resolvedModule = resolveFile(targetPath, entries);
  if (resolvedModule && excludedRoots.some(root => inside(root, resolvedModule))) throw fail('BUILTIN_STAGE_RELATIVE_TARGET_PRUNED', context);
  let packageName = null;
  let cursor = resolvedModule ? path.posix.dirname(resolvedModule) : targetPath;
  while (cursor !== '.') {
    if (entries.get(`${cursor}/package.json`)?.kind === 'file') {
      try {
        const metadata = JSON.parse((await readFile(`${cursor}/package.json`)).toString('utf8'));
        if (typeof metadata.name === 'string') packageName = metadata.name;
      } catch { packageName = null; }
      break;
    }
    cursor = path.posix.dirname(cursor);
  }
  return { domain: 'foreign', targetPath, status: resolvedModule ? 'present' : 'missing', resolvedModule, packageName };
}

function sourceRequests(source) {
  return scanCommonJsRequests(source);
}

export async function verifyReachableCommonJsClosure({ packageRoot, mainPath, manifest, readFile, excludedRoots = [], ruleId }) {
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const visited = new Set(), queue = [mainPath]; let scannedBytes = 0;
  while (queue.length) {
    const modulePath = queue.pop();
    if (visited.has(modulePath)) continue;
    const context = { ruleId, relativePath: modulePath };
    const record = entries.get(modulePath);
    if (!record || record.kind !== 'file' || excludedRoots.some(root => inside(root, modulePath))) throw fail('BUILTIN_STAGE_CLOSURE_FILE_MISSING', context);
    visited.add(modulePath);
    if (visited.size > 8192) throw fail('BUILTIN_STAGE_CLOSURE_MODULE_LIMIT', context);
    if (!/\.(?:c?js)$/iu.test(modulePath)) continue;
    let bytes;
    try { bytes = await readFile(modulePath); }
    catch { throw fail('BUILTIN_STAGE_CLOSURE_READ_FAILED', context); }
    scannedBytes += bytes.length;
    if (scannedBytes > 32 * 1024 * 1024) throw fail('BUILTIN_STAGE_CLOSURE_SCAN_LIMIT', context);
    const source = bytes.toString('utf8');
    let requests;
    try { requests = sourceRequests(source); }
    catch (error) { throw fail(error?.code || 'BUILTIN_STAGE_CLOSURE_SOURCE_UNKNOWN', context); }
    for (const request of requests) {
      if (request.startsWith('node:')) {
        const name = request.slice(5).split('/')[0];
        if (assetOrLoaderBuiltins.has(name)) throw fail('BUILTIN_STAGE_CLOSURE_ASSET_ACCESS', context);
        if (!builtinNames.has(name)) throw fail('BUILTIN_STAGE_CLOSURE_BUILTIN_UNKNOWN', context);
        continue;
      }
      if (request.startsWith('.')) {
        const resolved = resolveFile(path.posix.normalize(path.posix.join(path.posix.dirname(modulePath), request)), entries);
        if (!resolved) throw fail('BUILTIN_STAGE_CLOSURE_RELATIVE_MISSING', context);
        if (excludedRoots.some(root => inside(root, resolved))) throw fail('BUILTIN_STAGE_CLOSURE_ESCAPES_PRUNED_ASSET', context);
        if (resolved.endsWith('.node')) throw fail('BUILTIN_STAGE_CLOSURE_NATIVE_ADDON', context);
        queue.push(resolved);
        continue;
      }
      const name = packageRequest(request);
      if (assetOrLoaderBuiltins.has(name)) throw fail('BUILTIN_STAGE_CLOSURE_ASSET_ACCESS', context);
      if (builtinNames.has(name)) continue;
      if (name.includes(':')) throw fail('BUILTIN_STAGE_CLOSURE_EXTERNAL_UNKNOWN', context);
      const dependencyRoot = resolvePackageRoot(modulePath, name, entries);
      if (!dependencyRoot) throw fail('BUILTIN_STAGE_CLOSURE_DEPENDENCY_MISSING', context);
      let dependencyManifest;
      try { dependencyManifest = JSON.parse((await readFile(`${dependencyRoot}/package.json`)).toString('utf8')); }
      catch { throw fail('BUILTIN_STAGE_CLOSURE_DEPENDENCY_MANIFEST_UNKNOWN', context); }
      if (dependencyManifest.name !== name) throw fail('BUILTIN_STAGE_CLOSURE_DEPENDENCY_IDENTITY', context);
      let resolved;
      const subpath = request.slice(name.length).replace(/^\//u, '');
      if (subpath) {
        if (Object.hasOwn(dependencyManifest, 'exports')) throw fail('BUILTIN_STAGE_CLOSURE_EXPORTS_UNKNOWN', context);
        resolved = resolveFile(path.posix.join(dependencyRoot, subpath), entries);
      } else {
        try { resolved = packageEntry(dependencyRoot, dependencyManifest, entries, { excludedRoots }); }
        catch (error) { throw fail(error?.code || 'BUILTIN_STAGE_CLOSURE_DEPENDENCY_ENTRY_UNKNOWN', context); }
      }
      if (!resolved) throw fail('BUILTIN_STAGE_CLOSURE_EXTERNAL_MISSING', context);
      if (resolved.endsWith('.node')) throw fail('BUILTIN_STAGE_CLOSURE_NATIVE_ADDON', context);
      queue.push(resolved);
    }
  }
  return { visitedModuleCount: visited.size, scannedBytes };
}
