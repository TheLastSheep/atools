use serde_json::Value;

pub(super) const RESOURCE_BUDGET_METRIC: &str = "uncompressed_emitted_resources_bytes";
pub(super) const SOURCE_COMMIT: &str = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
pub(super) const DISABLED_COMMANDS_BUDGET_MILESTONE: &str =
    "original-vue-disabled-command-cas-2026-10-28";
pub(super) const TRAY_VISIBILITY_BUDGET_MILESTONE: &str = "original-vue-tray-visibility-2026-10-29";
pub(super) const MAIN_HOTKEY_BUDGET_MILESTONE: &str = "original-vue-main-hotkey-2026-10-29";
pub(super) const LAUNCH_AT_LOGIN_BUDGET_MILESTONE: &str = "original-vue-launch-at-login-2026-10-29";
pub(super) const LOCAL_LAUNCH_BUDGET_MILESTONE: &str =
    "original-vue-local-launch-settings-2026-10-29";
pub(super) const NATIVE_LOCAL_DROP_BUDGET_MILESTONE: &str =
    "original-vue-native-local-drop-2026-10-29";
pub(super) const BUILTIN_SHORTCUTS_BUDGET_MILESTONE: &str =
    "original-vue-builtin-shortcuts-settings-2026-10-29";

pub(super) const HOTKEY_RECORDING_BUDGET_MILESTONE: &str =
    "original-vue-hotkey-recording-settings-2026-11-02";

pub(super) const DOUBLE_MODIFIER_BUDGET_MILESTONE: &str =
    "original-vue-double-modifier-settings-2026-11-02";

pub(super) const DEFAULT_HEIGHT_BUDGET_MILESTONE: &str =
    "original-vue-settings-default-height-2026-11-02";

pub(super) const ABOUT_UPDATE_BUDGET_MILESTONE: &str =
    "original-vue-about-update-settings-2026-11-02";

pub(super) const APP_GLOBAL_SHORTCUTS_BUDGET_MILESTONE: &str =
    "original-vue-app-global-shortcuts-settings-2026-11-02";

const LEGACY_BASELINE_BYTES: usize = 771_693;
const LEGACY_MAX_INCREASE_BYTES: usize = 8_192;
const DISABLED_COMMANDS_BASELINE_BYTES: usize = 779_464;
const DISABLED_COMMANDS_MAX_INCREASE_BYTES: usize = 4_096;
const TRAY_VISIBILITY_BASELINE_BYTES: usize = 783_356;
const TRAY_VISIBILITY_MAX_INCREASE_BYTES: usize = 1_024;
const MAIN_HOTKEY_BASELINE_BYTES: usize = 784_315;
const MAIN_HOTKEY_MAX_INCREASE_BYTES: usize = 2_048;
const LAUNCH_AT_LOGIN_BASELINE_BYTES: usize = 784_315;
const LAUNCH_AT_LOGIN_MAX_INCREASE_BYTES: usize = 6_144;
const ABSOLUTE_MAX_BYTES: usize = 786_432;
const LAUNCH_AT_LOGIN_ABSOLUTE_MAX_BYTES: usize = 790_528;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ResourceBudgetPolicy {
    pub(super) baseline_bytes: usize,
    pub(super) max_increase_bytes: usize,
    pub(super) absolute_max_bytes: usize,
    pub(super) milestone: Option<&'static str>,
}

impl ResourceBudgetPolicy {
    pub(super) const LEGACY: Self = Self {
        baseline_bytes: LEGACY_BASELINE_BYTES,
        max_increase_bytes: LEGACY_MAX_INCREASE_BYTES,
        absolute_max_bytes: ABSOLUTE_MAX_BYTES,
        milestone: None,
    };

    pub(super) const DISABLED_COMMANDS: Self = Self {
        baseline_bytes: DISABLED_COMMANDS_BASELINE_BYTES,
        max_increase_bytes: DISABLED_COMMANDS_MAX_INCREASE_BYTES,
        absolute_max_bytes: ABSOLUTE_MAX_BYTES,
        milestone: Some(DISABLED_COMMANDS_BUDGET_MILESTONE),
    };

    pub(super) const TRAY_VISIBILITY: Self = Self {
        baseline_bytes: TRAY_VISIBILITY_BASELINE_BYTES,
        max_increase_bytes: TRAY_VISIBILITY_MAX_INCREASE_BYTES,
        absolute_max_bytes: ABSOLUTE_MAX_BYTES,
        milestone: Some(TRAY_VISIBILITY_BUDGET_MILESTONE),
    };

    pub(super) const MAIN_HOTKEY: Self = Self {
        baseline_bytes: MAIN_HOTKEY_BASELINE_BYTES,
        max_increase_bytes: MAIN_HOTKEY_MAX_INCREASE_BYTES,
        absolute_max_bytes: ABSOLUTE_MAX_BYTES,
        milestone: Some(MAIN_HOTKEY_BUDGET_MILESTONE),
    };

    pub(super) const LAUNCH_AT_LOGIN: Self = Self {
        baseline_bytes: LAUNCH_AT_LOGIN_BASELINE_BYTES,
        max_increase_bytes: LAUNCH_AT_LOGIN_MAX_INCREASE_BYTES,
        absolute_max_bytes: LAUNCH_AT_LOGIN_ABSOLUTE_MAX_BYTES,
        milestone: Some(LAUNCH_AT_LOGIN_BUDGET_MILESTONE),
    };

