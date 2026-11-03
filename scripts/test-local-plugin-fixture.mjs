import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  prepareLocalOriginalFixture,
  resolveCanonicalRepositorySource,
  scanLocalDirectory,
  summarizeLocalTree,
  verifyLocalOriginalFixture,
} from "./lib/local-plugin-fixture.mjs";

test("local original fixture copies every pinned byte with restrictive owned permissions", async () => {
  const prepared = await prepareLocalOriginalFixture("local-content-workbench");
  try {
    const { verification, files } = await verifyLocalOriginalFixture(prepared.fixture, prepared.profile);
    assert.equal(verification.directorySha256, prepared.profile.directorySha256);
    assert.equal(verification.fileCount, 8);
    assert.equal(files.get("plugin.json").length, 844);
    assert.equal((await stat(prepared.fixture.ownedRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(prepared.fixture.pluginRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(prepared.fixture.pluginRoot, "plugin.json"))).mode & 0o777, 0o600);
    const review = JSON.parse(await readFile(prepared.fixture.sourceReviewJSON, "utf8"));
    assert.equal(review.sourceKind, "local_full_directory");
    assert.equal(review.fixture.directorySha256, prepared.profile.directorySha256);
    assert.equal(review.verificationBoundary.includes("no plugin execution"), true);
  } finally {
    await prepared.cleanup();
  }
});

test("registered Node profile materializes its pinned preload without executing it", async () => {
  const prepared = await prepareLocalOriginalFixture("local-json-editor");
  try {
    assert.equal(prepared.profile.runtime, "node");
    const { verification, files } = await verifyLocalOriginalFixture(prepared.fixture, prepared.profile);
    const manifest = JSON.parse(files.get("plugin.json").toString("utf8"));
    assert.equal(manifest.preload, "preload.js");
    assert.equal(files.has(manifest.preload), true);
    assert.equal(verification.fileCount, prepared.profile.fileCount);
    assert.equal(verification.pluginCodeExecutedByVerification, false);

    const unregisteredRuntime = { ...prepared.profile, runtime: "wasm" };
    await assert.rejects(
      verifyLocalOriginalFixture(prepared.fixture, unregisteredRuntime),
      /Unsupported local original fixture runtime/,
    );
  } finally {
    await prepared.cleanup();
  }
});

test("plain and subnet materialize unchanged original complete trees with declared runtime boundaries", async () => {
  for (const [caseId, runtime, pathAccess, fileCount, bytes] of [["local-plain-text", "node", "standard", 7, 928976],
    ["local-subnet-calculator", "web", "none", 4, 17973]]) {
    const prepared = await prepareLocalOriginalFixture(caseId);
    try {
      const { verification, files } = await verifyLocalOriginalFixture(prepared.fixture, prepared.profile);
      assert.equal(prepared.profile.runtime, runtime); assert.equal(prepared.profile.pathAccess, pathAccess);
      assert.equal(verification.fileCount, fileCount); assert.equal(verification.expandedBytes, bytes);
      assert.equal(verification.pluginCodeExecutedByVerification, false);
      const manifest = JSON.parse(files.get("plugin.json")); assert.ok(files.has(manifest.preload));
    } finally { await prepared.cleanup(); }
  }
});

test("local original verifier notices post-copy mutation before native acceptance", async () => {
  const prepared = await prepareLocalOriginalFixture("local-developer-codec-tools");
  try {
    await writeFile(path.join(prepared.fixture.pluginRoot, "codec.js"), "tampered");
    await assert.rejects(verifyLocalOriginalFixture(prepared.fixture, prepared.profile), /changed from the independently registered witness/);
  } finally {
    await prepared.cleanup();
  }
});

test("local original verifier rejects symlinks without reading their target", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "atools-local-link-test-"));
  const prepared = await prepareLocalOriginalFixture("local-cron");
  try {
    const target = path.join(scratch, "outside");
    await writeFile(target, "must not be accepted");
    await rm(path.join(prepared.fixture.pluginRoot, "index.html"));
    await symlink(target, path.join(prepared.fixture.pluginRoot, "index.html"));
    await assert.rejects(verifyLocalOriginalFixture(prepared.fixture, prepared.profile), /symlink/);
  } finally {
    await prepared.cleanup();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("local original preparation enforces file and path budgets and temp-root confinement", async () => {
  assert.throws(() => summarizeLocalTree(new Map([["../escape", Buffer.from("x")]]), new Set()), /Unsafe local package/);
  const forbiddenTempRoot = path.parse(process.cwd()).root;
  await assert.rejects(prepareLocalOriginalFixture("local-cron", { temporaryParent: forbiddenTempRoot }), /private temporary directory/);
  const prepared = await prepareLocalOriginalFixture("local-content-workbench");
  try {
    for (let index = 0; index < 57; index += 1) await writeFile(path.join(prepared.fixture.pluginRoot, `extra-${index}.txt`), "x");
    await assert.rejects(verifyLocalOriginalFixture(prepared.fixture, prepared.profile), /file budget exceeded/);
  } finally {
    await prepared.cleanup();
  }
});

test("local package summary commits directory membership and ignores insertion order", () => {
  const first = summarizeLocalTree(new Map([["b.txt", Buffer.from("b")], ["a.txt", Buffer.from("a")]]), new Set(["z", "a"]));
  const second = summarizeLocalTree(new Map([["a.txt", Buffer.from("a")], ["b.txt", Buffer.from("b")]]), new Set(["a", "z"]));
  const changed = summarizeLocalTree(new Map([["a.txt", Buffer.from("a")], ["b.txt", Buffer.from("b")]]), new Set(["a", "z", "empty"]));
  assert.equal(first.directorySha256, second.directorySha256);
  assert.notEqual(first.directorySha256, changed.directorySha256);
});

test("repository source resolver rejects ancestor and package-root symlinks even when replica bytes match", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "atools-local-source-link-"));
  try {
    const source = path.resolve("ZTools-plugins/plugins/cron");
    const outsideTree = path.join(scratch, "outside", "ZTools-plugins", "plugins", "cron");
    await mkdir(path.dirname(outsideTree), { recursive: true });
    await cp(source, outsideTree, { recursive: true });
    const replica = await scanLocalDirectory(await realpath(outsideTree));
    assert.equal(summarizeLocalTree(replica.files, replica.directories).directorySha256,
      "4b17c9ca821c214247e642fe1fb130e5350218c9c6e5868949011dd4bed84cdd");

    const ancestorRepo = path.join(scratch, "ancestor-repo");
    await mkdir(ancestorRepo);
    await symlink(path.join(scratch, "outside", "ZTools-plugins"), path.join(ancestorRepo, "ZTools-plugins"));
    await assert.rejects(resolveCanonicalRepositorySource("ZTools-plugins/plugins/cron", ancestorRepo), /contains symlink/);

    const rootRepo = path.join(scratch, "root-repo");
    const rootLink = path.join(rootRepo, "ZTools-plugins", "plugins", "cron");
    await mkdir(path.dirname(rootLink), { recursive: true });
    await symlink(outsideTree, rootLink);
    await assert.rejects(resolveCanonicalRepositorySource("ZTools-plugins/plugins/cron", rootRepo), /contains symlink/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("directory scanner rejects depth, directory-count, single-file, and aggregate-byte overflow", async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), "atools-local-budget-"));
  try {
    await t.test("depth", async () => {
      const root = path.join(scratch, "depth");
      const nested = path.join(root, ...Array.from({ length: 17 }, (_, index) => `d${index}`));
      await mkdir(nested, { recursive: true });
      await assert.rejects(scanLocalDirectory(await realpath(root)), /depth exceeds budget|Unsafe local package path component/);
    });
    await t.test("directory count", async () => {
      const root = path.join(scratch, "directories");
      await mkdir(root);
      await Promise.all(Array.from({ length: 65 }, (_, index) => mkdir(path.join(root, `d${index}`))));
      await assert.rejects(scanLocalDirectory(await realpath(root)), /directory count exceeds budget/);
    });
    await t.test("single file", async () => {
      const root = path.join(scratch, "single-file");
      await mkdir(root);
      await writeFile(path.join(root, "oversized.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
      await assert.rejects(scanLocalDirectory(await realpath(root)), /file budget exceeded/);
    });
    await t.test("aggregate bytes", async () => {
      const root = path.join(scratch, "aggregate");
      await mkdir(root);
      for (let index = 0; index < 4; index += 1) {
        await writeFile(path.join(root, `part-${index}.bin`), Buffer.alloc(8 * 1024 * 1024));
      }
      await writeFile(path.join(root, "zz-overflow.bin"), Buffer.from("x"));
      await assert.rejects(scanLocalDirectory(await realpath(root)), /expanded size exceeds budget/);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
