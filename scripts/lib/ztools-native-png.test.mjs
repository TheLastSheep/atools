import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  NATIVE_PNG_MAX_BYTES,
  NATIVE_PNG_MAX_PIXELS,
  nativePngDimensions,
  readNativePngNoFollow,
} from "./ztools-native-png.mjs";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}

function png(width = 2, height = 2) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = x * 37;
      pixels[offset + 1] = y * 53;
      pixels[offset + 2] = 127;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function withDirectory(callback) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atools-native-png-")));
  try { await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("exposes the original PNG byte and pixel caps", () => {
  assert.equal(NATIVE_PNG_MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(NATIVE_PNG_MAX_PIXELS, 8 * 1024 * 1024);
});

test("accepts complete PNG chunks with valid CRCs and rejects corruption or trailing bytes", () => {
  const bytes = png();
  assert.deepEqual(nativePngDimensions(bytes), { width: 2, height: 2 });

  const corruptedCrc = Buffer.from(bytes);
  corruptedCrc[29] ^= 0xff;
  assert.equal(nativePngDimensions(corruptedCrc), null);
  assert.equal(nativePngDimensions(Buffer.concat([bytes, Buffer.from([0])])), null);
  assert.equal(nativePngDimensions(bytes.subarray(0, -4)), null);
});

test("reads only allowlisted regular files within the no-follow size bound", async () => {
  await withDirectory(async directory => {
    const bytes = png();
    await writeFile(join(directory, "accepted.png"), bytes, { flag: "wx" });
    assert.deepEqual(await readNativePngNoFollow(directory, "accepted.png", ["accepted.png"], bytes.length), bytes);
    await assert.rejects(readNativePngNoFollow(directory, "../accepted.png", ["accepted.png"]), /png-path-invalid/);
    await assert.rejects(readNativePngNoFollow(directory, "accepted.png", ["accepted.png"], bytes.length - 1), /png-file-invalid/);
    await symlink(join(directory, "accepted.png"), join(directory, "linked.png"));
    await assert.rejects(readNativePngNoFollow(directory, "linked.png", ["linked.png"]), /png-file-invalid/);
  });
});
