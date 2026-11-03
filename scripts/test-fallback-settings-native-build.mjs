import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertResourceBudget,
  createProvenance,
  manifestDigest,
  normalizeFixtureEntryHtml,
  readResourceManifest,
  RESOURCE_LIMITS,
  SOURCE_LIMITS,
} from "./build-fallback-settings-native.mjs";

const sha = value => Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);

test("provenance sorts source/resource entries and hashes the exact JSON arrays", () => {
  const provenance = createProvenance(
    [
      { path: "src/z.ts", sha256: sha("z"), bytes: 1 },
      { path: "src/a.ts", sha256: sha("a"), bytes: 2 },
    ],
    [
      { path: "assets/main.js", sha256: sha("j"), bytes: 3 },
      { path: "index.html", sha256: sha("h"), bytes: 4 },
    ],
  );

  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.owner, "@atools/fallback-settings-native-fixture");
  assert.deepEqual(provenance.sources.map(entry => entry.path), ["src/a.ts", "src/z.ts"]);
  assert.deepEqual(provenance.resources.map(entry => entry.path), ["assets/main.js", "index.html"]);
  assert.equal(provenance.sourceSha256, manifestDigest(provenance.sources));
  assert.equal(provenance.resourceSha256, manifestDigest(provenance.resources));
  assert.equal(provenance.resourceBytes, 7);
  assert.equal(provenance.resourceCount, 2);
});

test("source closure enforces count, path, per-file, aggregate, and metadata limits", () => {
  const resource = [{ path: "index.html", sha256: sha("index"), bytes: 1 }];
  const source = (index, bytes = 0, name = `source-${index}.ts`) => ({
    path: `src/${name}`,
    sha256: sha(String(index)),
    bytes,
  });

  const exactBytes = Array.from({ length: 8 }, (_, index) => source(index, SOURCE_LIMITS.fileBytes));
  assert.equal(createProvenance(exactBytes, resource).sources.length, 8);
  assert.throws(() => createProvenance([
    ...exactBytes,
    source(8, 1),
  ], resource), /total limit/);
  assert.throws(() => createProvenance([
    source(0, SOURCE_LIMITS.fileBytes + 1),
  ], resource), /file limit/);
  assert.throws(() => createProvenance(
    Array.from({ length: SOURCE_LIMITS.files + 1 }, (_, index) => source(index)),
    resource,
  ), /count/);
  assert.throws(() => createProvenance([
    { ...source(0), path: `src/${"x".repeat(SOURCE_LIMITS.pathBytes)}` },
  ], resource), /invalid entry/);
  assert.throws(() => createProvenance([
    { ...source(0), path: "a/b/c/d/e/f/g/h/i.ts" },
  ], resource), /invalid entry/);

  const metadataHeavy = Array.from({ length: SOURCE_LIMITS.files }, (_, index) => source(
    index,
    0,
    `${String(index).padStart(3, "0")}-${"x".repeat(3400)}.ts`,
  ));
  assert.throws(() => createProvenance(metadataHeavy, resource), /metadata limit/);
});

test("resource budgets accept limits and reject too many, too large, or too many total bytes", () => {
  const exact = Array.from({ length: RESOURCE_LIMITS.files }, (_, index) => ({
    path: index === 0 ? "index.html" : `assets/${String(index).padStart(2, "0")}.js`,
    sha256: sha(String(index)),
    bytes: index === 1 || index === 2 ? RESOURCE_LIMITS.fileBytes : 0,
  }));
  assert.equal(assertResourceBudget(exact), RESOURCE_LIMITS.totalBytes);

  assert.throws(() => assertResourceBudget([...exact, {
    path: "assets/overflow.js", sha256: sha("overflow"), bytes: 1,
  }]), /count/);
  assert.throws(() => assertResourceBudget([
    { path: "index.html", sha256: sha("large"), bytes: RESOURCE_LIMITS.fileBytes + 1 },
  ]), /file limit/);
  assert.throws(() => assertResourceBudget([
    { path: "index.html", sha256: sha("one"), bytes: RESOURCE_LIMITS.fileBytes },
    { path: "assets/two.js", sha256: sha("two"), bytes: RESOURCE_LIMITS.fileBytes },
    { path: "assets/three.js", sha256: sha("three"), bytes: 1 },
  ]), /total limit/);
});

