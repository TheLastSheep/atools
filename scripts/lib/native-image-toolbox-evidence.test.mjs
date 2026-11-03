import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { IMAGE_TOOLBOX_EXPORT_EVIDENCE, retainImageToolboxExport } from "./native-image-toolbox-evidence.mjs";

const repositoryRoot = resolve(process.env.ATOOLS_REPOSITORY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const inputLogo = await readFile(join(repositoryRoot, "ZTools-plugins/plugins/calculation-paper/logo.png"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([typeBytes, data]);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function generatedPng(width, height) {
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}
function pngAtExactByteLimit(basePng) {
  const ancillaryBytes = MAX_PNG_BYTES - basePng.length - 12;
  assert.ok(ancillaryBytes > 6);
  const text = Buffer.alloc(ancillaryBytes, 0x41); text.set(Buffer.from("Note\0", "latin1"));
  const iendOffset = basePng.length - 12;
  return Buffer.concat([basePng.subarray(0, iendOffset), pngChunk("tEXt", text), basePng.subarray(iendOffset)]);
}
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const canvasPng = generatedPng(528, 365);
const limitPng = pngAtExactByteLimit(canvasPng);

async function fixture(run, { sourceBytes = inputLogo, width = 200, height = 200 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atools-image-export-retain-test-"));
  const reportDir = join(root, "run");
  const evidenceDir = join(root, "retained");
  await mkdir(reportDir);
  await mkdir(evidenceDir);
  const nativeReportPath = join(reportDir, "native-report.json");
  const artifact = {
    evidenceFile: IMAGE_TOOLBOX_EXPORT_EVIDENCE,
    evidenceRetained: true,
    bytes: sourceBytes.length,
    sha256: sha256(sourceBytes),
    width,
    height,
  };
  try {
    await writeFile(join(reportDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE), sourceBytes, { flag: "wx" });
    await run({ root, reportDir, evidenceDir, nativeReportPath, artifact });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("retains the full 528x365 canvas export from the 200x200 original-image workflow", async () => {
  assert.equal(inputLogo.length, 5031);
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact });
    assert.deepEqual(result, { passed: true, evidence: {
      file: IMAGE_TOOLBOX_EXPORT_EVIDENCE, bytes: canvasPng.length, sha256: sha256(canvasPng), width: 528, height: 365,
    } });
    assert.deepEqual(await readFile(join(evidenceDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE)), canvasPng);
  }, { sourceBytes: canvasPng, width: 528, height: 365 });
});

test("retains a PNG exactly at the 8 MiB encoded bound", async () => {
  assert.equal(limitPng.length, MAX_PNG_BYTES);
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact });
    assert.equal(result.passed, true);
    assert.equal(result.evidence.bytes, MAX_PNG_BYTES);
    assert.deepEqual(await readFile(join(evidenceDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE)), limitPng);
  }, { sourceBytes: limitPng, width: 528, height: 365 });
});

test("retains a decoded-size mismatch artifact without converting its failed native gate", async () => {
  const mismatchPng = generatedPng(112, 72);
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const mismatch = { ...artifact, passed: false, errorCode: "image-output-dimensions-mismatch" };
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact: mismatch });
    // `passed` here means the bounded copies match; it is not a PNG decode verdict.
    assert.equal(result.passed, true);
    assert.equal(mismatch.passed, false);
    assert.equal(result.evidence.width, 112);
    assert.equal(result.evidence.height, 72);
  }, { sourceBytes: mismatchPng, width: 112, height: 72 });
});

test("accepts the exact decoded RGBA budget and rejects one row above it", async () => {
  const exact = generatedPng(8192, 256);
  const over = generatedPng(8192, 257);
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact });
    assert.equal(result.passed, true);
    assert.equal(result.evidence.width * result.evidence.height * 4, 8 * 1024 * 1024);
  }, { sourceBytes: exact, width: 8192, height: 256 });
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact });
    assert.deepEqual(result, { passed: false, errorCode: "image-output-retention-verification-failed" });
    assert.equal(await readFile(join(evidenceDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE)).catch(() => null), null);
  }, { sourceBytes: over, width: 8192, height: 257 });
});

test("retains bounded failure evidence with unknown dimensions without converting it to a decode pass", async () => {
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const unknown = { ...artifact, passed: false, errorCode: "image-output-png-decode-failed", width: null, height: null };
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact: unknown });
    assert.deepEqual(result, { passed: true, evidence: {
      file: IMAGE_TOOLBOX_EXPORT_EVIDENCE, bytes: inputLogo.length, sha256: sha256(inputLogo), width: null, height: null,
    } });
    assert.equal(unknown.passed, false);
    assert.deepEqual(await readFile(join(evidenceDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE)), inputLogo);
  });
});

test("rejects metadata mismatch and leaves any existing evidence writer untouched", async () => {
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact: { ...artifact, sha256: "0".repeat(64) } });
    assert.deepEqual(result, { passed: false, errorCode: "image-output-retention-verification-failed" });
    const target = join(evidenceDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE);
    await writeFile(target, Buffer.from("prior-writer"), { flag: "wx" });
    const collision = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact });
    assert.equal(collision.passed, false);
    assert.equal((await readFile(target)).toString(), "prior-writer");
  });
});

test("rejects symlinked native artifacts without following them", async () => {
  await fixture(async ({ root, reportDir, evidenceDir, nativeReportPath, artifact }) => {
    const source = join(reportDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE);
    await rm(source);
    const outside = join(root, "outside.png");
    await writeFile(outside, inputLogo, { flag: "wx" });
    await symlink(outside, source);
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact });
    assert.equal(result.passed, false);
    assert.deepEqual(await readFile(outside), inputLogo);
  });
});

test("rejects a sibling artifact one byte above the 8 MiB bound", async () => {
  const overLimit = Buffer.concat([limitPng, Buffer.from([0])]);
  await fixture(async ({ evidenceDir, nativeReportPath, artifact }) => {
    const result = await retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact });
    assert.deepEqual(result, { passed: false, errorCode: "image-output-retention-verification-failed" });
    assert.equal(await readFile(join(evidenceDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE)).catch(() => null), null);
  }, { sourceBytes: overLimit, width: 528, height: 365 });
});
