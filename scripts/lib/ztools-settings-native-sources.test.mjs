import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupOwnedRendererApp, stageRendererNativeApp } from "./ztools-renderer-native-runtime.mjs";
import { captureHostBridgeSources } from "../../packages/ztools-settings/src/host-bridge-build.mjs";
import {
  assertSettingsNativeSourcesUnchanged,
  captureSettingsNativeSources,
  settingsNativeSourcesEqual,
  stageSettingsNativeBundle,
  summarizeSettingsNativeSources,
} from "./ztools-settings-native-sources.mjs";

const sourceCommit = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const owner = "@atools/ztools-settings-source-build";
const LEGACY_BUDGET = {
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 771_693,
  maxIncreaseBytes: 8_192,
  maxBytes: 786_432,
};
const DISABLED_COMMANDS_BUDGET_MILESTONE = "original-vue-disabled-command-cas-2026-10-28";
const DISABLED_COMMANDS_BUDGET = {
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 779_464,
  maxIncreaseBytes: 4_096,
  maxBytes: 786_432,
};
const TRAY_VISIBILITY_BUDGET_MILESTONE = "original-vue-tray-visibility-2026-10-29";
const TRAY_VISIBILITY_BUDGET = {
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 783_356,
  maxIncreaseBytes: 1_024,
  maxBytes: 786_432,
};
const MAIN_HOTKEY_BUDGET_MILESTONE = "original-vue-main-hotkey-2026-10-29";
const MAIN_HOTKEY_BUDGET = {
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 784_315,
  maxIncreaseBytes: 2_048,
  maxBytes: 786_432,
};
const BUDGETS_BY_MILESTONE = new Map([
  [DISABLED_COMMANDS_BUDGET_MILESTONE, DISABLED_COMMANDS_BUDGET],
  [TRAY_VISIBILITY_BUDGET_MILESTONE, TRAY_VISIBILITY_BUDGET],
  [MAIN_HOTKEY_BUDGET_MILESTONE, MAIN_HOTKEY_BUDGET],
]);
const resourceBytes = [
  ["index.html", Buffer.from("<!doctype html><html></html>")],
  ["assets/app.js", Buffer.from("globalThis.settingsReady = true;")],
  ["assets/app.css", Buffer.from("body { color: black; }")],
];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture({ resourceTotalBytes = null, budgetMilestone = MAIN_HOTKEY_BUDGET_MILESTONE } = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "settings-native-source-test-"));
  const root = await realpath(temporaryRoot);
  const packageRoot = join(root, "packages/ztools-settings");
  const src = join(packageRoot, "src");
  const dist = join(packageRoot, "dist");
  await mkdir(join(src, "compatibility-patches"), { recursive: true });
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), "{}\n");
  await writeFile(join(packageRoot, "package-lock.json"), "{}\n");
  await writeFile(join(packageRoot, "source-manifest.json"), "{}\n");
  await writeFile(join(packageRoot, "build.mjs"), "// synthetic build input\n");
  await writeFile(join(src, "hostBridgeEntry.ts"), "export const bridgeReady = true\n");
  await writeFile(join(src, "childBridge.ts"), "export const child = true\n");
  await writeFile(join(src, "compatibility-patches/patch.mjs"), "export const patch = true\n");
  const fixtureResources = resourceBytes.map(([path, bytes]) => [path, Buffer.from(bytes)]);
  if (resourceTotalBytes !== null) {
    const currentTotal = fixtureResources.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
    if (!Number.isSafeInteger(resourceTotalBytes) || resourceTotalBytes < currentTotal) {
      throw new Error("Synthetic resource total must be a safe increase from its fixture");
    }
    fixtureResources[1][1] = Buffer.concat([
      fixtureResources[1][1],
      Buffer.alloc(resourceTotalBytes - currentTotal),
    ]);
  }
  const emittedResources = [];
  let totalBytes = 0;
  for (const [path, bytes] of fixtureResources) {
    await writeFile(join(dist, path), bytes);
    emittedResources.push({ path, bytes: bytes.byteLength, sha256: hash(bytes) });
    totalBytes += bytes.byteLength;
  }
  const hostSources = await captureHostBridgeSources(root);
  const bridgePath = hostSources.files.find(file => file.path.endsWith("/hostBridgeEntry.ts")).path;
  const budget = budgetMilestone === null
    ? LEGACY_BUDGET
    : BUDGETS_BY_MILESTONE.get(budgetMilestone) ?? MAIN_HOTKEY_BUDGET;
  const sourceManifest = {
    source: { commit: sourceCommit },
    build: {
      ...(budgetMilestone === null ? {} : { budgetMilestone }),
      emittedResourceBudget: budget,
    },
  };
  const provenance = {
    schemaVersion: 1,
    artifactOwner: owner,
    status: "strict/typecheck-passed",
    typecheckPassed: true,
    source: { commit: sourceCommit, workingTreeClean: true },
    build: {
      typecheckPassed: true,
      bridgeEntry: { path: bridgePath },
      hostBridgeSources: {
        root: hostSources.rootPath,
        count: hostSources.count,
        bytes: hostSources.bytes,
        sha256: hostSources.sha256,
        files: hostSources.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
        runtimeImports: [bridgePath],
      },
    },
    bundleBudget: {
      metric: budget.metric,
      actualBytes: totalBytes,
      baselineBytes: budget.baselineBytes,
      maxIncreaseBytes: budget.maxIncreaseBytes,
      maxBytes: budget.maxBytes,
      increaseBytes: totalBytes - budget.baselineBytes,
      passed: true,
    },
    emittedResources,
    emittedResourceCount: emittedResources.length,
    emittedResourceTotalBytes: totalBytes,
  };
  await writeFile(join(dist, "build-provenance.json"), JSON.stringify(provenance));
  await writeFile(join(dist, "ZTools-LICENSE"), "license\n");
  await writeFile(join(dist, "upstream-package.json"), "{}\n");
  await writeFile(join(dist, "source-manifest.json"), JSON.stringify(sourceManifest));
  return {
    root, packageRoot, src, dist, provenance, sourceManifest, resourceBytes: fixtureResources,
    dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

async function rewriteProvenance(testFixture, mutate) {
  const value = structuredClone(testFixture.provenance);
  mutate(value);
  await writeFile(join(testFixture.dist, "build-provenance.json"), JSON.stringify(value));
  testFixture.provenance = value;
}

async function rewriteSourceManifest(testFixture, mutate) {
  const value = structuredClone(testFixture.sourceManifest);
  mutate(value);
  await writeFile(join(testFixture.dist, "source-manifest.json"), JSON.stringify(value));
  testFixture.sourceManifest = value;
}

test("synthetic strict settings source binds all TypeScript, build inputs, and dist resources", async t => {
  const item = await fixture();
  t.after(item.dispose);
  const snapshot = await captureSettingsNativeSources(item.root);
  const summary = summarizeSettingsNativeSources(snapshot);
  assert.equal(summary.resourceCount, 3);
  assert.equal(summary.resourceBytes, snapshot.bundle.resourceBytes);
  assert.ok(snapshot.packageFiles.some(file => file.path.endsWith("/package-lock.json")));
  assert.ok(snapshot.packageFiles.some(file => file.path.endsWith("/build.mjs")));
  assert.ok(snapshot.packageFiles.some(file => file.path.endsWith("/compatibility-patches/patch.mjs")));
  assert.equal(JSON.stringify(summary).includes("bridgeReady"), false);
  assert.equal(JSON.stringify(summary).includes("license\n"), false);
  await assertSettingsNativeSourcesUnchanged(snapshot);
  await assert.rejects(captureSettingsNativeSources(item.root, { settingsDist: join(item.root, "untrusted-ui-dist") }), /fixed package dist directory/);

  const appBundle = join(item.root, "case.app");
  await mkdir(join(appBundle, "Contents/Resources"), { recursive: true, mode: 0o700 });
  const staged = await stageSettingsNativeBundle({ snapshot, appBundlePath: appBundle });
  assert.equal(staged.resourcePath, "Contents/Resources/ztools-settings");
  assert.equal(staged.resourceCount, 3);
  assert.equal(staged.distSha256, snapshot.bundle.sha256);
  assert.deepEqual(await readFile(join(appBundle, "Contents/Resources/ztools-settings/index.html")), item.resourceBytes[0][1]);
  assert.equal(await readFile(join(appBundle, "Contents/Resources/ztools-settings/ZTools-LICENSE"), "utf8"), "license\n");
  const stagedProvenance = await readFile(join(appBundle, "Contents/Resources/ztools-settings/build-provenance.json"));
  assert.equal(hash(stagedProvenance), snapshot.bundle.files.find(file => file.path === "build-provenance.json").sha256);
  for (const metadata of ["upstream-package.json", "source-manifest.json"]) {
    const source = await readFile(join(item.dist, metadata));
    const stagedFile = await readFile(join(appBundle, "Contents/Resources/ztools-settings", metadata));
    assert.deepEqual(stagedFile, source);
  }
});

test("native settings app staging embeds the complete verified package bundle", async t => {
  const item = await fixture();
  t.after(item.dispose);
  const snapshot = await captureSettingsNativeSources(item.root);
  const runDirectory = join(item.root, "run");
  await mkdir(runDirectory, { mode: 0o700 });
  const binary = join(item.root, "native-binary");
  const binaryBytes = Buffer.from("synthetic native executable");
  await writeFile(binary, binaryBytes, { mode: 0o755 });
  const staged = await stageRendererNativeApp({
    binary, runDirectory, autoClear: "never", runId: "0123456789abcdef0123456789abcdef",
    expectedSha256: hash(binaryBytes), mode: "settings", settingsSourceSnapshot: snapshot,
  });
  assert.equal(staged.mode, "settings");
  assert.equal(staged.probeResource, null);
  assert.equal(staged.settingsBundle.resourceCount, 3);
  assert.equal(staged.settingsBundle.resourceBytes, snapshot.bundle.resourceBytes);
  assert.equal(
    await readFile(join(staged.bundlePath, staged.settingsBundle.resourcePath, "source-manifest.json"), "utf8"),
    JSON.stringify(item.sourceManifest),
  );
  const cleanup = await cleanupOwnedRendererApp({
    bundlePath: staged.bundlePath, runDirectory, ownerIdentity: staged.ownerIdentity, processTerminal: true,
  });
  assert.equal(cleanup.bundleAbsent, true);
});

test("strict provenance rejects review owner, failed typecheck, dirty or wrong source", async t => {
  const mutations = [
    value => { value.artifactOwner = "@atools/ztools-settings-review-bundle"; },
    value => { value.status = "review-only/typecheck-passed"; },
    value => { value.typecheckPassed = false; },
    value => { value.build.typecheckPassed = false; },
    value => { value.source.commit = "another-commit"; },
    value => { value.source.workingTreeClean = false; },
  ];
  for (const mutate of mutations) {
    const item = await fixture();
    t.after(item.dispose);
    await rewriteProvenance(item, mutate);
    await assert.rejects(captureSettingsNativeSources(item.root), /pinned strict typechecked source build/);
  }
});

test("resource inventory, budget, hashes, size, and complete directory set fail closed", async t => {
  const mutations = [
    value => { value.emittedResources[0].sha256 = "0".repeat(64); },
    value => { value.emittedResources[0].bytes += 1; },
    value => { value.emittedResourceCount += 1; },
    value => { value.emittedResourceTotalBytes += 1; },
    value => { value.bundleBudget.passed = false; },
    value => { value.emittedResources[1].path = "../escape.js"; },
    value => { value.emittedResources[1].path = "/absolute.js"; },
    value => { value.emittedResources[1].path = "assets//empty.js"; },
    value => { value.emittedResources[1].path = "assets/./dot.js"; },
    value => { value.emittedResources[1].path = "assets/back\\slash.js"; },
    value => { value.emittedResources[1].path = "assets/hash#.js"; },
    value => { value.emittedResources[1].path = "assets/query?.js"; },
    value => { value.emittedResources[1].path = "assets/percent%.js"; },
    value => { value.emittedResources[1].path = "index.html"; },
  ];
  for (const mutate of mutations) {
    const item = await fixture();
    t.after(item.dispose);
    await rewriteProvenance(item, mutate);
    await assert.rejects(captureSettingsNativeSources(item.root));
  }

  const extra = await fixture();
  t.after(extra.dispose);
  await writeFile(join(extra.dist, "assets/extra.mjs"), "globalThis.unlisted = true");
  await assert.rejects(captureSettingsNativeSources(extra.root), /exactly match/);

  const missingMetadata = await fixture();
  t.after(missingMetadata.dispose);
  await unlink(join(missingMetadata.dist, "ZTools-LICENSE"));
  await assert.rejects(captureSettingsNativeSources(missingMetadata.root), /exactly match/);
});

test("Native source guard accepts all four frozen settings budget milestones", async t => {
  const currentLegal = await fixture({ resourceTotalBytes: 784_315 });
  t.after(currentLegal.dispose);
  const legalSnapshot = await captureSettingsNativeSources(currentLegal.root);
  assert.equal(legalSnapshot.bundle.resourceBytes, 784_315);
  assert.equal(currentLegal.provenance.bundleBudget.baselineBytes, 784_315);
  assert.equal(currentLegal.provenance.bundleBudget.maxIncreaseBytes, 2_048);

  const mainHotkeyMeasured = await fixture({ resourceTotalBytes: 786_127 });
  t.after(mainHotkeyMeasured.dispose);
  assert.equal((await captureSettingsNativeSources(mainHotkeyMeasured.root)).bundle.resourceBytes, 786_127);

  const mainHotkeyBoundary = await fixture({ resourceTotalBytes: 786_363 });
  t.after(mainHotkeyBoundary.dispose);
  assert.equal((await captureSettingsNativeSources(mainHotkeyBoundary.root)).bundle.resourceBytes, 786_363);

  const mainHotkeyOver = await fixture({ resourceTotalBytes: 786_364 });
  t.after(mainHotkeyOver.dispose);
  await assert.rejects(captureSettingsNativeSources(mainHotkeyOver.root), /exceed the fixed byte budget/);

  const trayBoundary = await fixture({
    resourceTotalBytes: 784_380,
    budgetMilestone: TRAY_VISIBILITY_BUDGET_MILESTONE,
  });
  t.after(trayBoundary.dispose);
  assert.equal((await captureSettingsNativeSources(trayBoundary.root)).bundle.resourceBytes, 784_380);

  const disabledCommandsBoundary = await fixture({
    resourceTotalBytes: 783_560,
    budgetMilestone: DISABLED_COMMANDS_BUDGET_MILESTONE,
  });
  t.after(disabledCommandsBoundary.dispose);
  assert.equal(
    (await captureSettingsNativeSources(disabledCommandsBoundary.root)).bundle.resourceBytes,
    783_560,
  );

  const legacyBoundary = await fixture({
    resourceTotalBytes: LEGACY_BUDGET.baselineBytes + LEGACY_BUDGET.maxIncreaseBytes,
    budgetMilestone: null,
  });
  t.after(legacyBoundary.dispose);
  assert.equal(
    (await captureSettingsNativeSources(legacyBoundary.root)).bundle.resourceBytes,
    779_885,
  );

  const unknownMilestone = await fixture({ budgetMilestone: "settings-future-unreviewed" });
  t.after(unknownMilestone.dispose);
  await assert.rejects(
    captureSettingsNativeSources(unknownMilestone.root),
    /unknown resource budget milestone/,
  );

  for (const budgetMilestone of [
    MAIN_HOTKEY_BUDGET_MILESTONE,
    TRAY_VISIBILITY_BUDGET_MILESTONE,
    DISABLED_COMMANDS_BUDGET_MILESTONE,
    null,
  ]) {
    for (const mutate of [
      value => { value.build.emittedResourceBudget.metric = "gzip_bytes"; },
      value => { value.build.emittedResourceBudget.baselineBytes += 1; },
      value => { value.build.emittedResourceBudget.maxIncreaseBytes += 1; },
      value => { value.build.emittedResourceBudget.maxBytes += 1; },
      value => { value.build.emittedResourceBudget.unreviewed = true; },
    ]) {
      const forged = await fixture({ budgetMilestone });
      t.after(forged.dispose);
      await rewriteSourceManifest(forged, mutate);
      await assert.rejects(
        captureSettingsNativeSources(forged.root),
        /resource budget is not frozen|differs from its frozen milestone/,
      );
    }
  }

  const obsoleteBaseline = await fixture();
  t.after(obsoleteBaseline.dispose);
  await rewriteProvenance(obsoleteBaseline, value => {
    value.bundleBudget.baselineBytes = 749_106;
    value.bundleBudget.increaseBytes = value.bundleBudget.actualBytes - 749_106;
  });
  await assert.rejects(captureSettingsNativeSources(obsoleteBaseline.root), /budget metadata/);

  const obsoleteIncrease = await fixture();
  t.after(obsoleteIncrease.dispose);
  await rewriteProvenance(obsoleteIncrease, value => {
    value.bundleBudget.maxIncreaseBytes = 16_384;
  });
  await assert.rejects(captureSettingsNativeSources(obsoleteIncrease.root), /budget metadata/);

  const mismatchedActual = await fixture();
  t.after(mismatchedActual.dispose);
  await rewriteProvenance(mismatchedActual, value => {
    value.bundleBudget.actualBytes += 1;
  });
  await assert.rejects(captureSettingsNativeSources(mismatchedActual.root), /budget metadata/);

  const passedButOverLimit = await fixture({
    resourceTotalBytes: 784_381,
    budgetMilestone: TRAY_VISIBILITY_BUDGET_MILESTONE,
  });
  t.after(passedButOverLimit.dispose);
  assert.equal(passedButOverLimit.provenance.bundleBudget.passed, true);
  assert.equal(passedButOverLimit.provenance.bundleBudget.actualBytes, 784_381);
  await assert.rejects(
    captureSettingsNativeSources(passedButOverLimit.root),
    /emitted resources exceed the fixed byte budget/,
  );
});

test("source and dist changes after preflight fail closed", async t => {
  const item = await fixture();
  t.after(item.dispose);
  const snapshot = await captureSettingsNativeSources(item.root);
  await writeFile(join(item.src, "childBridge.ts"), "export const changed = true\n");
  await assert.rejects(assertSettingsNativeSourcesUnchanged(snapshot), /changed during native acceptance/);

  const newSnapshot = await captureSettingsNativeSources(item.root).catch(() => null);
  assert.equal(newSnapshot, null, "provenance must still bind all current TypeScript source files");

  const other = await fixture();
  t.after(other.dispose);
  const distSnapshot = await captureSettingsNativeSources(other.root);
  await writeFile(join(other.dist, "assets/app.js"), "changed bytes on disk");
  await assert.rejects(assertSettingsNativeSourcesUnchanged(distSnapshot));
  assert.equal(settingsNativeSourcesEqual(distSnapshot, await captureSettingsNativeSources(other.root).catch(() => null)), false);

  const packageInput = await fixture();
  t.after(packageInput.dispose);
  const packageSnapshot = await captureSettingsNativeSources(packageInput.root);
  await writeFile(join(packageInput.packageRoot, "package-lock.json"), "changed package input\n");
  await assert.rejects(assertSettingsNativeSourcesUnchanged(packageSnapshot));
});

test("dist symlinks are rejected and staging never follows them", async t => {
  if (process.platform === "win32") return t.skip("filesystem symlink creation is not available in this environment");
  const item = await fixture();
  t.after(item.dispose);
  const outside = join(item.root, "outside.js");
  await writeFile(outside, "outside");
  await symlink(outside, join(item.dist, "assets/linked.js"));
  await assert.rejects(captureSettingsNativeSources(item.root), /symlinks are not allowed|symbolic link/);

  const sourceLink = await fixture();
  t.after(sourceLink.dispose);
  const externalTypeScript = join(sourceLink.root, "outside.ts");
  await writeFile(externalTypeScript, "export const external = true\n");
  await symlink(externalTypeScript, join(sourceLink.src, "unlisted.ts"));
  await assert.rejects(captureSettingsNativeSources(sourceLink.root), /symlinks are not allowed|symbolic link/);
});

test("provenance rejects host bridge runtime imports outside the captured TypeScript closure", async t => {
  const item = await fixture();
  t.after(item.dispose);
  await rewriteProvenance(item, value => {
    value.build.hostBridgeSources.runtimeImports = ["/tmp/external-host-bridge.ts"];
  });
  await assert.rejects(captureSettingsNativeSources(item.root), /unlisted host bridge runtime import/);
});

