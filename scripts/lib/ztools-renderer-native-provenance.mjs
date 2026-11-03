import assert from "node:assert/strict";
import { RENDERER_COMPATIBILITY_PATCHES } from "../../packages/ztools-renderer/upstream-compatibility-patches.mjs";

const PINNED_ZTOOLS_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const SETTINGS_RESOURCE_MILESTONES = new Set([
  "original-vue-tray-visibility-2026-10-29",
  "original-vue-main-hotkey-2026-10-29",
  "original-vue-local-launch-settings-2026-10-29",
  "original-vue-native-local-drop-2026-10-29",
]);
export function rendererCompatibilityPatchesForMilestone(milestone) {
  return RENDERER_COMPATIBILITY_PATCHES.map(patch =>
    milestone !== "original-vue-main-about-update-2026-11-02" && patch.path === "src/renderer/src/stores/windowStore.ts"
      ? { ...patch, id: "builtin-shortcuts-live-and-startup-generation", afterSha256: "f402deff8ae1389f2f77486c8445807f9faa714b5262ae75147e12e4887bda80" }
      : { ...patch });
}

const FIXED_BUDGETS = Object.freeze({
  "original-vue-main-about-update-2026-11-02": Object.freeze({
    totalJavaScriptBudgetBytes: 614004, previousTotalJavaScriptBytes: 611758, maxIncrementalJavaScriptBytes: 2246,
  }),
  "original-vue-settings-input-2026-10-27": Object.freeze({
    totalJavaScriptBudgetBytes: 589824,
    previousTotalJavaScriptBytes: 587945,
    maxIncrementalJavaScriptBytes: 1879,
  }),
  "original-vue-disabled-command-cas-2026-10-28": Object.freeze({
    totalJavaScriptBudgetBytes: 590848,
    previousTotalJavaScriptBytes: 589758,
    maxIncrementalJavaScriptBytes: 1024,
  }),
  "original-vue-local-app-search-2026-10-28": Object.freeze({
    totalJavaScriptBudgetBytes: 593920,
    previousTotalJavaScriptBytes: 590200,
    maxIncrementalJavaScriptBytes: 3072,
  }),
  "original-vue-plugin-inventory-2026-10-28": Object.freeze({
    totalJavaScriptBudgetBytes: 593920,
    previousTotalJavaScriptBytes: 592149,
    maxIncrementalJavaScriptBytes: 2048,
  }),
  "original-vue-recommendation-pins-2026-10-29": Object.freeze({
    totalJavaScriptBudgetBytes: 599031,
    previousTotalJavaScriptBytes: 593911,
    maxIncrementalJavaScriptBytes: 5120,
  }),
  "original-vue-local-shortcuts-2026-10-29": Object.freeze({
    totalJavaScriptBudgetBytes: 603092,
    previousTotalJavaScriptBytes: 598996,
    maxIncrementalJavaScriptBytes: 4096,
  }),
  "original-vue-main-updater-2026-11-02": Object.freeze({
    totalJavaScriptBudgetBytes: 614004,
    previousTotalJavaScriptBytes: 609908,
    maxIncrementalJavaScriptBytes: 4096,
  }),
  "original-vue-main-file-drop-2026-11-02": Object.freeze({
    totalJavaScriptBudgetBytes: 610666,
    previousTotalJavaScriptBytes: 604522,
    maxIncrementalJavaScriptBytes: 6144,
  }),
  "original-vue-builtin-shortcuts-main-2026-10-29": Object.freeze({
    totalJavaScriptBudgetBytes: 606381,
    previousTotalJavaScriptBytes: 603309,
    maxIncrementalJavaScriptBytes: 3072,
  }),
  "original-vue-local-launch-main-2026-10-29": Object.freeze({
    totalJavaScriptBudgetBytes: 604116,
    previousTotalJavaScriptBytes: 598996,
    maxIncrementalJavaScriptBytes: 5120,
  }),
});
const COMPATIBILITY_PATCH_MILESTONES = new Set([
  "original-vue-main-about-update-2026-11-02",
  "original-vue-main-updater-2026-11-02",
  "original-vue-main-file-drop-2026-11-02",
  "original-vue-builtin-shortcuts-main-2026-10-29",
  "original-vue-local-shortcuts-2026-10-29",
  "original-vue-local-launch-main-2026-10-29",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Validate the pinned upstream identity and its measured renderer artifact. */
export function validateRendererNativeProvenance(manifest, provenance, upstream, actualJavaScriptBytes) {
  assert.ok(isRecord(manifest) && isRecord(manifest.source) && isRecord(manifest.build),
    "Renderer source manifest is incomplete");
  assert.ok(isRecord(provenance) && isRecord(provenance.bundle),
    "Renderer build provenance is incomplete");
  assert.ok(isRecord(upstream), "Pinned upstream source snapshot is unavailable");

  assert.equal(manifest.source.commit, PINNED_ZTOOLS_COMMIT,
    "Renderer source manifest must pin the reviewed ZTools commit");
  assert.equal(provenance.sourceCommit, PINNED_ZTOOLS_COMMIT,
    "Built renderer provenance must pin the reviewed ZTools commit");
  assert.equal(upstream.commit, PINNED_ZTOOLS_COMMIT,
    "ATOOLS_ZTOOLS_SOURCE HEAD must match the pinned ZTools commit");
  assert.equal(upstream.dirty, "", "ATOOLS_ZTOOLS_SOURCE must be clean");

  assert.ok(isPositiveSafeInteger(provenance.sourceFiles),
    "Build provenance source file count must be a positive safe integer");
  assert.ok(isPositiveSafeInteger(upstream.files),
    "Pinned upstream source file count must be a positive safe integer");
  assert.equal(upstream.files, provenance.sourceFiles,
    "Build provenance source file count differs from the pinned checkout");
  assert.ok(isSha256(provenance.sourceTreeSha256),
    "Build provenance source tree hash must be a SHA-256 digest");
  assert.ok(isSha256(upstream.sha256),
    "Pinned upstream source tree hash must be a SHA-256 digest");
  assert.equal(upstream.sha256, provenance.sourceTreeSha256,
    "Upstream source SHA-256 differs from renderer provenance");

  const milestone = manifest.build.budgetMilestone;
  assert.ok(typeof milestone === "string"
      && !SETTINGS_RESOURCE_MILESTONES.has(milestone)
      && Object.hasOwn(FIXED_BUDGETS, milestone),
    "Renderer build manifest must use a frozen JavaScript budget milestone");
  const fixedBudget = FIXED_BUDGETS[milestone];
  if (COMPATIBILITY_PATCH_MILESTONES.has(milestone)) {
    assert.deepEqual(provenance.upstreamCompatibilityPatches, rendererCompatibilityPatchesForMilestone(milestone),
      "Renderer artifact must include the reviewed local-shortcut compatibility patches");
  }

  assert.equal(manifest.build.totalJavaScriptBudgetBytes, fixedBudget.totalJavaScriptBudgetBytes,
    "Renderer absolute JavaScript budget must remain frozen");
  assert.equal(manifest.build.previousTotalJavaScriptBytes, fixedBudget.previousTotalJavaScriptBytes,
    "Renderer previous JavaScript baseline must remain frozen");
  assert.equal(manifest.build.maxIncrementalJavaScriptBytes, fixedBudget.maxIncrementalJavaScriptBytes,
    "Renderer incremental JavaScript budget must remain frozen");

  const provenanceBytes = provenance.bundle.totalJavaScriptBytes;
  assert.ok(isPositiveSafeInteger(provenanceBytes),
    "Renderer JavaScript bundle measurement must be a positive safe integer");
  assert.ok(isPositiveSafeInteger(actualJavaScriptBytes),
    "Emitted renderer JavaScript byte count must be a positive safe integer");
  assert.equal(provenanceBytes, actualJavaScriptBytes,
    "Renderer JavaScript provenance must match the emitted chunks");
  assert.ok(provenanceBytes <= manifest.build.totalJavaScriptBudgetBytes,
    "Renderer JavaScript bundle exceeds the frozen absolute budget");
  assert.ok(provenanceBytes - manifest.build.previousTotalJavaScriptBytes <= manifest.build.maxIncrementalJavaScriptBytes,
    "Renderer JavaScript bundle exceeds the frozen incremental budget");
}
