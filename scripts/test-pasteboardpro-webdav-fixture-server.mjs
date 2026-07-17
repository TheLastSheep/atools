import assert from "node:assert/strict";

import { createPasteboardProWebDavFixtureServer } from "./pasteboardpro-webdav-fixture-server.mjs";

const fixture = await createPasteboardProWebDavFixtureServer();
const auth = `Basic ${Buffer.from(`${fixture.username}:${fixture.password}`).toString("base64")}`;
const request = (relative, options = {}) => fetch(new URL(relative, fixture.url), {
  ...options,
  headers: { authorization: auth, ...(options.headers ?? {}) },
});

try {
  assert.equal((await fetch(new URL("vault.json", fixture.url))).status, 401);

  const created = await request("vault.json", {
    method: "PUT",
    headers: { "if-none-match": "*", "content-type": "application/json" },
    body: '{"encrypted":true}',
  });
  assert.equal(created.status, 201);
  const firstEtag = created.headers.get("etag");
  assert.match(firstEtag ?? "", /^"sha256-[0-9a-f]{64}"$/);

  assert.equal((await request("vault.json", {
    method: "PUT",
    headers: { "if-none-match": "*" },
    body: "duplicate",
  })).status, 412);

  assert.equal((await request("vault.json", {
    method: "PUT",
    headers: { "if-match": '"stale"' },
    body: "stale",
  })).status, 412);

  const updated = await request("vault.json", {
    method: "PUT",
    headers: { "if-match": firstEtag },
    body: '{"encrypted":"updated"}',
  });
  assert.equal(updated.status, 204);
  assert.notEqual(updated.headers.get("etag"), firstEtag);

  const read = await request("vault.json");
  assert.equal(read.status, 200);
  assert.equal(await read.text(), '{"encrypted":"updated"}');

  fixture.injectResponse({ method: "GET", path: "index.enc", status: 500 });
  assert.equal((await request("index.enc")).status, 500);
  assert.equal((await request("index.enc")).status, 404);

  fixture.injectResponse({ method: "GET", path: "index.enc", status: 401 });
  assert.equal((await request("index.enc")).status, 401);

  await fixture.corrupt("vault.json");
  const corrupted = new Uint8Array(await (await request("vault.json")).arrayBuffer());
  assert.notEqual(Buffer.from(corrupted).toString("utf8"), '{"encrypted":"updated"}');

  fixture.interruptUpload({ path: "objects/interrupted.enc" });
  await assert.rejects(
    request("objects/interrupted.enc", { method: "PUT", body: Buffer.alloc(64 * 1_024, 7) }),
  );
  assert.equal((await request("objects/interrupted.enc")).status, 404);

  const collection = await request("objects", { method: "MKCOL" });
  assert.equal(collection.status, 201);
  const listing = await request("", { method: "PROPFIND", headers: { depth: "1" } });
  assert.equal(listing.status, 207);
  const listingXml = await listing.text();
  assert.match(listingXml, /vault\.json/);
  assert.match(listingXml, /objects/);

  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.map((entry) => entry.path), ["vault.json"]);
  assert.equal(fixture.counters.conditionalConflicts, 2);
  assert.equal(fixture.counters.injectedResponses, 2);
  assert.equal(fixture.counters.interruptedUploads, 1);
  assert.equal(fixture.counters.corruptedFiles, 1);
  console.log("PasteboardPro WebDAV fixture server verified");
} finally {
  await fixture.close();
}
