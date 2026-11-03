import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { inspectLocalZpxArchive } from "./lib/local-original-archive-fixture.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function makeArchive(entries, alter = () => {}) {
  const files = {}, dirs = new Set();
  for (const [name, bytes] of entries) {
    const parts = name.split("/"); let cursor = files;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      dirs.add(parts.slice(0, index + 1).join("/"));
      cursor = cursor[part] ||= { files: {} };
      cursor = cursor.files;
    }
    cursor[parts.at(-1)] = { size: bytes.length, offset: String(0) };
  }
  const payload = Buffer.concat(entries.map(([, bytes]) => bytes));
  let offset = 0;
  for (const [name] of entries) {
    const parts = name.split("/"); let cursor = files;
    for (const part of parts.slice(0, -1)) cursor = cursor[part].files;
    cursor[parts.at(-1)].offset = String(offset);
    offset += entries.find(([key]) => key === name)[1].length;
  }
  alter(files);
  const json = Buffer.from(JSON.stringify({ files }), "utf8");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(json.length + 8, 4);
  header.writeUInt32LE(json.length + 4, 8); header.writeUInt32LE(json.length, 12);
  return brotliCompressSync(Buffer.concat([header, json, payload]));
}

const body = Buffer.from("fixed bytes");
const input = [["nested/data.bin", body]];
const witness = { files: [{ path: "nested/data.bin", bytes: body.length, sha256: sha(body) }], directories: ["nested"] };

assert.deepEqual(inspectLocalZpxArchive(makeArchive(input), witness).get("nested/data.bin"), body);
assert.throws(() => inspectLocalZpxArchive(makeArchive(input), { ...witness, files: [] }), /exact pinned witness/);
assert.throws(() => inspectLocalZpxArchive(Buffer.from("not brotli"), witness), /Brotli/);
assert.throws(() => inspectLocalZpxArchive(makeArchive([["../escape", body]]), witness), /Unsafe ASAR path/);
assert.throws(() => inspectLocalZpxArchive(makeArchive(input, files => { files.nested.files["data.bin"].unpacked = true; }), witness), /unpacked/);
assert.throws(() => inspectLocalZpxArchive(makeArchive([["a", body], ["b", body]], files => { files.b.offset = "0"; }),
  { files: [{ path: "a", bytes: body.length, sha256: sha(body) }, { path: "b", bytes: body.length, sha256: sha(body) }], directories: [] }), /overlaps/);

console.log("local original archive fixture tests passed (6 checks)");
