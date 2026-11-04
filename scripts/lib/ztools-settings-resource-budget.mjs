const LEGACY_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 771_693,
  maxIncreaseBytes: 8_192,
  maxBytes: 786_432,
});
const DISABLED_COMMANDS_RESOURCE_BUDGET_MILESTONE = "original-vue-disabled-command-cas-2026-10-28";
const DISABLED_COMMANDS_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 779_464,
  maxIncreaseBytes: 4_096,
  maxBytes: 786_432,
});
const TRAY_VISIBILITY_RESOURCE_BUDGET_MILESTONE = "original-vue-tray-visibility-2026-10-29";
const TRAY_VISIBILITY_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 783_356,
  maxIncreaseBytes: 1_024,
  maxBytes: 786_432,
});
const MAIN_HOTKEY_RESOURCE_BUDGET_MILESTONE = "original-vue-main-hotkey-2026-10-29";
const MAIN_HOTKEY_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 784_315,
  maxIncreaseBytes: 2_048,
  maxBytes: 786_432,
});
const LAUNCH_AT_LOGIN_RESOURCE_BUDGET_MILESTONE = "original-vue-launch-at-login-2026-10-29";
const LAUNCH_AT_LOGIN_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 784_315,
  maxIncreaseBytes: 6_144,
  maxBytes: 790_528,
});
const LOCAL_LAUNCH_RESOURCE_BUDGET_MILESTONE = "original-vue-local-launch-settings-2026-10-29";
const LOCAL_LAUNCH_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 790_457,
  maxIncreaseBytes: 4_096,
  maxBytes: 794_553,
});
const NATIVE_LOCAL_DROP_RESOURCE_BUDGET_MILESTONE = "original-vue-native-local-drop-2026-10-29";
const NATIVE_LOCAL_DROP_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes",
  baselineBytes: 794_055,
  maxIncreaseBytes: 4_096,
  maxBytes: 798_151,
});
const BUILTIN_SHORTCUTS_RESOURCE_BUDGET_MILESTONE = "original-vue-builtin-shortcuts-settings-2026-10-29";
const BUILTIN_SHORTCUTS_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes", baselineBytes: 797_670, maxIncreaseBytes: 3_072, maxBytes: 800_742,
});

const HOTKEY_RECORDING_RESOURCE_BUDGET_MILESTONE = "original-vue-hotkey-recording-settings-2026-11-02";
const HOTKEY_RECORDING_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes", baselineBytes: 798_892, maxIncreaseBytes: 3_072, maxBytes: 801_964,
});
const DOUBLE_MODIFIER_RESOURCE_BUDGET_MILESTONE = "original-vue-double-modifier-settings-2026-11-02";
const DOUBLE_MODIFIER_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes", baselineBytes: 801_929, maxIncreaseBytes: 1_024, maxBytes: 802_953,
});
const DEFAULT_HEIGHT_RESOURCE_BUDGET_MILESTONE = "original-vue-settings-default-height-2026-11-02";
const DEFAULT_HEIGHT_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes", baselineBytes: 802_653, maxIncreaseBytes: 1_536, maxBytes: 804_189,
});

const ABOUT_UPDATE_RESOURCE_BUDGET_MILESTONE = "original-vue-about-update-settings-2026-11-02";
const ABOUT_UPDATE_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes", baselineBytes: 803857, maxIncreaseBytes: 8192, maxBytes: 812049,
});

const APP_GLOBAL_SHORTCUTS_RESOURCE_BUDGET_MILESTONE = "original-vue-app-global-shortcuts-settings-2026-11-02";
const APP_GLOBAL_SHORTCUTS_RESOURCE_BUDGET = Object.freeze({
  metric: "uncompressed_emitted_resources_bytes", baselineBytes: 806371, maxIncreaseBytes: 16384, maxBytes: 822755,
});

export function frozenSettingsResourceBudget(manifest, pinnedSourceCommit) {
  const build = manifest?.build;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || manifest.source?.commit !== pinnedSourceCommit
      || !build || typeof build !== "object" || Array.isArray(build)) {
    throw new Error("Settings source manifest is missing or does not match the pinned source");
  }

  let expected;
  if (build.budgetMilestone === undefined) {
    expected = LEGACY_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === DISABLED_COMMANDS_RESOURCE_BUDGET_MILESTONE) {
    expected = DISABLED_COMMANDS_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === TRAY_VISIBILITY_RESOURCE_BUDGET_MILESTONE) {
    expected = TRAY_VISIBILITY_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === MAIN_HOTKEY_RESOURCE_BUDGET_MILESTONE) {
    expected = MAIN_HOTKEY_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === LAUNCH_AT_LOGIN_RESOURCE_BUDGET_MILESTONE) {
    expected = LAUNCH_AT_LOGIN_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === LOCAL_LAUNCH_RESOURCE_BUDGET_MILESTONE) {
    expected = LOCAL_LAUNCH_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === NATIVE_LOCAL_DROP_RESOURCE_BUDGET_MILESTONE) {
    expected = NATIVE_LOCAL_DROP_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === BUILTIN_SHORTCUTS_RESOURCE_BUDGET_MILESTONE) {
    expected = BUILTIN_SHORTCUTS_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === HOTKEY_RECORDING_RESOURCE_BUDGET_MILESTONE) {
    expected = HOTKEY_RECORDING_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === DOUBLE_MODIFIER_RESOURCE_BUDGET_MILESTONE) {
    expected = DOUBLE_MODIFIER_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === DEFAULT_HEIGHT_RESOURCE_BUDGET_MILESTONE) {
    expected = DEFAULT_HEIGHT_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === ABOUT_UPDATE_RESOURCE_BUDGET_MILESTONE) {
    expected = ABOUT_UPDATE_RESOURCE_BUDGET;
  } else if (build.budgetMilestone === APP_GLOBAL_SHORTCUTS_RESOURCE_BUDGET_MILESTONE) {
    expected = APP_GLOBAL_SHORTCUTS_RESOURCE_BUDGET;
  } else {
    throw new Error("Settings source manifest uses an unknown resource budget milestone");
  }

  const policy = build.emittedResourceBudget;
  const fields = ["baselineBytes", "maxBytes", "maxIncreaseBytes", "metric"];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
      || JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(fields)) {
    throw new Error("Settings source manifest resource budget is not frozen");
  }
  for (const field of fields) {
    if (policy[field] !== expected[field]) {
      throw new Error("Settings source manifest resource budget differs from its frozen milestone");
    }
  }
  return expected;
}
