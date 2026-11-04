import assert from "node:assert/strict";
import test from "node:test";

import { frozenSettingsResourceBudget } from "./ztools-settings-resource-budget.mjs";

const PINNED_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const LEGACY = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 771_693,
  maxIncreaseBytes: 8_192,
  maxBytes: 786_432,
});
const DISABLED_COMMANDS_ID = "original-vue-disabled-command-cas-2026-10-28";
const DISABLED_COMMANDS = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 779_464,
  maxIncreaseBytes: 4_096,
  maxBytes: 786_432,
});
const TRAY_VISIBILITY_ID = "original-vue-tray-visibility-2026-10-29";
const TRAY_VISIBILITY = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 783_356,
  maxIncreaseBytes: 1_024,
  maxBytes: 786_432,
});
const MAIN_HOTKEY_ID = "original-vue-main-hotkey-2026-10-29";
const MAIN_HOTKEY = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 784_315,
  maxIncreaseBytes: 2_048,
  maxBytes: 786_432,
});
const LAUNCH_AT_LOGIN_ID = "original-vue-launch-at-login-2026-10-29";
const LAUNCH_AT_LOGIN = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 784_315,
  maxIncreaseBytes: 6_144,
  maxBytes: 790_528,
});
const LOCAL_LAUNCH_ID = "original-vue-local-launch-settings-2026-10-29";
const LOCAL_LAUNCH = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 790_457,
  maxIncreaseBytes: 4_096,
  maxBytes: 794_553,
});
const NATIVE_DROP_ID = "original-vue-native-local-drop-2026-10-29";
const NATIVE_DROP = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 794_055,
  maxIncreaseBytes: 4_096,
  maxBytes: 798_151,
});

function manifest(budget, milestone) {
  return {
    schemaVersion: 1,
    source: { commit: PINNED_COMMIT },
    build: {
      ...(milestone === undefined ? {} : { budgetMilestone: milestone }),
      emittedResourceBudget: { ...budget },
    },
  };
}

function select(value) {
  return frozenSettingsResourceBudget(value, PINNED_COMMIT);
}

test("R69 builtin shortcut policy is frozen separately from the accepted R67 resource policy", () => {
  const milestone = "original-vue-builtin-shortcuts-settings-2026-10-29";
  const budget = { metric: "uncompressed_emitted_resources_bytes", baselineBytes: 797670, maxIncreaseBytes: 3072, maxBytes: 800742 };
  assert.deepEqual(select(manifest(budget, milestone)), budget);
  assert.deepEqual(select(manifest(NATIVE_DROP, NATIVE_DROP_ID)), NATIVE_DROP);
  assert.throws(() => select(manifest(NATIVE_DROP, milestone)), /differs/);
  assert.throws(() => select(manifest(budget, NATIVE_DROP_ID)), /differs/);
  for (const key of ["baselineBytes", "maxIncreaseBytes", "maxBytes"]) {
    assert.throws(() => select(manifest({ ...budget, [key]: budget[key] + 1 }, milestone)), /differs/);
  }
});

test("native local drop has a separate frozen budget and cannot rewrite the old policy", () => {
  assert.deepEqual(select(manifest(NATIVE_DROP, NATIVE_DROP_ID)), NATIVE_DROP);
  assert.deepEqual(select(manifest(LOCAL_LAUNCH, LOCAL_LAUNCH_ID)), LOCAL_LAUNCH);
  assert.throws(() => select(manifest(NATIVE_DROP, LOCAL_LAUNCH_ID)), /differs/);
  assert.throws(() => select(manifest(LOCAL_LAUNCH, NATIVE_DROP_ID)), /differs/);
  for (const field of ["baselineBytes", "maxIncreaseBytes", "maxBytes"]) {
    assert.throws(() => select(manifest({ ...NATIVE_DROP, [field]: NATIVE_DROP[field] + 1 }, NATIVE_DROP_ID)), /differs/);
  }
});

test("keeps the historical and disabled-command policies frozen", () => {
  assert.deepEqual(select(manifest(LEGACY)), LEGACY);
  assert.deepEqual(select(manifest(DISABLED_COMMANDS, DISABLED_COMMANDS_ID)), DISABLED_COMMANDS);
});

test("accepts the tray-visibility policy at its exact resource budget", () => {
  assert.deepEqual(select(manifest(TRAY_VISIBILITY, TRAY_VISIBILITY_ID)), TRAY_VISIBILITY);
  assert.equal(
    Math.min(
      TRAY_VISIBILITY.baselineBytes + TRAY_VISIBILITY.maxIncreaseBytes,
      TRAY_VISIBILITY.maxBytes,
    ),
    784_380,
  );
});

test("accepts the main-hotkey policy at its frozen effective boundary", () => {
  assert.deepEqual(select(manifest(MAIN_HOTKEY, MAIN_HOTKEY_ID)), MAIN_HOTKEY);
  assert.equal(Math.min(MAIN_HOTKEY.baselineBytes + MAIN_HOTKEY.maxIncreaseBytes, MAIN_HOTKEY.maxBytes), 786_363);
  assert.equal(786_363 - 786_127, 236);
  assert.equal(786_432 - 786_127, 305);
});

