import assert from "node:assert/strict";
import test from "node:test";
import { rendererCompatibilityPatchesForMilestone, validateRendererNativeProvenance } from "./ztools-renderer-native-provenance.mjs";
import { RENDERER_COMPATIBILITY_PATCHES } from "../../packages/ztools-renderer/upstream-compatibility-patches.mjs";

const PINNED_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const BUDGETS = Object.freeze({
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
const LEGACY_MILESTONE = "original-vue-settings-input-2026-10-27";
const DISABLED_COMMANDS_MILESTONE = "original-vue-disabled-command-cas-2026-10-28";
const LOCAL_APP_SEARCH_MILESTONE = "original-vue-local-app-search-2026-10-28";
const CURRENT_MILESTONE = "original-vue-plugin-inventory-2026-10-28";
const SETTINGS_RESOURCE_MILESTONES = [
  "original-vue-tray-visibility-2026-10-29",
  "original-vue-main-hotkey-2026-10-29",
  "original-vue-local-launch-settings-2026-10-29",
  "original-vue-native-local-drop-2026-10-29",
];
const LEGACY_MILESTONES = [LEGACY_MILESTONE, DISABLED_COMMANDS_MILESTONE, LOCAL_APP_SEARCH_MILESTONE];
const RECOMMENDATION_MILESTONE = "original-vue-recommendation-pins-2026-10-29";
const LOCAL_SHORTCUTS_MILESTONE = "original-vue-local-shortcuts-2026-10-29";
const LOCAL_LAUNCH_MAIN_MILESTONE = "original-vue-local-launch-main-2026-10-29";
const MILESTONES = [
  "original-vue-main-about-update-2026-11-02",
  ...LEGACY_MILESTONES,
  CURRENT_MILESTONE,
  RECOMMENDATION_MILESTONE,
  LOCAL_SHORTCUTS_MILESTONE,
  LOCAL_LAUNCH_MAIN_MILESTONE,
  "original-vue-builtin-shortcuts-main-2026-10-29",
  "original-vue-main-file-drop-2026-11-02",
  "original-vue-main-updater-2026-11-02",
];

function fixture({
  milestone = LEGACY_MILESTONE,
  sourceFiles = 64,
  bytes,
} = {}) {
  const budget = BUDGETS[milestone] ?? BUDGETS[LEGACY_MILESTONE];
  const measuredBytes = bytes ?? budget.previousTotalJavaScriptBytes + 123;
  const treeHash = "a".repeat(64);
  const manifest = {
    source: { commit: PINNED_COMMIT },
    build: { budgetMilestone: milestone, ...budget },
  };
  const provenance = {
    sourceCommit: PINNED_COMMIT,
    sourceFiles,
    sourceTreeSha256: treeHash,
    bundle: { totalJavaScriptBytes: measuredBytes },
    ...(["original-vue-main-about-update-2026-11-02", LOCAL_SHORTCUTS_MILESTONE, LOCAL_LAUNCH_MAIN_MILESTONE, "original-vue-builtin-shortcuts-main-2026-10-29", "original-vue-main-file-drop-2026-11-02", "original-vue-main-updater-2026-11-02"].includes(milestone)
      ? { upstreamCompatibilityPatches: rendererCompatibilityPatchesForMilestone(milestone) } : {}),
  };
  const upstream = { commit: PINNED_COMMIT, dirty: "", files: sourceFiles, sha256: treeHash };
  return { manifest, provenance, upstream, bytes: measuredBytes };
}

function validate(value) {
  return validateRendererNativeProvenance(
    value.manifest, value.provenance, value.upstream, value.bytes,
  );
}

test("accepts the historical and current frozen budget milestones", () => {
  for (const milestone of MILESTONES) {
    const value = fixture({
      milestone,
      bytes: BUDGETS[milestone].previousTotalJavaScriptBytes + 123,
    });
    assert.doesNotThrow(() => validate(value), milestone);
  }
});

test("accepts the final R37 local-app-search measurement and its exact incremental boundary", () => {
  assert.doesNotThrow(() => validate(fixture({
    milestone: LOCAL_APP_SEARCH_MILESTONE,
    bytes: 592149,
  })));
  const current = fixture({
    milestone: LOCAL_APP_SEARCH_MILESTONE,
    bytes: BUDGETS[LOCAL_APP_SEARCH_MILESTONE].previousTotalJavaScriptBytes
      + BUDGETS[LOCAL_APP_SEARCH_MILESTONE].maxIncrementalJavaScriptBytes,
  });
  assert.doesNotThrow(() => validate(current));
});

test("accepts the R38 measurement and the frozen absolute/effective boundary", () => {
  assert.doesNotThrow(() => validate(fixture({
    milestone: CURRENT_MILESTONE,
    bytes: 593860,
  })));
  assert.doesNotThrow(() => validate(fixture({
    milestone: CURRENT_MILESTONE,
    bytes: 593920,
  })));
});

test("accepts the R64 boundary and rejects even one extra byte", () => {
  assert.doesNotThrow(() => validate(fixture({ milestone: RECOMMENDATION_MILESTONE, bytes: 599031 })));
  assert.throws(() => validate(fixture({ milestone: RECOMMENDATION_MILESTONE, bytes: 599032 })), /absolute budget/);
});

test("retains the historical R65 local-shortcut boundary and freezes the completed Main local-launch boundary", () => {
  assert.doesNotThrow(() => validate(fixture({ milestone: LOCAL_SHORTCUTS_MILESTONE, bytes: 603092 })));
  assert.throws(() => validate(fixture({ milestone: LOCAL_SHORTCUTS_MILESTONE, bytes: 603093 })), /absolute budget/);
  assert.doesNotThrow(() => validate(fixture({ milestone: LOCAL_LAUNCH_MAIN_MILESTONE, bytes: 603273 })));
  assert.doesNotThrow(() => validate(fixture({ milestone: LOCAL_LAUNCH_MAIN_MILESTONE, bytes: 604116 })));
  assert.throws(() => validate(fixture({ milestone: LOCAL_LAUNCH_MAIN_MILESTONE, bytes: 604117 })), /absolute budget/);
});

test("rejects R65 artifacts with missing or unreviewed original-source patches", () => {
  for (const milestone of [LOCAL_SHORTCUTS_MILESTONE, LOCAL_LAUNCH_MAIN_MILESTONE]) {
    const missing = fixture({ milestone });
    delete missing.provenance.upstreamCompatibilityPatches;
    assert.throws(() => validate(missing), /reviewed local-shortcut compatibility patches/);
    const changed = fixture({ milestone });
    changed.provenance.upstreamCompatibilityPatches[0].afterSha256 = "f".repeat(64);
    assert.throws(() => validate(changed), /reviewed local-shortcut compatibility patches/);
  }
});

test("accepts legacy incremental boundaries whose absolute cap allows them", () => {
  for (const milestone of LEGACY_MILESTONES) {
    const budget = BUDGETS[milestone];
    const value = fixture({
      milestone,
      bytes: budget.previousTotalJavaScriptBytes + budget.maxIncrementalJavaScriptBytes,
    });
    assert.doesNotThrow(() => validate(value), milestone);
  }
});

test("uses the absolute cap when the R38 incremental boundary is higher", () => {
  assert.throws(() => validate(fixture({
    milestone: CURRENT_MILESTONE,
    bytes: 594197,
  })), /absolute budget/);
  assert.throws(() => validate(fixture({
    milestone: CURRENT_MILESTONE,
    bytes: 593921,
  })), /absolute budget/);
});

test("does not require a fixed upstream file count or reviewed artifact byte literal", () => {
  const value = fixture({ milestone: CURRENT_MILESTONE, sourceFiles: 61, bytes: 593860 });
  assert.doesNotThrow(() => validate(value));
});

test("rejects an unknown milestone and forged budget values", () => {
  const unknown = fixture({ milestone: "original-vue-made-up-2026-10-28" });
  assert.throws(() => validate(unknown), /frozen JavaScript budget milestone/);

  for (const milestone of MILESTONES) {
    for (const [field, value] of [
      ["totalJavaScriptBudgetBytes", BUDGETS[milestone].totalJavaScriptBudgetBytes + 1],
      ["previousTotalJavaScriptBytes", BUDGETS[milestone].previousTotalJavaScriptBytes - 1],
      ["maxIncrementalJavaScriptBytes", BUDGETS[milestone].maxIncrementalJavaScriptBytes + 1],
    ]) {
      const input = fixture({ milestone });
      input.manifest.build[field] = value;
      assert.throws(() => validate(input), `${milestone} ${field}`);
    }
  }
});

test("rejects Settings emitted-resource milestones in the Main renderer JavaScript budget domain", () => {
  for (const milestone of SETTINGS_RESOURCE_MILESTONES) {
    const settingsResourceBudget = fixture({ milestone });
    assert.throws(() => validate(settingsResourceBudget), /frozen JavaScript budget milestone/);
  }
});

test("rejects exact budget values borrowed from another milestone", () => {
  for (const milestone of MILESTONES) {
    for (const other of MILESTONES) {
      if (milestone === other) continue;
      const value = fixture({ milestone });
      Object.assign(value.manifest.build, BUDGETS[other]);
      assert.throws(() => validate(value), `${milestone} must not use ${other} values`);
    }
  }
});

test("rejects a dist byte measurement that differs from build provenance", () => {
  const value = fixture({ milestone: CURRENT_MILESTONE, bytes: 590200 });
  value.bytes += 1;
  assert.throws(() => validate(value));
});

test("rejects source file count and tree hash drift across frozen milestones", () => {
  for (const milestone of MILESTONES) {
    for (const mutate of [
      value => { value.upstream.files += 1; },
      value => { value.provenance.sourceFiles += 1; },
      value => { value.upstream.sha256 = "b".repeat(64); },
      value => { value.provenance.sourceTreeSha256 = "not-a-sha256"; },
    ]) {
      const value = fixture({ milestone });
      mutate(value);
      assert.throws(() => validate(value), milestone);
    }
  }
});

test("rejects a dirty checkout or any source commit outside the pin", () => {
  for (const milestone of MILESTONES) {
    for (const mutate of [
      value => { value.upstream.dirty = " M src/renderer/App.vue"; },
      value => { value.manifest.source.commit = "b".repeat(40); },
      value => { value.provenance.sourceCommit = "b".repeat(40); },
      value => { value.upstream.commit = "b".repeat(40); },
    ]) {
      const value = fixture({ milestone });
      mutate(value);
      assert.throws(() => validate(value), milestone);
    }
  }
});

test("rejects empty or non-safe source counts and malformed actual byte counts", () => {
  for (const sourceFiles of [0, -1, Number.MAX_SAFE_INTEGER + 1, 2.5]) {
    const value = fixture({ sourceFiles });
    assert.throws(() => validate(value));
  }
  for (const bytes of [0, -1, Number.MAX_SAFE_INTEGER + 1, 2.5, NaN]) {
    const value = fixture({ bytes });
    assert.throws(() => validate(value));
  }
});

test("rejects each milestone's incremental and absolute byte ceilings", () => {
  for (const milestone of MILESTONES) {
    const budget = BUDGETS[milestone];
    assert.throws(() => validate(fixture({
      milestone,
      bytes: budget.previousTotalJavaScriptBytes + budget.maxIncrementalJavaScriptBytes + 1,
    })), `${milestone} incremental ceiling`);
    assert.throws(() => validate(fixture({
      milestone,
      bytes: budget.totalJavaScriptBudgetBytes + 1,
    })), `${milestone} absolute ceiling`);
  }
});

test("R77 Main file drop budget rejects bytes above the exact frozen cap", () => {
  const milestone = "original-vue-main-file-drop-2026-11-02";
  assert.doesNotThrow(() => validate(fixture({ milestone, bytes: 610666 })));
  assert.throws(() => validate(fixture({ milestone, bytes: 610667 })), /absolute budget/);
  const missing = fixture({ milestone, bytes: 609832 });
  delete missing.provenance.upstreamCompatibilityPatches;
  assert.throws(() => validate(missing), /compatibility patches/);
});

test("R78 Main updater keeps the exact cap and required prior compatibility patches", () => {
  const milestone = "original-vue-main-updater-2026-11-02";
  assert.doesNotThrow(() => validate(fixture({ milestone, bytes: 614004 })));
  assert.throws(() => validate(fixture({ milestone, bytes: 614005 })), /absolute budget/);
  const missing = fixture({ milestone, bytes: 611000 });
  delete missing.provenance.upstreamCompatibilityPatches;
  assert.throws(() => validate(missing), /compatibility patches/);
  const altered = fixture({ milestone });
  altered.manifest.build.previousTotalJavaScriptBytes++;
  assert.throws(() => validate(altered), /baseline/);
});


test("R79 retains the Main cap and rejects old/new compatibility descriptor substitution", () => {
  const milestone = "original-vue-main-about-update-2026-11-02";
  assert.doesNotThrow(() => validate(fixture({ milestone, bytes: 614004 })));
  assert.throws(() => validate(fixture({ milestone, bytes: 614005 })), /budget/);
  for (const [target, other] of [[milestone, "original-vue-main-updater-2026-11-02"], ["original-vue-main-updater-2026-11-02", milestone]]) {
    const value = fixture({ milestone: target });
    value.provenance.upstreamCompatibilityPatches = rendererCompatibilityPatchesForMilestone(other);
    assert.throws(() => validate(value), /compatibility/);
  }
});