test("manifest rejects unsafe and duplicate relative paths", () => {
  assert.throws(() => createProvenance(
    [{ path: "../outside.ts", sha256: sha("x"), bytes: 1 }],
    [{ path: "index.html", sha256: sha("h"), bytes: 1 }],
  ), /invalid entry/);
  assert.throws(() => createProvenance(
    [
      { path: "src/a.ts", sha256: sha("a"), bytes: 1 },
      { path: "src/a.ts", sha256: sha("a"), bytes: 1 },
    ],
    [{ path: "index.html", sha256: sha("h"), bytes: 1 }],
  ), /duplicate path/);
  assert.throws(() => createProvenance(
    [],
    [{ path: "index.html", sha256: sha("h"), bytes: 1 }, { path: "outside.js", sha256: sha("x"), bytes: 1 }],
  ), /outside assets/);
});

test("resource collection hashes only index.html and assets in the fixed dist tree", async t => {
  const root = await mkdtemp(join(tmpdir(), "atools-fallback-settings-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main></main>");
  await writeFile(join(root, "assets", "app.js"), "document.body.dataset.ready='true';");

  const entries = await readResourceManifest(root);
  assert.deepEqual(entries.map(entry => entry.path), ["assets/app.js", "index.html"]);
  assert.equal(entries.reduce((sum, entry) => sum + entry.bytes, 0), Buffer.byteLength("<main></main>") + Buffer.byteLength("document.body.dataset.ready='true';"));
});

test("fixture entry is linked to index.html and only its empty generated directories are removed", async t => {
  const root = await mkdtemp(join(tmpdir(), "atools-fallback-settings-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tests", "components"), { recursive: true });
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "tests", "components", "fallback-settings-native.html"), "<main>fixture</main>");
  await writeFile(join(root, "assets", "app.js"), "window.fixture=true;");

  await normalizeFixtureEntryHtml(root);
  assert.equal(await readFile(join(root, "index.html"), "utf8"), "<main>fixture</main>");
  await assert.rejects(lstat(join(root, "tests")), { code: "ENOENT" });
  assert.deepEqual((await readResourceManifest(root)).map(entry => entry.path), ["assets/app.js", "index.html"]);
});

test("entry normalization refuses to overwrite an existing index", async t => {
  const root = await mkdtemp(join(tmpdir(), "atools-fallback-settings-entry-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tests", "components"), { recursive: true });
  await writeFile(join(root, "tests", "components", "fallback-settings-native.html"), "<main>source</main>");
  await writeFile(join(root, "index.html"), "<main>existing</main>");

  await assert.rejects(normalizeFixtureEntryHtml(root), /already contains index.html/);
  assert.equal(await readFile(join(root, "index.html"), "utf8"), "<main>existing</main>");
  assert.equal(await readFile(join(root, "tests", "components", "fallback-settings-native.html"), "utf8"), "<main>source</main>");
});

test("resource collection rejects symlinks and files outside the fixture asset layout", async t => {
  const root = await mkdtemp(join(tmpdir(), "atools-fallback-settings-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main></main>");
  await writeFile(join(root, "secret.txt"), "not a fixture resource");
  await assert.rejects(readResourceManifest(root), /Unexpected fallback settings output path/);
  await rm(join(root, "secret.txt"));
  await symlink("../index.html", join(root, "assets", "link.html"));
  await assert.rejects(readResourceManifest(root), /Symlinks are not allowed/);
});
