import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";

const maxOutputReadBytes = 8 * 1024 * 1024;
const outputTextPreviewBytes = 4096;

export type OutputEvidence = {
  name: string;
  operation: string;
  actualBytes: number | null;
  actualBytesRead: number;
  actualSha256: string | null;
  actualTextPreview: string;
  actualTextTruncated: boolean;
  expectedBytes: number;
  expectedSha256: string;
  expectedTextPreview: string;
  expectedTextTruncated: boolean;
  matches: boolean;
  complete: boolean;
  mismatchReason?: string;
  readError?: { name: string; message: string };
};

export type OutputMismatch = Pick<OutputEvidence, "name" | "operation" | "expectedSha256" | "actualSha256"
  | "expectedBytes" | "actualBytes" | "expectedTextPreview" | "actualTextPreview"
  | "expectedTextTruncated" | "actualTextTruncated" | "readError" | "mismatchReason"> & { message: string };

export async function readOutputEvidence(path: string, expected: string, operation: string): Promise<OutputEvidence> {
  const expectedBytes = Buffer.from(expected, "utf8");
  const expectedSha256 = createHash("sha256").update(expectedBytes).digest("hex");
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Output path is not a regular file");
    const complete = fileStat.size <= maxOutputReadBytes;
    const bytesToRead = Math.min(fileStat.size, maxOutputReadBytes);
    const hash = createHash("sha256");
    const preview: Buffer[] = [];
    let previewBytes = 0;
    let bytesRead = 0;
    if (bytesToRead > 0) {
      const stream = createReadStream(path, { start: 0, end: bytesToRead - 1 });
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        bytesRead += bytes.length;
        const remainingPreview = outputTextPreviewBytes - previewBytes;
        if (remainingPreview > 0) {
          const previewPart = bytes.subarray(0, remainingPreview);
          preview.push(previewPart);
          previewBytes += previewPart.length;
        }
      }
    }
    const actualSha256 = complete ? hash.digest("hex") : null;
    const actualTextPreview = Buffer.concat(preview).toString("utf8");
    const matches = complete && bytesRead === fileStat.size && fileStat.size === expectedBytes.length
      && actualSha256 === expectedSha256;
    return {
      name: basename(path), operation, actualBytes: fileStat.size, actualBytesRead: bytesRead,
      actualSha256, actualTextPreview, actualTextTruncated: fileStat.size > outputTextPreviewBytes,
      expectedBytes: expectedBytes.length, expectedSha256,
      expectedTextPreview: expectedBytes.subarray(0, outputTextPreviewBytes).toString("utf8"),
      expectedTextTruncated: expectedBytes.length > outputTextPreviewBytes, matches, complete,
      ...(complete ? {} : { mismatchReason: `output exceeds ${maxOutputReadBytes}-byte comparison budget` }),
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    return {
      name: basename(path), operation, actualBytes: null, actualBytesRead: 0, actualSha256: null,
      actualTextPreview: "", actualTextTruncated: false, expectedBytes: expectedBytes.length,
      expectedSha256, expectedTextPreview: expectedBytes.subarray(0, outputTextPreviewBytes).toString("utf8"),
      expectedTextTruncated: expectedBytes.length > outputTextPreviewBytes, matches: false,
      complete: false, readError: { name: value.name, message: value.message },
    };
  }
}

export function recordOutputEvidence(report: Record<string, any>, mismatches: OutputMismatch[], evidence: OutputEvidence) {
  report.outputs.push(evidence);
  if (!evidence.matches) mismatches.push({ name: evidence.name, operation: evidence.operation,
    expectedSha256: evidence.expectedSha256, actualSha256: evidence.actualSha256,
    expectedBytes: evidence.expectedBytes, actualBytes: evidence.actualBytes,
    expectedTextPreview: evidence.expectedTextPreview, actualTextPreview: evidence.actualTextPreview,
    expectedTextTruncated: evidence.expectedTextTruncated, actualTextTruncated: evidence.actualTextTruncated,
    readError: evidence.readError, mismatchReason: evidence.mismatchReason,
    message: `${evidence.operation}: ${evidence.name} differs from the frozen expected output` });
}

export function summarizeOutputValidation(outputs: OutputEvidence[], mismatches: OutputMismatch[], complete: boolean) {
  return { complete, matchesAll: complete && mismatches.length === 0, mismatchCount: mismatches.length,
    checks: outputs.map(item => ({ name: item.name, operation: item.operation, matches: item.matches,
      actualBytes: item.actualBytes, actualSha256: item.actualSha256,
      expectedBytes: item.expectedBytes, expectedSha256: item.expectedSha256 })), mismatches };
}
