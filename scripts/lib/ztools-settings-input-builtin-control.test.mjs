import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  TIMESTAMP_BUILTIN_RESOURCE_PATH,
  TIMESTAMP_BUILTIN_SOURCE_FILES,
  stageBuiltinControlFiles,
  stageTimestampBuiltinControl,
} from "./ztools-settings-input-builtin-control.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const contents = new Map([
  ["index.html", Buffer.from("<!doctype html><html></html>\n")],
  ["logo.svg", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n")],
  ["plugin.json", Buffer.from('{"main":"index.html","logo":"logo.svg"}\n')],
]);

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashesFor(names = contents.keys()) {
  return Object.fromEntries([...names].map(name => [
    `resources/plugins/builtin/timestamp/${name}`, sha(contents.get(name)),
  ]));
}

async function fixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "settings-input-builtin-control-"));
  const root = await realpath(temporaryRoot);
  const sourceRoot = join(root, "source");
  const appResourcesPath = join(root, "Resources");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(appResourcesPath, { mode: 0o700 });
  for (const [name, bytes] of contents) await writeFile(join(sourceRoot, name), bytes, { flag: "wx", mode: 0o600 });
  return { root, sourceRoot, appResourcesPath, dispose: () => rm(temporaryRoot, { recursive: true, force: true }) };
}

test("stages all three real workspace timestamp files at the exact builtin path with matching hashes", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "settings-input-builtin-workspace-"));
  const root = await realpath(temporaryRoot);
  const appResourcesPath = join(root, "Resources");
  await mkdir(appResourcesPath, { mode: 0o700 });
  const sourceHashes = Object.fromEntries(await Promise.all(TIMESTAMP_BUILTIN_SOURCE_FILES.map(async path => [
    path, sha(await readFile(join(repositoryRoot, path))),
  ])));
  try {
    const summary = await stageTimestampBuiltinControl({ appResourcesPath, sourceHashes });
    assert.equal(summary.resourcePath, `Contents/Resources/${TIMESTAMP_BUILTIN_RESOURCE_PATH}`);
    assert.equal(summary.fileCount, 3);
    assert.deepEqual(summary.files.map(file => file.path), ["index.html", "logo.svg", "plugin.json"]);
    assert.equal(summary.resourceBytes, summary.files.reduce((total, file) => total + file.bytes, 0));
    for (const file of summary.files) {
      const staged = await readFile(join(appResourcesPath, "plugins/builtin/timestamp", file.path));
      assert.equal(staged.byteLength, file.bytes);
      assert.equal(sha(staged), file.sha256);
      assert.equal(file.sha256, sourceHashes[`resources/plugins/builtin/timestamp/${file.path}`]);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects source directories containing extra files and removes only created staging paths", async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.sourceRoot, "unexpected.txt"), "extra", { flag: "wx" });
    await assert.rejects(stageBuiltinControlFiles({
      sourceRoot: item.sourceRoot, appResourcesPath: item.appResourcesPath, sourceHashes: hashesFor(),
    }), /source file set/);
    await assert.rejects(readFile(join(item.appResourcesPath, "plugins")), { code: "ENOENT" });
    assert.equal(await readFile(join(item.sourceRoot, "unexpected.txt"), "utf8"), "extra");
  } finally {
    await item.dispose();
  }
});

test("enforces per-file and aggregate byte limits before creating destination paths", async () => {
  for (const size of [128 * 1024 + 1, 90 * 1024]) {
    const item = await fixture();
    try {
      for (const name of contents.keys()) {
        await writeFile(join(item.sourceRoot, name), Buffer.alloc(size, 1));
      }
      const sourceHashes = Object.fromEntries(await Promise.all(TIMESTAMP_BUILTIN_SOURCE_FILES.map(async path => [
        path, sha(await readFile(join(item.sourceRoot, path.split("/").at(-1)))),
      ])));
      await assert.rejects(stageBuiltinControlFiles({
        sourceRoot: item.sourceRoot, appResourcesPath: item.appResourcesPath, sourceHashes,
      }), size > 128 * 1024 ? /bounded unlinked regular file/ : /total byte limit/);
      await assert.rejects(readFile(join(item.appResourcesPath, "plugins")), { code: "ENOENT" });
    } finally {
      await item.dispose();
    }
  }
});

test("rejects symbolic links and hard-linked source files before staging", async () => {
  for (const kind of ["symlink", "hardlink"]) {
    const item = await fixture();
    try {
      const sourceFile = join(item.sourceRoot, "index.html");
      const original = join(item.root, "original.html");
      await link(sourceFile, original);
      if (kind === "symlink") {
        await rm(sourceFile);
        await symlink(original, sourceFile);
      }
      await assert.rejects(stageBuiltinControlFiles({
        sourceRoot: item.sourceRoot, appResourcesPath: item.appResourcesPath, sourceHashes: hashesFor(),
      }));
      await assert.rejects(readFile(join(item.appResourcesPath, "plugins")), { code: "ENOENT" });
      assert.equal(await readFile(original, "utf8"), contents.get("index.html").toString());
    } finally {
      await item.dispose();
    }
  }
});

test("preserves a pre-existing destination symlink and its target on collision", async () => {
  const item = await fixture();
  const external = join(item.root, "outside");
  const plugins = join(item.appResourcesPath, "plugins");
  const builtin = join(plugins, "builtin");
  const destination = join(builtin, "timestamp");
  try {
    await writeFile(external, "preserve", { flag: "wx" });
    await mkdir(plugins, { mode: 0o700 });
    await mkdir(builtin, { mode: 0o700 });
    await symlink(external, destination);
    await assert.rejects(stageBuiltinControlFiles({
      sourceRoot: item.sourceRoot, appResourcesPath: item.appResourcesPath, sourceHashes: hashesFor(),
    }));
    assert.equal(await readFile(external, "utf8"), "preserve");
    assert.equal((await realpath(destination)), await realpath(external));
  } finally {
    await item.dispose();
  }
});
