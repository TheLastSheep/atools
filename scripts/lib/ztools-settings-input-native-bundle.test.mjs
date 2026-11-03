import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cleanupOwnedRendererApp } from "./ztools-renderer-native-runtime.mjs";
import { captureSettingsNativeSources } from "./ztools-settings-native-sources.mjs";
import { captureFallbackSettingsNativeSources } from "./fallback-settings-native-sources.mjs";
import { captureHostBridgeSources } from "../../packages/ztools-settings/src/host-bridge-build.mjs";
import {
  settingsInputBundleIdentifier,
  settingsInputInfoPlist,
  stageSettingsInputNativeBundle,
} from "./ztools-settings-input-native-bundle.mjs";
import { TIMESTAMP_BUILTIN_SOURCE_FILES } from "./ztools-settings-input-builtin-control.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const sourceCommit = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const resourceFiles = [
  ["index.html", Buffer.from("<!doctype html><html></html>")],
  ["assets/app.js", Buffer.from("globalThis.settingsReady = true;")],
  ["assets/app.css", Buffer.from("body { color: black; }")],
];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function timestampSourceHashes() {
  return Object.fromEntries(await Promise.all(TIMESTAMP_BUILTIN_SOURCE_FILES.map(async path => [
    path, hash(await readFile(join(repositoryRoot, path))),
  ])));
}

async function fallbackSettingsFixture(item) {
  const sourcePaths = [
    ["package.json", Buffer.from("{}\n")],
    ["pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\n")],
    ["scripts/build-fallback-settings-native.mjs", Buffer.from("export const source = true\n")],
    ["svelte.config.js", Buffer.from("export default {};\n")],
    ["tests/components/fallback-settings-native.html", Buffer.from("<div id=app></div>\n")],
    ["tests/components/fallbackSettingsNativeFixture.ts", Buffer.from("export const settings = true\n")],
    ["tests/components/fallbackSettingsNativeReadiness.ts", Buffer.from("export const wait = true\n")],
    ["tsconfig.json", Buffer.from("{}\n")],
    ["vite.config.ts", Buffer.from("export default {};\n")],
  ];
  for (const [path, bytes] of sourcePaths) {
    const target = join(item.root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, bytes);
  }
  const resources = [
    ["assets/settings.js", Buffer.from("globalThis.settingsReady = true\n")],
    ["index.html", Buffer.from("<!doctype html><main id=app></main>\n")],
  ].map(([path, bytes]) => ({ path, sha256: hash(bytes), bytes: bytes.byteLength }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const sources = sourcePaths.map(([path, bytes]) => ({ path, sha256: hash(bytes), bytes: bytes.byteLength }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const provenance = {
    schemaVersion: 1,
    owner: "@atools/fallback-settings-native-fixture",
    sources,
    sourceSha256: hash(Buffer.from(JSON.stringify(sources))),
    resources,
    resourceSha256: hash(Buffer.from(JSON.stringify(resources))),
    resourceBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
    resourceCount: resources.length,
  };
  const dist = join(item.root, "output/fallback-settings-native-dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><main id=app></main>\n");
  await writeFile(join(dist, "assets/settings.js"), "globalThis.settingsReady = true\n");
  await writeFile(join(dist, "build-provenance.json"), JSON.stringify(provenance));
  return captureFallbackSettingsNativeSources(item.root);
}

async function settingsFixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "settings-input-native-bundle-test-"));
  const root = await realpath(temporaryRoot);
  const packageRoot = join(root, "packages/ztools-settings");
  const sourceRoot = join(packageRoot, "src");
  const distRoot = join(packageRoot, "dist");
  await mkdir(join(sourceRoot, "compatibility-patches"), { recursive: true });
  await mkdir(join(distRoot, "assets"), { recursive: true });
  for (const [path, contents] of [
    ["package.json", "{}\n"], ["package-lock.json", "{}\n"],
    ["build.mjs", "// synthetic build input\n"],
  ]) await writeFile(join(packageRoot, path), contents);
  const sourceManifest = {
    source: { commit: sourceCommit },
    build: {
      budgetMilestone: "original-vue-main-hotkey-2026-10-29",
      emittedResourceBudget: {
        metric: "uncompressed_emitted_resources_bytes",
        baselineBytes: 784_315,
        maxIncreaseBytes: 2_048,
        maxBytes: 786_432,
      },
    },
  };
  const sourceManifestJson = JSON.stringify(sourceManifest);
  await writeFile(join(packageRoot, "source-manifest.json"), sourceManifestJson);
  await writeFile(join(sourceRoot, "hostBridgeEntry.ts"), "export const bridgeReady = true\n");
  await writeFile(join(sourceRoot, "childBridge.ts"), "export const child = true\n");
  await writeFile(join(sourceRoot, "compatibility-patches/patch.mjs"), "export const patch = true\n");

  const emittedResources = [];
  let totalBytes = 0;
  for (const [path, bytes] of resourceFiles) {
    await writeFile(join(distRoot, path), bytes);
    emittedResources.push({ path, bytes: bytes.byteLength, sha256: hash(bytes) });
    totalBytes += bytes.byteLength;
  }
  const hostSources = await captureHostBridgeSources(root);
  const bridgePath = hostSources.files.find(file => file.path.endsWith("/hostBridgeEntry.ts")).path;
  const provenance = {
    schemaVersion: 1, artifactOwner: "@atools/ztools-settings-source-build",
    status: "strict/typecheck-passed", typecheckPassed: true,
    source: { commit: sourceCommit, workingTreeClean: true },
    build: {
      typecheckPassed: true, bridgeEntry: { path: bridgePath },
      hostBridgeSources: {
        root: hostSources.rootPath, count: hostSources.count, bytes: hostSources.bytes,
        sha256: hostSources.sha256,
        files: hostSources.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
        runtimeImports: [bridgePath],
      },
    },
    bundleBudget: {
      metric: "uncompressed_emitted_resources_bytes", actualBytes: totalBytes,
      baselineBytes: 784_315, maxIncreaseBytes: 2_048, maxBytes: 786_432,
      increaseBytes: totalBytes - 784_315, passed: true,
    },
    emittedResources, emittedResourceCount: emittedResources.length, emittedResourceTotalBytes: totalBytes,
  };
  await writeFile(join(distRoot, "build-provenance.json"), JSON.stringify(provenance));
  await writeFile(join(distRoot, "ZTools-LICENSE"), "license\n");
  await writeFile(join(distRoot, "upstream-package.json"), "{}\n");
  await writeFile(join(distRoot, "source-manifest.json"), sourceManifestJson);
  return { root, dispose: () => rm(temporaryRoot, { recursive: true, force: true }) };
}

