import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { inspectZip, ZIP_LIMITS } from './lib/published-artifact-zip.mjs';
import { inspectPackage } from './lib/published-artifact-package.mjs';
import { STATIC_LIMITS } from './lib/published-artifact-package.mjs';
import { fetchBounded, selectCandidates, validateOfficialUrl } from './audit-ztools-published-artifacts.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data || '');
    const compressed = entry.deflate ? deflateRawSync(data) : data, method = entry.deflate ? 8 : 0;
    const header = Buffer.alloc(30), record = Buffer.alloc(46), crc = crc32(data);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(((entry.mode || 0o100644) * 65536) >>> 0, 38);
    record.writeUInt32LE(offset, 42); local.push(header, name, compressed); central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const content = Buffer.concat(local), directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(content.length, 16);
  return Buffer.concat([content, directory, end]);
}

const archive = zip([
  { name: 'demo/plugin.json', data: JSON.stringify({ name: 'demo', version: '1.0.0', main: 'index.html', preload: 'preload.js' }) },
  { name: 'demo/index.html', data: '<link href="/assets/main.css"><script src="./assets/main.js"></script>', deflate: true },
  { name: 'demo/assets/main.css', data: 'body { background: url(./dot.svg); }' },
  { name: 'demo/assets/main.js', data: 'import "./chunk.js";' },
  { name: 'demo/assets/chunk.js', data: 'export default 1;' },
  { name: 'demo/assets/dot.svg', data: '<svg/>' },
  { name: 'demo/preload.js', data: 'throw new Error("MUST NEVER EXECUTE");' },
]);
const inspected = inspectZip(archive), pkg = inspectPackage(inspected.files, 'demo');
assert.equal(inspected.summary.preflightPassed, true);
assert.equal(inspected.summary.extractedToDisk, false);
assert.equal(pkg.staticEntryComplete, true);
assert.equal(pkg.checkedStaticFiles, 6);
assert.throws(() => inspectZip(zip([{ name: '../escape', data: 'x' }])), /Unsafe/);
assert.throws(() => inspectZip(zip([{ name: '/absolute', data: 'x' }])), /Unsafe/);
assert.throws(() => inspectZip(zip([{ name: 'C:/drive', data: 'x' }])), /Unsafe/);
assert.throws(() => inspectZip(zip([{ name: 'a\\b', data: 'x' }])), /Unsafe/);
assert.throws(() => inspectZip(zip([{ name: 'link', mode: 0o120777, data: '/outside' }])), /symlink/);
assert.throws(() => inspectZip(zip([{ name: 'a', data: 'x' }, { name: 'A', data: 'y' }])), /colliding/);
assert.throws(() => inspectZip(zip([{ name: 'a', data: 'x' }, { name: 'a/b', data: 'y' }])), /conflict/);
const corrupted = Buffer.from(archive); corrupted[30 + 'demo/plugin.json'.length] ^= 1;
assert.throws(() => inspectZip(corrupted), /CRC/);
const encrypted = Buffer.from(archive); encrypted.writeUInt16LE(0x801, archive.readUInt32LE(archive.length - 6) + 8);
assert.throws(() => inspectZip(encrypted), /Encrypted/);
const oversized = Buffer.from(archive); oversized.writeUInt32LE(ZIP_LIMITS.entryBytes + 1, archive.readUInt32LE(archive.length - 6) + 24);
assert.throws(() => inspectZip(oversized), /quota/);
const native = inspectZip(zip([{ name: 'lib.node', data: 'native' }, { name: 'unnamed', data: Buffer.from('7f454c46', 'hex') }]));
assert.deepEqual(native.summary.nativeFiles, ['lib.node', 'unnamed']);
const missingFiles = new Map(inspected.files); missingFiles.delete('demo/assets/chunk.js');
assert.deepEqual(inspectPackage(missingFiles, 'demo').missingStaticFiles, ['demo/assets/chunk.js']);
const multilineFiles = new Map(inspected.files);
multilineFiles.set('demo/assets/main.js', Buffer.from("import {\n x,\n y\n} from './missing.js';\nexport {\n z\n} from './other-missing.js';"));
assert.deepEqual(inspectPackage(multilineFiles, 'demo').missingStaticFiles, ['demo/assets/missing.js', 'demo/assets/other-missing.js']);
multilineFiles.set('demo/assets/main.js', Buffer.from("import '\\u{2e}/missing.js';"));
assert.deepEqual(inspectPackage(multilineFiles, 'demo').missingStaticFiles, ['demo/assets/missing.js']);
multilineFiles.set('demo/assets/main.js', Buffer.from("const example = \"import('./file')\";\n/* import('./comment-file') */\nconst pattern = /import\\(\\\"not-real\\\"\\)/;\nimport './chunk.js';"));
const withoutExamples = inspectPackage(multilineFiles, 'demo');
assert.equal(withoutExamples.staticEntryComplete, true);
assert.equal(withoutExamples.ignoredNonCodeDependencyExamples.length, 2);
multilineFiles.set('demo/assets/main.js', Buffer.from('import(computedPath);'));
assert.equal(inspectPackage(multilineFiles, 'demo').staticEntryComplete, false);
multilineFiles.set('demo/assets/main.js', Buffer.from('const template = `${import(computedPath)}`;'));
assert.equal(inspectPackage(multilineFiles, 'demo').staticEntryComplete, false);
const escapeManifest = new Map([['demo/plugin.json', Buffer.from('{"name":"demo","main":"../../outside"}')]]);
assert.throws(() => inspectPackage(escapeManifest, 'demo'), /leaves package/);
const sourceFiles = new Map([['plugin.json', Buffer.from('{"name":"demo","main":"index.html"}')],
  ['index.html', Buffer.from('<script src="/src/main.ts"></script>')], ['src/main.ts', Buffer.from('no execution')]]);
