import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const NATIVE_PNG_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_PNG_MAX_PIXELS = 8 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

/** Returns dimensions only for a complete PNG with valid chunk CRCs. */
export function nativePngDimensions(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let dimensions = null;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd > bytes.length || chunkEnd > bytes.length) return null;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!dimensions && (type !== "IHDR" || length !== 13)) return null;
    if (dimensions && type === "IHDR") return null;
    if (crc32(bytes, offset + 4, dataEnd) !== bytes.readUInt32BE(dataEnd)) return null;
    if (type === "IHDR") dimensions = { width: bytes.readUInt32BE(dataStart), height: bytes.readUInt32BE(dataStart + 4) };
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) return null;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  return dimensions && sawData && sawEnd ? dimensions : null;
}

/** Reads an allowlisted regular file without following links and with identity/size race checks. */
export async function readNativePngNoFollow(directoryPath, filename, allowedFilenames,
  maxBytes = NATIVE_PNG_MAX_BYTES, errorPrefix = "png") {
  if (typeof directoryPath !== "string" || !directoryPath
      || !["snapshot", "presented-paint", "png"].includes(errorPrefix)) {
    throw new Error("png-path-invalid");
  }
  const directory = resolve(directoryPath);
  if (typeof filename !== "string" || !filename || !Array.isArray(allowedFilenames) || basename(filename) !== filename
      || !allowedFilenames.includes(filename) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`${errorPrefix}-path-invalid`);
  }
  const directoryInfo = await lstat(directory, { bigint: true });
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error(`${errorPrefix}-directory-invalid`);
  }
  const path = join(directory, filename);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n
      || before.size > BigInt(maxBytes) || await realpath(path) !== path) {
    throw new Error(`${errorPrefix}-file-invalid`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size > BigInt(maxBytes)) throw new Error(`${errorPrefix}-file-changed`);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes || total !== Number(opened.size)) throw new Error(`${errorPrefix}-size-invalid`);
    const after = await lstat(path, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
        || after.dev !== before.dev || after.ino !== before.ino || after.size !== BigInt(total)) {
      throw new Error(`${errorPrefix}-file-changed`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