test("settings-input plist uses the isolated profile bundle identifier", () => {
  const identifier = settingsInputBundleIdentifier(runId);
  const infoPlist = settingsInputInfoPlist(runId);
  assert.equal(identifier, `dev.atools.renderer-settings-input.${runId}`);
  assert.match(infoPlist, new RegExp(`<key>CFBundleIdentifier</key><string>${identifier}</string>`));
  assert.match(infoPlist, /<key>LSUIElement<\/key><false\/>/);
  assert.throws(() => settingsInputBundleIdentifier("../invalid"));
});

test("stages a strict Settings-source fixture and executable into a private exact-id app bundle", async () => {
  const workspaceRunId = randomUUID().replaceAll("-", "");
  const item = await settingsFixture();
  const runDirectory = join(item.root, `run-${workspaceRunId}`);
  let staged = null;
  try {
    await mkdir(runDirectory, { mode: 0o700 });
    const binary = join(runDirectory, "fake-renderer");
    const binaryBytes = Buffer.from("bounded native staging fixture\n");
    await writeFile(binary, binaryBytes, { flag: "wx", mode: 0o700 });
    await chmod(binary, 0o700);
    const settingsSourceSnapshot = await captureSettingsNativeSources(item.root);
    const nativeSourceHashes = await timestampSourceHashes();
    staged = await stageSettingsInputNativeBundle({
      binaryFingerprint: { path: binary, sha256: createHash("sha256").update(binaryBytes).digest("hex") },
      runDirectory, runId, settingsSourceSnapshot, nativeSourceHashes,
    });

    assert.equal(staged.identifier, settingsInputBundleIdentifier(runId));
    assert.equal(staged.infoPlistIdentifier, staged.identifier);
    assert.equal(staged.stagedSha256, staged.sourceSha256);
    assert.equal(staged.settingsBundle.staged, true);
    assert.equal(staged.fallbackSettingsBundle, null);
    assert.equal(staged.builtinControl.resourcePath, "Contents/Resources/plugins/builtin/timestamp");
    assert.equal(staged.builtinControl.fileCount, 3);
    assert.deepEqual(staged.builtinControl.files.map(file => file.path), ["index.html", "logo.svg", "plugin.json"]);
    assert.equal(staged.settingsBundle.distSha256, settingsSourceSnapshot.bundle.sha256);
    assert.equal(staged.settingsBundle.resourceBytes, settingsSourceSnapshot.bundle.resourceBytes);
    const info = await lstat(join(staged.bundlePath, "Contents/Info.plist"));
    const executable = await lstat(staged.executable);
    const resourceRoot = join(staged.bundlePath, "Contents/Resources/ztools-settings");
    const resourceInfo = await lstat(join(resourceRoot, "index.html"));
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(executable.mode & 0o777, 0o700);
    assert.equal(resourceInfo.mode & 0o777, 0o600);
    assert.match(await readFile(join(staged.bundlePath, "Contents/Info.plist"), "utf8"),
      new RegExp(`<key>CFBundleIdentifier</key><string>${staged.identifier}</string>`));
    assert.equal(await readFile(join(resourceRoot, "source-manifest.json"), "utf8"),
      await readFile(join(settingsSourceSnapshot.distRoot, "source-manifest.json"), "utf8"));
    for (const file of staged.builtinControl.files) {
      const path = join(staged.bundlePath, "Contents/Resources/plugins/builtin/timestamp", file.path);
      const info = await lstat(path);
      const bytes = await readFile(path);
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal(info.nlink, 1);
      assert.equal(bytes.byteLength, file.bytes);
      assert.equal(hash(bytes), file.sha256);
      assert.equal(file.sha256, nativeSourceHashes[`resources/plugins/builtin/timestamp/${file.path}`]);
    }
  } finally {
    if (staged) await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath, runDirectory, ownerIdentity: staged.ownerIdentity, processTerminal: true,
    });
    await item.dispose();
  }
});

