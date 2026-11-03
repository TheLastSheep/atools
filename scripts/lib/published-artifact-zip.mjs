//! Bounded ZIP metadata/content inspection. Never extracts files or executes archive content.
import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({ archiveBytes: 50 * 1024 * 1024, entries: 4096,
  totalBytes: 64 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, depth: 32, ratio: 1000 });
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = (message) => { throw new Error(message); };
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(bytes) {
  const name = utf8.decode(bytes);
  const parts = name.replace(/\/$/, '').split('/');
  if (!name || /[\\\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name)
    || parts.some((part) => !part || part === '..' || part === '.') || parts.length > ZIP_LIMITS.depth) {
    fail(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  return name;
}
function nativeContent(name, data) {
  if (/\.(?:node|exe|dll|dylib|a|o|wasm|so(?:\.\d+)*)$/i.test(name)) return true;
  if (data.length < 4) return false;
  const magic = data.subarray(0, 4).toString('hex');
  return ['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)
    || (data[0] === 0x4d && data[1] === 0x5a);
}
function rejectZip64Extra(bytes) {
  for (let index = 0; index < bytes.length;) {
    if (index + 4 > bytes.length) fail('Malformed ZIP extra field');
    const id = bytes.readUInt16LE(index), size = bytes.readUInt16LE(index + 2);
    if (id === 1) fail('ZIP64 archives are unsupported');
    index += 4 + size;
    if (index > bytes.length) fail('Truncated ZIP extra field');
  }
}

export function inspectZip(archive) {
  if (archive.length > ZIP_LIMITS.archiveBytes) fail('ZIP compressed byte quota exceeded');
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) { end = i; break; }
  }
  if (end < 0) fail('ZIP end-of-central-directory record missing');
  const count = archive.readUInt16LE(end + 10), centralSize = archive.readUInt32LE(end + 12);
  const centralStart = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 8) !== count) fail('Multi-disk ZIP unsupported');
  if (!count || count > ZIP_LIMITS.entries || count === 65535 || centralStart === 0xffffffff || centralSize === 0xffffffff) fail('ZIP count/ZIP64 quota rejected');
  if (centralStart + centralSize !== end) fail('ZIP central directory bounds mismatch');
  const entries = [], names = new Set();
  let cursor = centralStart, totalBytes = 0, compressedBytes = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) fail('Malformed ZIP central entry');
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32), localOffset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || archive.readUInt16LE(cursor + 34)) fail('ZIP central entry bounds/disk mismatch');
    if (flags & 0x41 || ![0, 8].includes(method)) fail('Encrypted/unsupported ZIP method');
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength), name = safeName(nameBytes);
    const key = name.replace(/\/$/, '').toLowerCase();
    if (names.has(key)) fail(`Duplicate/case-colliding ZIP path: ${name}`);
    names.add(key);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16, kind = mode & 0o170000;
    if (kind && kind !== 0o100000 && kind !== 0o040000) fail(`ZIP symlink/special entry rejected: ${name}`);
    const directory = name.endsWith('/');
    if (directory && size !== 0) fail(`ZIP directory has content: ${name}`);
    if (size > ZIP_LIMITS.entryBytes || (size > 0 && size / Math.max(compressed, 1) > ZIP_LIMITS.ratio)) fail(`ZIP entry size/ratio quota: ${name}`);
    totalBytes += size; compressedBytes += compressed;
    if (totalBytes > ZIP_LIMITS.totalBytes || compressedBytes > ZIP_LIMITS.archiveBytes) fail('ZIP aggregate quota exceeded');
    rejectZip64Extra(archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    if (localOffset + 30 > centralStart || archive.readUInt32LE(localOffset) !== 0x04034b50) fail('ZIP local header missing/outside content');
    const localNameLength = archive.readUInt16LE(localOffset + 26), localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength, stop = start + compressed;
    if (stop > centralStart || start > centralStart || archive.readUInt16LE(localOffset + 6) !== flags
      || archive.readUInt16LE(localOffset + 8) !== method
      || !archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) fail('ZIP local/central header mismatch');
    if (!(flags & 8) && (archive.readUInt32LE(localOffset + 18) !== compressed || archive.readUInt32LE(localOffset + 22) !== size
      || archive.readUInt32LE(localOffset + 14) !== archive.readUInt32LE(cursor + 16))) fail('ZIP local sizes/CRC mismatch');
    rejectZip64Extra(archive.subarray(localOffset + 30 + localNameLength, start));
    entries.push({ name, directory, mode, method, compressed, size, start, stop, localOffset, crc: archive.readUInt32LE(cursor + 16) });
    cursor = next;
  }
  if (cursor !== end) fail('ZIP central directory length mismatch');
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if (sorted[0].localOffset !== 0) fail('Self-extracting/prefixed ZIP unsupported');
  for (let i = 1; i < sorted.length; i++) if (sorted[i].localOffset < sorted[i - 1].stop) fail('Overlapping ZIP entries');
  const entriesByKey = new Map(entries.map((entry) => [entry.name.replace(/\/$/, '').toLowerCase(), entry]));
  for (const entry of entries) {
    const parts = entry.name.replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = entriesByKey.get(parts.slice(0, i).join('/').toLowerCase());
      if (parent && !parent.directory) fail(`ZIP file/directory conflict: ${entry.name}`);
    }
  }
  // All metadata is checked before any decompression. Content stays in memory only.
  const files = new Map(), nativeFiles = [];
  for (const entry of entries) {
    const compressed = archive.subarray(entry.start, entry.stop);
    const data = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1) });
    if (data.length !== entry.size || crc32(data) !== entry.crc) fail(`ZIP content length/CRC mismatch: ${entry.name}`);
    if (!entry.directory) {
      files.set(entry.name, data);
      if (nativeContent(entry.name, data)) nativeFiles.push(entry.name);
    }
  }
  return { files, summary: { preflightPassed: true, entryCount: entries.length, compressedBytes,
    uncompressedBytes: totalBytes, nativeFiles, symlinkCount: 0, contentCrcVerified: true, extractedToDisk: false } };
}
