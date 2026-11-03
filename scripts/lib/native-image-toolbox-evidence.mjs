import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const IMAGE_TOOLBOX_EXPORT_EVIDENCE = "image-toolbox-export.png";
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_RGBA_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8192;
const HASH = /^[a-f0-9]{64}$/;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validArtifact(artifact, bytes, sha256) {
  const knownDimensions = Number.isSafeInteger(artifact?.width) && Number.isSafeInteger(artifact?.height)
    && artifact.width >= 1 && artifact.width <= MAX_IMAGE_SIDE
    && artifact.height >= 1 && artifact.height <= MAX_IMAGE_SIDE
    && artifact.width * artifact.height * 4 <= MAX_DECODED_RGBA_BYTES;
  const unknownDimensions = artifact?.width === null && artifact?.height === null;
  return artifact?.evidenceFile === IMAGE_TOOLBOX_EXPORT_EVIDENCE
    && artifact.evidenceRetained === true
    && artifact.bytes === bytes.length
    && typeof artifact.sha256 === "string" && HASH.test(artifact.sha256) && artifact.sha256 === sha256
    && (knownDimensions || unknownDimensions);
}

/** Copies a bounded native sibling artifact; native PNG decoding and canvas matching remain separate gates. */
export async function retainImageToolboxExport({ nativeReportPath, evidenceDir, artifact }) {
  try {
    const directory = await lstat(evidenceDir);
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("evidence-directory");
    const source = join(dirname(nativeReportPath), IMAGE_TOOLBOX_EXPORT_EVIDENCE);
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size < 1 || sourceStat.size > MAX_PNG_BYTES) {
      throw new Error("source-bounds");
    }
    const bytes = await readFile(source);
    const sha256 = digest(bytes);
    if (bytes.length !== sourceStat.size || bytes.length > MAX_PNG_BYTES || !validArtifact(artifact, bytes, sha256)) {
      throw new Error("native-metadata");
    }
    const destination = join(evidenceDir, IMAGE_TOOLBOX_EXPORT_EVIDENCE);
    await writeFile(destination, bytes, { flag: "wx" });
    const retainedStat = await lstat(destination);
    const retained = await readFile(destination);
    if (retainedStat.isSymbolicLink() || !retainedStat.isFile() || retainedStat.size !== bytes.length
      || !retained.equals(bytes) || digest(retained) !== sha256) throw new Error("retained-metadata");
    return {
      passed: true,
      evidence: { file: IMAGE_TOOLBOX_EXPORT_EVIDENCE, bytes: bytes.length, sha256, width: artifact.width, height: artifact.height },
    };
  } catch {
    return { passed: false, errorCode: "image-output-retention-verification-failed" };
  }
}