test("rejects mixed milestone IDs and frozen budgets", () => {
  const oldMilestones = [DISABLED_COMMANDS_ID, TRAY_VISIBILITY_ID];
  for (const oldMilestone of oldMilestones) {
    assert.throws(
      () => select(manifest(MAIN_HOTKEY, oldMilestone)),
      /differs from its frozen milestone/,
    );
  }
  for (const oldBudget of [LEGACY, DISABLED_COMMANDS, TRAY_VISIBILITY]) {
    assert.throws(
      () => select(manifest(oldBudget, MAIN_HOTKEY_ID)),
      /differs from its frozen milestone/,
    );
  }
  assert.throws(() => select(manifest(MAIN_HOTKEY)), /differs from its frozen milestone/);
});

test("launch-at-login allocates a fixed 4KiB increment without rebasing historical budgets", () => {
  assert.deepEqual(select(manifest(LAUNCH_AT_LOGIN, LAUNCH_AT_LOGIN_ID)), LAUNCH_AT_LOGIN);
  assert.equal(LAUNCH_AT_LOGIN.baselineBytes, MAIN_HOTKEY.baselineBytes);
  assert.equal(LAUNCH_AT_LOGIN.maxBytes - MAIN_HOTKEY.maxBytes, 4_096);
  assert.equal(LAUNCH_AT_LOGIN.maxIncreaseBytes - MAIN_HOTKEY.maxIncreaseBytes, 4_096);
  assert.equal(Math.min(LAUNCH_AT_LOGIN.baselineBytes + LAUNCH_AT_LOGIN.maxIncreaseBytes, LAUNCH_AT_LOGIN.maxBytes), 790_459);
  assert.throws(() => select(manifest(LAUNCH_AT_LOGIN, MAIN_HOTKEY_ID)), /differs from its frozen milestone/);
  assert.throws(() => select(manifest({ ...LAUNCH_AT_LOGIN, maxBytes: 790_529 }, LAUNCH_AT_LOGIN_ID)), /differs from its frozen milestone/);
  assert.throws(() => select(manifest({ ...LAUNCH_AT_LOGIN, maxIncreaseBytes: 6_145 }, LAUNCH_AT_LOGIN_ID)), /differs from its frozen milestone/);
});

test("local launch freezes a 4KiB increment from the measured R64 artifact", () => {
  assert.deepEqual(select(manifest(LOCAL_LAUNCH, LOCAL_LAUNCH_ID)), LOCAL_LAUNCH);
  assert.throws(() => select(manifest({ ...LOCAL_LAUNCH, maxBytes: 794_554 }, LOCAL_LAUNCH_ID)), /frozen milestone/);
  assert.throws(() => select(manifest({ ...LOCAL_LAUNCH, maxIncreaseBytes: 4_097 }, LOCAL_LAUNCH_ID)), /frozen milestone/);
  assert.throws(() => select(manifest(LOCAL_LAUNCH, LAUNCH_AT_LOGIN_ID)), /frozen milestone/);
});

test("rejects unknown milestones and any attempt to raise the absolute ceiling", () => {
  assert.throws(
    () => select(manifest(MAIN_HOTKEY, "original-vue-unreviewed-2026-10-29")),
    /unknown resource budget milestone/,
  );
  const raisedAbsolute = { ...MAIN_HOTKEY, maxBytes: 786_433 };
  assert.throws(
    () => select(manifest(raisedAbsolute, MAIN_HOTKEY_ID)),
    /differs from its frozen milestone/,
  );
});


test("R71 hotkey recording keeps the approved 3KiB limit and historical R69 policy separate", () => {
  const milestone = "original-vue-hotkey-recording-settings-2026-11-02";
  const budget = { metric: "uncompressed_emitted_resources_bytes", baselineBytes: 798892, maxIncreaseBytes: 3072, maxBytes: 801964 };
  assert.deepEqual(select(manifest(budget, milestone)), budget);
  assert.throws(() => select(manifest(budget, "original-vue-builtin-shortcuts-settings-2026-10-29")), /differs/);
  for (const key of ["baselineBytes", "maxIncreaseBytes", "maxBytes"]) {
    assert.throws(() => select(manifest({ ...budget, [key]: budget[key] + 1 }, milestone)), /differs/);
  }
});


test("R79 uses the measured Settings baseline and preserves old milestones", () => {
  const id = "original-vue-about-update-settings-2026-11-02";
  const budget = { metric: "uncompressed_emitted_resources_bytes", baselineBytes: 803857, maxIncreaseBytes: 8192, maxBytes: 812049 };
  assert.deepEqual(select(manifest(budget, id)), budget);
  for (const key of ["baselineBytes", "maxIncreaseBytes", "maxBytes"]) {
    assert.throws(() => select(manifest({ ...budget, [key]: budget[key] + 1 }, id)), /differs/);
  }
  assert.throws(() => select(manifest(budget, "original-vue-settings-default-height-2026-11-02")), /differs/);
});

test("R80 app global shortcuts freezes the 16KiB increment from the measured R79 baseline", () => {
  const id = "original-vue-app-global-shortcuts-settings-2026-11-02";
  const budget = { metric: "uncompressed_emitted_resources_bytes", baselineBytes: 806371, maxIncreaseBytes: 16384, maxBytes: 822755 };
  assert.deepEqual(select(manifest(budget, id)), budget);
  for (const key of ["baselineBytes", "maxIncreaseBytes", "maxBytes"]) {
    assert.throws(() => select(manifest({ ...budget, [key]: budget[key] + 1 }, id)), /differs/);
  }
  assert.throws(() => select(manifest(budget, "original-vue-about-update-settings-2026-11-02")), /differs/);
});
