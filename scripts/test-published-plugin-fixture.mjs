import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializeInspectedFiles, preparePublishedPluginFixture, readVerifiedPublishedPluginFixture, sha256, verifyPublishedPluginFixture } from './lib/published-plugin-fixture.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [filename, data] of files) {
    const name = Buffer.from(filename), bytes = Buffer.from(data), header = Buffer.alloc(30), record = Buffer.alloc(46);
    const crc = crc32(bytes);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(record, name); offset += 30 + name.length + bytes.length;
  }
  const body = Buffer.concat(local), directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

const parent = await mkdtemp(path.join(tmpdir(), 'atools-published-fixture-test-'));
try {
  await assert.rejects(materializeInspectedFiles(new Map([['../outside', Buffer.from('x')]]), parent), /Rejected/);
  assert.deepEqual(await readdir(parent), []);
  await assert.rejects(materializeInspectedFiles(new Map([['a', Buffer.from('x')], ['a/b', Buffer.from('y')]]), parent));
  assert.deepEqual(await readdir(parent), [], 'Failed materialization must remove its newly owned directory');
  const files = new Map([['plugin.json', '{"name":"demo","version":"1.0.0","main":"index.html","preload":"preload.js"}'],
    ['index.html', '<div id="app">static only</div>'], ['preload.js', 'throw new Error("MUST NEVER BE EXECUTED");']]);
  const archive = zip(files), observed = { id: 'demo', status: 'static_package_reviewable', package: { version: '1.0.0' },
    archive: { locallyComputedSha256: sha256(archive) } };
  let requests = 0;
  const request = async (url, options) => {
    requests++; assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    if (url.hostname === 'z-tools.top') return new Response(JSON.stringify({ downloadUrl: 'https://ztools.zosen.link/demo-1.0.0.zip' }));
    assert.equal(url.hostname, 'ztools.zosen.link'); return new Response(archive);
  };
  await assert.rejects(preparePublishedPluginFixture({ ...observed, archive: { locallyComputedSha256: '0'.repeat(64) } },
    { request, temporaryParent: parent }), /pinned audited SHA/);
  assert.deepEqual(await readdir(parent), [], 'SHA mismatch must not materialize downloaded bytes');
  const fixture = await preparePublishedPluginFixture(observed, { request, temporaryParent: parent });
  assert.equal(requests, 4); assert.equal(fixture.rootMode, '700'); assert.equal(fixture.noPluginCodeExecuted, true);
  assert.equal((await lstat(fixture.ownedRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(fixture.pluginRoot, 'preload.js'))).mode & 0o777, 0o600);
  assert.equal((await readFile(path.join(fixture.pluginRoot, 'preload.js'), 'utf8')), files.get('preload.js'));
  const verified = await verifyPublishedPluginFixture(fixture, sha256(archive));
  assert.equal(verified.unchangedFileCount, 3); assert.equal(verified.noPluginCodeExecuted, true);
  assert.equal(Object.hasOwn(verified, 'files'), false, 'Legacy verify API must remain plain metadata');
  const snapshot = await readVerifiedPublishedPluginFixture(fixture, sha256(archive));
  assert.ok(snapshot.files instanceof Map);
  assert.equal(snapshot.verification.sourceBytesUnchanged, true);
  const originalPreloadBytes = Buffer.from(snapshot.files.get('preload.js'));
  await writeFile(path.join(fixture.pluginRoot, 'preload.js'), 'changed data');
  assert.deepEqual(snapshot.files.get('preload.js'), originalPreloadBytes, 'Review buffers must remain pinned when source path changes after verification');
  assert.equal(snapshot.files.get('preload.js').toString(), files.get('preload.js'));
  await assert.rejects(verifyPublishedPluginFixture(fixture, sha256(archive)), /source bytes changed/);
  await rm(fixture.ownedRoot, { recursive: true, force: true });
  assert.deepEqual(await readdir(parent), []);
  console.log('Published plugin fixture tests passed: preflight/pin before writes, path confinement, 0700/0600 ownership, unchanged hashes, failure cleanup and tamper detection; no network or plugin execution.');
} finally { await rm(parent, { recursive: true, force: true }); }