test("stages the fallback Settings QA namespace only when an independently verified snapshot is supplied", async () => {
  const workspaceRunId = randomUUID().replaceAll("-", "");
  const item = await settingsFixture();
  const runDirectory = join(item.root, `run-${workspaceRunId}`);
  let staged = null;
  try {
    await mkdir(runDirectory, { mode: 0o700 });
    const binary = join(runDirectory, "fake-renderer");
    const binaryBytes = Buffer.from("fallback staging binary\n");
    await writeFile(binary, binaryBytes, { flag: "wx", mode: 0o700 });
    await chmod(binary, 0o700);
    const settingsSourceSnapshot = await captureSettingsNativeSources(item.root);
    const fallbackSourceSnapshot = await fallbackSettingsFixture(item);
    staged = await stageSettingsInputNativeBundle({
      binaryFingerprint: { path: binary, sha256: hash(binaryBytes) },
      runDirectory,
      runId: workspaceRunId,
      settingsSourceSnapshot,
      nativeSourceHashes: await timestampSourceHashes(),
      fallbackSourceSnapshot,
    });
    assert.equal(staged.fallbackSettingsBundle.staged, true);
    assert.equal(staged.fallbackSettingsBundle.resourcePath, "Contents/Resources/atools-fallback-settings-qa");
    assert.equal(staged.fallbackSettingsBundle.resourceCount, 2);
    assert.equal(await readFile(join(staged.bundlePath,
      "Contents/Resources/atools-fallback-settings-qa/index.html"), "utf8"),
    "<!doctype html><main id=app></main>\n");
  } finally {
    if (staged) await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath, runDirectory, ownerIdentity: staged.ownerIdentity, processTerminal: true,
    });
    await item.dispose();
  }
});

test("refuses a source binary whose fingerprint changed before app staging", async () => {
  const workspaceRunId = randomUUID().replaceAll("-", "");
  const item = await settingsFixture();
  const runDirectory = join(item.root, `run-${workspaceRunId}`);
  try {
    await mkdir(runDirectory, { mode: 0o700 });
    const binary = join(runDirectory, "fake-renderer");
    await writeFile(binary, "changed binary", { flag: "wx", mode: 0o700 });
    const settingsSourceSnapshot = await captureSettingsNativeSources(item.root);
    const nativeSourceHashes = await timestampSourceHashes();
    await assert.rejects(stageSettingsInputNativeBundle({
      binaryFingerprint: { path: binary, sha256: "0".repeat(64) },
      runDirectory, runId, settingsSourceSnapshot, nativeSourceHashes,
    }), /fingerprint changed/);
    await assert.rejects(lstat(join(runDirectory, "case-never.app")), { code: "ENOENT" });
  } finally {
    await item.dispose();
  }
});

test("cleans the owned app bundle if child resource staging fails after timestamp copy", async () => {
  const workspaceRunId = randomUUID().replaceAll("-", "");
  const item = await settingsFixture();
  const runDirectory = join(item.root, `run-${workspaceRunId}`);
  try {
    await mkdir(runDirectory, { mode: 0o700 });
    const binary = join(runDirectory, "fake-renderer");
    const binaryBytes = Buffer.from("bounded native staging fixture\n");
    await writeFile(binary, binaryBytes, { flag: "wx", mode: 0o700 });
    await chmod(binary, 0o700);
    const settingsSourceSnapshot = await captureSettingsNativeSources(item.root);
    settingsSourceSnapshot.bundle.sha256 = "0".repeat(64);
    await assert.rejects(stageSettingsInputNativeBundle({
      binaryFingerprint: { path: binary, sha256: hash(binaryBytes) },
      runDirectory, runId: workspaceRunId, settingsSourceSnapshot,
      nativeSourceHashes: await timestampSourceHashes(),
    }), /Settings source or dist changed/);
    await assert.rejects(lstat(join(runDirectory, "case-never.app")), { code: "ENOENT" });
  } finally {
    await item.dispose();
  }
});