assert.equal(inspectPackage(sourceFiles, 'demo').staticEntryComplete, false);
const repeatedHtml = new Map([['plugin.json', Buffer.from('{"name":"demo","main":"index.html"}')],
  ['index.html', Buffer.from('href="./missing" '.repeat(65536))]]);
const boundedHtml = inspectPackage(repeatedHtml, 'demo');
assert.deepEqual(boundedHtml.missingStaticFiles, ['missing']);
assert.equal(boundedHtml.missingReferences.length, STATIC_LIMITS.diagnosticSamples);
assert.equal(boundedHtml.scanning.referenceEdgesObserved, STATIC_LIMITS.referenceEdgesPerPackage);
assert.ok(boundedHtml.diagnosticCounts.missingReferences.omitted > 0);
assert.equal(boundedHtml.staticEntryComplete, false);
assert.ok(JSON.stringify(boundedHtml).length < 25000);
const repeatedCss = new Map([['plugin.json', Buffer.from('{"name":"demo","main":"index.html"}')],
  ['index.html', Buffer.from('<link href="style.css">')], ['style.css', Buffer.from('url(./missing) '.repeat(65536))]]);
const boundedCss = inspectPackage(repeatedCss, 'demo');
assert.equal(boundedCss.missingReferences.length, STATIC_LIMITS.diagnosticSamples);
assert.equal(boundedCss.scanning.referenceEdgesObserved, STATIC_LIMITS.referenceEdgesPerPackage);
assert.equal(boundedCss.staticEntryComplete, false);
const uniqueHtml = new Map(repeatedHtml);
uniqueHtml.set('index.html', Buffer.from(Array.from({ length: 1100 }, (_, i) => `href="./missing-${i}" `).join('')));
const boundedUnique = inspectPackage(uniqueHtml, 'demo');
assert.equal(boundedUnique.missingStaticFiles.length, STATIC_LIMITS.uniqueMissingPaths);
assert.ok(boundedUnique.uncertainReferences.some((item) => item.kind === 'unique_missing_path_budget_exceeded'));
assert.equal(boundedUnique.staticEntryComplete, false);
const computedImports = new Map(inspected.files);
computedImports.set('demo/assets/main.js', Buffer.from('import(computedPath);'.repeat(1000)));
const boundedComputed = inspectPackage(computedImports, 'demo');
assert.equal(boundedComputed.uncertainReferences.length, STATIC_LIMITS.diagnosticSamples);
assert.ok(boundedComputed.diagnosticCounts.uncertainReferences.omitted > 0);
for (const url of ['http://ztools.zosen.link/a.zip', 'https://ztools.zosen.link.evil/a.zip', 'https://u:p@ztools.zosen.link/a.zip', 'https://ztools.zosen.link:444/a.zip', 'https://ztools.zosen.link/a.zpx']) {
  assert.throws(() => validateOfficialUrl(url, 'package'));
}
validateOfficialUrl('https://ztools.zosen.link/a.zip', 'package');
const trace = [];
await assert.rejects(fetchBounded('https://z-tools.top/api/market/plugins', 'json', trace,
  async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } })), /non-official/);
assert.equal(trace.length, 1);
await assert.rejects(fetchBounded('https://z-tools.top/api/market/plugins', 'json', [],
  async () => new Response(null, { status: 200, headers: { 'content-length': '999999999' } })), /quota/);
await assert.rejects(fetchBounded('https://z-tools.top/api/market/plugins', 'json', [],
  async () => new Response(null, { status: 404 })), /HTTP 404/);
const redirectTrace = [];
await assert.rejects(fetchBounded('https://z-tools.top/api/market/plugins', 'json', redirectTrace,
  async () => new Response(null, { status: 302, headers: { location: '/api/market/plugins' } })), /redirect limit/);
assert.equal(redirectTrace.length, 3);
const downloaded = await fetchBounded('https://ztools.zosen.link/a.zip', 'package', [], async (_url, init) => {
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Cookie, undefined);
  return new Response(archive, { status: 200 });
});
assert.deepEqual(downloaded.bytes, archive);
assert.throws(() => selectCandidates({ entries: [] }, { plugins: [] }), /same-version/);
const deepEntries = Array.from({ length: 600 }, (_, i) => ({ name: `${Array.from({ length: 31 }, () => 'deep').join('/')}/${i}`, data: '' }));
const deepStart = performance.now();
assert.equal(inspectZip(zip(deepEntries)).summary.entryCount, 600);
assert.ok(performance.now() - deepStart < 3000, 'Deep path preflight must remain bounded with indexed parent checks');
console.log('Published artifact audit tests passed: bounded ZIP/content/static references, source selection, official HTTPS hosts, redirects, quotas and HTTP failures; no network or plugin execution.');
