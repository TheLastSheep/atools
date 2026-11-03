import assert from "node:assert/strict";

const RECORD_KEYS = ["bytes", "path", "sha256"];
const SHA256 = /^[0-9a-f]{64}$/;

function assertRecordList(records, label) {
  assert.ok(Array.isArray(records) && records.length > 0 && records.length <= 64,
    `${label} must contain between 1 and 64 source records`);
  const paths = new Set();
  for (const record of records) {
    assert.ok(record && typeof record === "object" && !Array.isArray(record)
      && Object.getPrototypeOf(record) === Object.prototype,
    `${label} records must be plain objects`);
    assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS, `${label} record keys are invalid`);
    const path = record.path;
    assert.ok(typeof path === "string" && path.length > 0
      && !path.startsWith("/") && !path.includes("\\")
      && path.split("/").every(part => part && part !== "." && part !== "..")
      && (path.endsWith(".ts") || path.endsWith(".mjs")),
    `${label} source path is not a canonical TypeScript or MJS path`);
    assert.ok(!paths.has(path), `${label} source paths must be unique`);
    paths.add(path);
    assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0,
      `${label} source byte count must be a positive safe integer`);
    assert.ok(typeof record.sha256 === "string" && SHA256.test(record.sha256),
      `${label} source hash must be lowercase SHA-256`);
  }
}

/** Validate the bounded live SourceList and bind every record to formal dist provenance. */
export function assertCatalogNativeSourceRecords(actual, formal) {
  assertRecordList(actual, "Renderer source list");
  assertRecordList(formal, "Formal renderer source list");
  assert.deepEqual(actual, formal, "Renderer host source hashes differ from dist provenance");
}
