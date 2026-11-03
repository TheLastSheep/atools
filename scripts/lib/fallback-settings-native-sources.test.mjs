import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FALLBACK_SETTINGS_NATIVE_OWNER,
  FALLBACK_SETTINGS_NATIVE_RESOURCE_PATH,
  assertFallbackSettingsNativeSourcesUnchanged,
  captureFallbackSettingsNativeSources,
  stageFallbackSettingsNativeResources,
} from "./fallback-settings-native-sources.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(path, bytes) {
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
}

async function fixture({ sourceSymlink = false, resourceSymlink = false } = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "fallback-settings-native-"));
  const root = await realpath(temporaryRoot);
  const distRoot = join(root, "output/fallback-settings-native-dist");
  const sourcePaths = [
    ["package.json", Buffer.from("{}\n")],
    ["pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\n")],
    ["scripts/build-fallback-settings-native.mjs", Buffer.from("export const owner = 'fixture';\n")],
    ["svelte.config.js", Buffer.from("export default {};\n")],
    ["tests/components/fallback-settings-native.html", Buffer.from("<div id=app></div>\n")],
    ["tests/components/fallbackSettingsNativeFixture.ts", Buffer.from("export const settings = true;\n")],
    ["tests/components/fallbackSettingsNativeReadiness.ts", Buffer.from("export const wait = true;\n")],
    ["tsconfig.json", Buffer.from("{}\n")],
    ["vite.config.ts", Buffer.from("export default {};\n")],
    ["src/App.svelte", Buffer.from("<main>settings</main>\n")],
  ];
  const resourcePaths = [
    ["assets/chunks/settings.js", Buffer.from("globalThis.settingsPanelReady = true;\n")],
    ["index.html", Buffer.from("<!doctype html><div id=app></div>\n")],
  ];
  for (const [path, bytes] of sourcePaths) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, bytes);
  }
  await mkdir(join(distRoot, "assets/chunks"), { recursive: true });
  for (const [path, bytes] of resourcePaths) await writeFile(join(distRoot, path), bytes);
  if (sourceSymlink) {
    const source = sourcePaths[0];
    await rm(join(root, source[0]));
    await symlink("/etc/hosts", join(root, source[0]));
  }
  if (resourceSymlink) {
    const resource = resourcePaths[0];
    await rm(join(distRoot, resource[0]));
    await symlink("/etc/hosts", join(distRoot, resource[0]));
  }

  const sources = sourcePaths.map(([path, bytes]) => record(path, bytes))
    .sort((left, right) => left.path.localeCompare(right.path));
  const resources = resourcePaths.map(([path, bytes]) => record(path, bytes))
    .sort((left, right) => left.path.localeCompare(right.path));
  const provenance = {
    schemaVersion: 1,
    owner: FALLBACK_SETTINGS_NATIVE_OWNER,
    sources,
    sourceSha256: sha256(JSON.stringify(sources)),
    resources,
    resourceSha256: sha256(JSON.stringify(resources)),
    resourceBytes: resources.reduce((sum, item) => sum + item.bytes, 0),
    resourceCount: resources.length,
  };
  await writeFile(join(distRoot, "build-provenance.json"), JSON.stringify(provenance));
  return {
    root, distRoot, sourcePaths, resourcePaths, provenance,
    dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

async function rewriteProvenance(item) {
  item.provenance.sourceSha256 = sha256(JSON.stringify(item.provenance.sources));
  item.provenance.resourceSha256 = sha256(JSON.stringify(item.provenance.resources));
  item.provenance.resourceBytes = item.provenance.resources.reduce((total, record) => total + record.bytes, 0);
  item.provenance.resourceCount = item.provenance.resources.length;
  await writeFile(join(item.distRoot, "build-provenance.json"), JSON.stringify(item.provenance));
}

async function replaceResourceTree(item, entries) {
  await rm(join(item.distRoot, "assets"), { recursive: true, force: true });
  await rm(join(item.distRoot, "index.html"), { force: true });
  const resources = [];
  for (const [path, bytes] of entries) {
    const target = join(item.distRoot, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, bytes);
    resources.push(record(path, bytes));
  }
  item.provenance.resources = resources.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  await rewriteProvenance(item);
}

test("validates sorted provenance against real source and dist bytes", async () => {
  const item = await fixture();
  try {
    const snapshot = await captureFallbackSettingsNativeSources(item.root);
    assert.equal(snapshot.summary.owner, FALLBACK_SETTINGS_NATIVE_OWNER);
    assert.equal(snapshot.summary.sourceCount, 10);
    assert.equal(snapshot.summary.resourceCount, 2);
    assert.equal(snapshot.summary.resourceBytes, item.provenance.resourceBytes);
    assert.equal(snapshot.resources[0].path, "assets/chunks/settings.js");
    await assertFallbackSettingsNativeSourcesUnchanged(snapshot);
  } finally {
    await item.dispose();
  }
});

test("stages only verified resources and provenance into the exact app resource namespace", async () => {
  const item = await fixture();
  const appBundlePath = join(item.root, "fixture.app");
  const contents = join(appBundlePath, "Contents");
  const resources = join(contents, "Resources");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  try {
    const snapshot = await captureFallbackSettingsNativeSources(item.root);
    const staged = await stageFallbackSettingsNativeResources(snapshot, appBundlePath);
    assert.deepEqual(staged, {
      staged: true,
      resourcePath: FALLBACK_SETTINGS_NATIVE_RESOURCE_PATH,
      resourceCount: 2,
      resourceBytes: item.provenance.resourceBytes,
      provenanceSha256: sha256(await readFile(join(item.distRoot, "build-provenance.json"))),
      sourceSha256: item.provenance.sourceSha256,
      resourceSha256: item.provenance.resourceSha256,
    });
    for (const [path] of item.resourcePaths) {
      const target = join(resources, "atools-fallback-settings-qa", path);
      assert.deepEqual(await readFile(target), await readFile(join(item.distRoot, path)));
      assert.equal((await lstat(target)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readFile(join(resources, "atools-fallback-settings-qa/build-provenance.json")),
      await readFile(join(item.distRoot, "build-provenance.json")));
  } finally {
    await item.dispose();
  }
});

test("rejects malformed owner, unsorted source lists, and incorrect canonical digests", async () => {
  for (const mutate of [
    value => { value.owner = "@other/fixture"; },
    value => { value.sources.reverse(); value.sourceSha256 = sha256(JSON.stringify(value.sources)); },
    value => { value.sourceSha256 = "0".repeat(64); },
    value => { value.extra = true; },
  ]) {
    const item = await fixture();
    try {
      const altered = structuredClone(item.provenance);
      mutate(altered);
      await writeFile(join(item.distRoot, "build-provenance.json"), JSON.stringify(altered));
      await assert.rejects(captureFallbackSettingsNativeSources(item.root));
    } finally {
      await item.dispose();
    }
  }
});

test("rejects stale source declarations and source-tree symlinks", async () => {
  const stale = await fixture();
  try {
    await writeFile(join(stale.root, stale.sourcePaths[0][0]), "changed source\n");
    await assert.rejects(captureFallbackSettingsNativeSources(stale.root), /source differs/);
  } finally {
    await stale.dispose();
  }
  const linked = await fixture({ sourceSymlink: true });
  try { await assert.rejects(captureFallbackSettingsNativeSources(linked.root)); }
  finally { await linked.dispose(); }
});

test("rejects resource symlinks, unlisted output files, and over-budget bytes", async () => {
  const linked = await fixture({ resourceSymlink: true });
  try { await assert.rejects(captureFallbackSettingsNativeSources(linked.root)); }
  finally { await linked.dispose(); }

  const extra = await fixture();
  try {
    await writeFile(join(extra.distRoot, "unexpected.json"), "{}\n");
    await assert.rejects(captureFallbackSettingsNativeSources(extra.root));
  } finally {
    await extra.dispose();
  }

  const tooLarge = await fixture();
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 1, 7);
    await writeFile(join(tooLarge.distRoot, "assets/chunks/settings.js"), bytes);
    tooLarge.provenance.resources[0] = record("assets/chunks/settings.js", bytes);
    tooLarge.provenance.resourceBytes = tooLarge.provenance.resources.reduce((sum, item) => sum + item.bytes, 0);
    tooLarge.provenance.resourceSha256 = sha256(JSON.stringify(tooLarge.provenance.resources));
    await writeFile(join(tooLarge.distRoot, "build-provenance.json"), JSON.stringify(tooLarge.provenance));
    await assert.rejects(captureFallbackSettingsNativeSources(tooLarge.root));
  } finally {
    await tooLarge.dispose();
  }
});

test("enforces source and resource count, per-file, and aggregate caps before staging", async () => {
  const tooManyResources = await fixture();
  try {
    await replaceResourceTree(tooManyResources, [
      ["index.html", Buffer.from("<main></main>")],
      ...Array.from({ length: 64 }, (_, index) => [`assets/${String(index).padStart(2, "0")}.js`, Buffer.from("x")]),
    ]);
    await assert.rejects(captureFallbackSettingsNativeSources(tooManyResources.root));
  } finally { await tooManyResources.dispose(); }

  const aggregateResources = await fixture();
  try {
    await replaceResourceTree(aggregateResources, [
      ["index.html", Buffer.alloc(800 * 1024, 1)],
      ["assets/a.js", Buffer.alloc(800 * 1024, 2)],
      ["assets/b.js", Buffer.alloc(800 * 1024, 3)],
    ]);
    await assert.rejects(captureFallbackSettingsNativeSources(aggregateResources.root));
  } finally { await aggregateResources.dispose(); }

  const tooManySources = await fixture();
  try {
    tooManySources.provenance.sources = Array.from({ length: 513 }, (_, index) => ({
      path: `src/generated-${String(index).padStart(3, "0")}.ts`, sha256: "a".repeat(64), bytes: 1,
    }));
    await rewriteProvenance(tooManySources);
    await assert.rejects(captureFallbackSettingsNativeSources(tooManySources.root));
  } finally { await tooManySources.dispose(); }

  const tooLargeSource = await fixture();
  try {
    tooLargeSource.provenance.sources = [{ path: "src/large.ts", sha256: "b".repeat(64), bytes: 2 * 1024 * 1024 + 1 }];
    await rewriteProvenance(tooLargeSource);
    await assert.rejects(captureFallbackSettingsNativeSources(tooLargeSource.root));
  } finally { await tooLargeSource.dispose(); }

  const aggregateSources = await fixture();
  try {
    aggregateSources.provenance.sources = Array.from({ length: 9 }, (_, index) => ({
      path: `src/large-${index}.ts`, sha256: "c".repeat(64), bytes: 2 * 1024 * 1024,
    }));
    await rewriteProvenance(aggregateSources);
    await assert.rejects(captureFallbackSettingsNativeSources(aggregateSources.root));
  } finally { await aggregateSources.dispose(); }
});

test("source or resource drift after preflight invalidates the snapshot", async () => {
  const item = await fixture();
  try {
    const snapshot = await captureFallbackSettingsNativeSources(item.root);
    await writeFile(join(item.distRoot, "index.html"), "changed after preflight\n");
    await assert.rejects(assertFallbackSettingsNativeSourcesUnchanged(snapshot));
  } finally {
    await item.dispose();
  }
});