    pub(super) const LOCAL_LAUNCH: Self = Self {
        baseline_bytes: 790_457,
        max_increase_bytes: 4_096,
        absolute_max_bytes: 794_553,
        milestone: Some(LOCAL_LAUNCH_BUDGET_MILESTONE),
    };

    pub(super) const NATIVE_LOCAL_DROP: Self = Self {
        baseline_bytes: 794_055,
        max_increase_bytes: 4_096,
        absolute_max_bytes: 798_151,
        milestone: Some(NATIVE_LOCAL_DROP_BUDGET_MILESTONE),
    };

    pub(super) const BUILTIN_SHORTCUTS: Self = Self {
        baseline_bytes: 797_670,
        max_increase_bytes: 3_072,
        absolute_max_bytes: 800_742,
        milestone: Some(BUILTIN_SHORTCUTS_BUDGET_MILESTONE),
    };

    pub(super) const HOTKEY_RECORDING: Self = Self {
        baseline_bytes: 798_892,
        max_increase_bytes: 3_072,
        absolute_max_bytes: 801_964,
        milestone: Some(HOTKEY_RECORDING_BUDGET_MILESTONE),
    };

    pub(super) const DOUBLE_MODIFIER: Self = Self {
        baseline_bytes: 801_929,
        max_increase_bytes: 1_024,
        absolute_max_bytes: 802_953,
        milestone: Some(DOUBLE_MODIFIER_BUDGET_MILESTONE),
    };

    pub(super) const DEFAULT_HEIGHT: Self = Self {
        baseline_bytes: 802_653,
        max_increase_bytes: 1_536,
        absolute_max_bytes: 804_189,
        milestone: Some(DEFAULT_HEIGHT_BUDGET_MILESTONE),
    };

    pub(super) const ABOUT_UPDATE: Self = Self {
        baseline_bytes: 803_857,
        max_increase_bytes: 8_192,
        absolute_max_bytes: 812_049,
        milestone: Some(ABOUT_UPDATE_BUDGET_MILESTONE),
    };

    pub(super) const APP_GLOBAL_SHORTCUTS: Self = Self {
        baseline_bytes: 806_371,
        max_increase_bytes: 16_384,
        absolute_max_bytes: 822_755,
        milestone: Some(APP_GLOBAL_SHORTCUTS_BUDGET_MILESTONE),
    };
    pub(super) fn max_total_bytes(self) -> usize {
        self.baseline_bytes
            .saturating_add(self.max_increase_bytes)
            .min(self.absolute_max_bytes)
    }
}

pub(super) fn select_source_policy(manifest: &Value) -> Result<ResourceBudgetPolicy, &'static str> {
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || manifest
            .get("source")
            .and_then(|source| source.get("commit"))
            .and_then(Value::as_str)
            != Some(SOURCE_COMMIT)
    {
        return Err("Bundle source manifest is not approved");
    }

    let build = manifest
        .get("build")
        .ok_or("Bundle source manifest build policy is missing")?;
    let policy = match build.get("budgetMilestone") {
        None => ResourceBudgetPolicy::LEGACY,
        Some(Value::String(milestone)) if milestone == DISABLED_COMMANDS_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::DISABLED_COMMANDS
        }
        Some(Value::String(milestone)) if milestone == TRAY_VISIBILITY_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::TRAY_VISIBILITY
        }
        Some(Value::String(milestone)) if milestone == MAIN_HOTKEY_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::MAIN_HOTKEY
        }
        Some(Value::String(milestone)) if milestone == LAUNCH_AT_LOGIN_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::LAUNCH_AT_LOGIN
        }
        Some(Value::String(milestone)) if milestone == LOCAL_LAUNCH_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::LOCAL_LAUNCH
        }
        Some(Value::String(milestone)) if milestone == NATIVE_LOCAL_DROP_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::NATIVE_LOCAL_DROP
        }
        Some(Value::String(milestone)) if milestone == BUILTIN_SHORTCUTS_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::BUILTIN_SHORTCUTS
        }
        Some(Value::String(milestone)) if milestone == HOTKEY_RECORDING_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::HOTKEY_RECORDING
        }
        Some(Value::String(milestone)) if milestone == DOUBLE_MODIFIER_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::DOUBLE_MODIFIER
        }
        Some(Value::String(milestone)) if milestone == DEFAULT_HEIGHT_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::DEFAULT_HEIGHT
        }
        Some(Value::String(milestone)) if milestone == ABOUT_UPDATE_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::ABOUT_UPDATE
        }
        Some(Value::String(milestone)) if milestone == APP_GLOBAL_SHORTCUTS_BUDGET_MILESTONE => {
            ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS
        }
        _ => return Err("Bundle source manifest milestone is unknown"),
    };
    let declared_budget = build
        .get("emittedResourceBudget")
        .ok_or("Bundle source manifest resource budget is missing")?;
    if declared_budget.get("metric").and_then(Value::as_str) != Some(RESOURCE_BUDGET_METRIC)
        || declared_budget.get("baselineBytes").and_then(Value::as_u64)
            != Some(policy.baseline_bytes as u64)
        || declared_budget
            .get("maxIncreaseBytes")
            .and_then(Value::as_u64)
            != Some(policy.max_increase_bytes as u64)
        || declared_budget.get("maxBytes").and_then(Value::as_u64)
            != Some(policy.absolute_max_bytes as u64)
    {
        return Err("Bundle source manifest resource budget is not approved");
    }

    Ok(policy)
}

#[cfg(test)]
#[path = "bundle_policy_tests.rs"]
mod tests;
