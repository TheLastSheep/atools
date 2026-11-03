use serde_json::{json, Value};
use std::path::Path;

pub(super) const FIRST_REPORT: &str = "native-main-hotkey-recovery-first-report.json";
pub(super) const SECOND_REPORT: &str = "native-main-hotkey-recovery-second-report.json";
pub(super) const INVALID_SENTINEL: &str = "Command+Command";
pub(super) const HOTKEY_B: &str = "Command+Ctrl+Option+Shift+F11";
pub(super) const OWNER_INVALID: &str = "settings-main-hotkey-recovery-owner-invalid";
pub(super) const STARTUP_INVALID: &str = "settings-main-hotkey-recovery-startup-invalid";
pub(super) const GENERAL_OPEN_FAILED: &str = "settings-main-hotkey-recovery-general-open-failed";
pub(super) const UI_INVALID: &str = "settings-main-hotkey-recovery-ui-invalid";
pub(super) const PLACEHOLDER_FAILED: &str = "settings-main-hotkey-recovery-placeholder-failed";
pub(super) const INVALID_PRESERVED_FAILED: &str =
    "settings-main-hotkey-recovery-invalid-preserved-failed";
pub(super) const RECORD_FAILED: &str = "settings-main-hotkey-recovery-record-failed";
pub(super) const STATE_INVALID: &str = "settings-main-hotkey-recovery-state-invalid";
pub(super) const CLOSE_FAILED: &str = "settings-main-hotkey-recovery-close-failed";
pub(super) const RELEASE_FAILED: &str = "settings-main-hotkey-recovery-release-failed";
pub(super) const RUNTIME_STARTED: &str = "settings-main-hotkey-recovery-runtime-started";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-main-hotkey-recovery-report-write-failed";

const FIRST_KEYS: &[&str] = &[
    "startupNeedsRecovery",
    "startupAttempted",
    "ownedHotkeyUnregistered",
    "generalOpened",
    "hotkeyControlEmpty",
    "placeholderEditDispatched",
    "placeholderStored",
    "invalidHotkeyPreserved",
    "repairChordDispatched",
    "repairStored",
    "repairOwnedState",
    "repairManagerRegistered",
    "childClosed",
    "hotkeyOwnedBeforeExit",
    "pluginUiOpened",
    "preloadStarted",
    "databaseDevice",
    "databaseInode",
];
const SECOND_KEYS: &[&str] = &[
    "resumeClaimed",
    "startupRegistered",
    "startupOwnedStateB",
    "startupManagerRegistered",
    "generalOpened",
    "generalReadBackB",
    "releaseAttempted",
    "releaseConfirmed",
    "childClosed",
    "pluginUiOpened",
    "preloadStarted",
    "databaseDevice",
    "databaseInode",
];
const FIRST_TRUE: &[&str] = &[
    "startupNeedsRecovery",
    "startupAttempted",
    "ownedHotkeyUnregistered",
    "generalOpened",
    "hotkeyControlEmpty",
    "placeholderEditDispatched",
    "placeholderStored",
    "invalidHotkeyPreserved",
    "repairChordDispatched",
    "repairStored",
    "repairOwnedState",
    "repairManagerRegistered",
    "childClosed",
    "hotkeyOwnedBeforeExit",
];
const SECOND_TRUE: &[&str] = &[
    "resumeClaimed",
    "startupRegistered",
    "startupOwnedStateB",
    "startupManagerRegistered",
    "generalOpened",
    "generalReadBackB",
    "releaseAttempted",
    "releaseConfirmed",
    "childClosed",
];
const ERROR_CODES: &[&str] = &[
    OWNER_INVALID,
    STARTUP_INVALID,
    GENERAL_OPEN_FAILED,
    UI_INVALID,
    PLACEHOLDER_FAILED,
    INVALID_PRESERVED_FAILED,
    RECORD_FAILED,
    STATE_INVALID,
    CLOSE_FAILED,
    RELEASE_FAILED,
    RUNTIME_STARTED,
    REPORT_WRITE_FAILED,
];

pub(super) fn empty_first() -> Value {
    empty_observations(FIRST_KEYS)
}

pub(super) fn empty_second() -> Value {
    empty_observations(SECOND_KEYS)
}

fn empty_observations(keys: &[&str]) -> Value {
    let mut observations = serde_json::Map::new();
    for key in keys {
        observations.insert((*key).to_owned(), Value::Null);
    }
    Value::Object(observations)
}

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    matches!(
        operation,
        "childHotkeyStartupInspect" | "childHotkeyStartupPlaceholder"
    ) && caller.starts_with("ztools-settings-")
}

pub(super) fn profile_allows(profile: &super::super::profile::Profile, operation: &str) -> bool {
    valid_operation(operation, "ztools-settings-probe")
        && (profile.main_hotkey_recovery_first || profile.main_hotkey_recovery_second)
}

pub(super) fn allowed_for_profile(
    profile: &super::super::profile::Profile,
    operation: &str,
    caller: &str,
) -> bool {
    !operation.starts_with("childHotkeyStartup")
        || valid_operation(operation, caller) && profile_allows(profile, operation)
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    const INSPECT_KEYS: &[&str] = &[
        "routeGeneral",
        "hotkeyControlUnique",
        "hotkeyControlEmpty",
        "projectedHotkeyEmpty",
        "currentShortcutEmpty",
        "documentHidden",
        "documentHasFocus",
    ];
    const PLACEHOLDER_KEYS: &[&str] = &[
        "routeGeneral",
        "hotkeyControlUnique",
        "placeholderControlUnique",
        "placeholderClickDispatched",
        "inputDispatched",
        "changeDispatched",
        "placeholderStored",
        "projectedHotkeyEmpty",
        "currentShortcutEmpty",
        "documentHidden",
        "documentHasFocus",
    ];
    let keys = match operation {
        "childHotkeyStartupInspect" => INSPECT_KEYS,
        "childHotkeyStartupPlaceholder" => PLACEHOLDER_KEYS,
        _ => return None,
    };
    let valid = exact_keys(value, keys) && keys.iter().all(|key| value[*key].is_boolean());
    Some(if valid {
        Ok(())
    } else {
        Err("settings-input-probe-protocol-rejected")
    })
}

pub(super) fn first_report(
    profile: &super::super::profile::Profile,
    observations: Value,
    errors: &[&'static str],
) -> Value {
    json!({
        "schemaVersion": 1,
        "journey": "main-hotkey-startup-recovery-first",
        "scope": "invalid-hotkey-first-process",
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "observations": observations,
        "errors": errors,
    })
}

pub(super) fn second_report(
    profile: &super::super::profile::Profile,
    previous_pid: u32,
    observations: Value,
    errors: &[&'static str],
) -> Value {
    json!({
        "schemaVersion": 1,
        "journey": "main-hotkey-startup-recovery-second",
        "scope": "same-db-cold-start",
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "previousPid": previous_pid,
        "observations": observations,
        "errors": errors,
    })
}

pub(super) fn valid_first(profile: &super::super::profile::Profile, value: &Value) -> bool {
    let keys = [
        "schemaVersion",
        "journey",
        "scope",
        "identifier",
        "root",
        "pid",
        "runId",
        "observations",
        "errors",
    ];
    exact_keys(value, &keys)
        && value["schemaVersion"].as_u64() == Some(1)
        && value["journey"].as_str() == Some("main-hotkey-startup-recovery-first")
        && value["scope"].as_str() == Some("invalid-hotkey-first-process")
        && profile.main_hotkey_recovery_first
        && owner_matches(profile, value)
        && valid_observations(&value["observations"], FIRST_KEYS)
        && valid_errors(&value["errors"])
}

pub(super) fn valid_second(
    profile: &super::super::profile::Profile,
    value: &Value,
    previous_pid: u32,
) -> bool {
    let keys = [
        "schemaVersion",
        "journey",
        "scope",
        "identifier",
        "root",
        "pid",
        "runId",
        "previousPid",
        "observations",
        "errors",
    ];
    exact_keys(value, &keys)
        && value["schemaVersion"].as_u64() == Some(1)
        && value["journey"].as_str() == Some("main-hotkey-startup-recovery-second")
        && value["scope"].as_str() == Some("same-db-cold-start")
        && value["previousPid"].as_u64() == Some(u64::from(previous_pid))
        && profile.main_hotkey_recovery_second
        && profile.resume_hotkey_owner_pid == Some(previous_pid)
        && owner_matches(profile, value)
        && valid_observations(&value["observations"], SECOND_KEYS)
        && valid_errors(&value["errors"])
}

pub(super) fn observations_passed(value: &Value, first: bool) -> bool {
    let (keys, required) = if first {
        (FIRST_KEYS, FIRST_TRUE)
    } else {
        (SECOND_KEYS, SECOND_TRUE)
    };
    valid_observations(value, keys)
        && required
            .iter()
            .all(|key| value[*key].as_bool() == Some(true))
        && value["pluginUiOpened"].as_bool() == Some(false)
        && value["preloadStarted"].as_bool() == Some(false)
        && nonempty_database_identity(&value["databaseDevice"])
        && nonempty_database_identity(&value["databaseInode"])
}

fn owner_matches(profile: &super::super::profile::Profile, value: &Value) -> bool {
    profile.settings_input_journey
        && profile.identifier == format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        && profile.root.parent() == Some(Path::new("/private/tmp"))
        && profile.root.file_name().and_then(|name| name.to_str())
            == Some(format!("atools-renderer-settings-input-{}", profile.run_id).as_str())
        && profile.output.file_name().and_then(|name| name.to_str()) == Some("native-report.json")
        && value["identifier"].as_str() == Some(profile.identifier.as_str())
        && value["root"].as_str() == Some(profile.root.to_string_lossy().as_ref())
        && value["pid"].as_u64() == Some(u64::from(std::process::id()))
        && value["runId"].as_str() == Some(profile.run_id.as_str())
}

fn valid_observations(value: &Value, keys: &[&str]) -> bool {
    exact_keys(value, keys)
        && keys
            .iter()
            .filter(|key| **key != "databaseDevice" && **key != "databaseInode")
            .all(|key| value[*key].is_null() || value[*key].is_boolean())
        && valid_database_identity(&value["databaseDevice"])
        && valid_database_identity(&value["databaseInode"])
}

fn valid_database_identity(value: &Value) -> bool {
    value.is_null() || nonempty_database_identity(value)
}

fn nonempty_database_identity(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        !value.is_empty()
            && (value == "0" || !value.starts_with('0'))
            && value.bytes().all(|byte| byte.is_ascii_digit())
            && value.parse::<u64>().is_ok()
    })
}

fn valid_errors(value: &Value) -> bool {
    value.as_array().is_some_and(|errors| {
        errors.len() <= ERROR_CODES.len()
            && errors.iter().all(|error| {
                error
                    .as_str()
                    .is_some_and(|code| ERROR_CODES.contains(&code))
            })
            && errors
                .iter()
                .enumerate()
                .all(|(index, error)| errors[..index].iter().all(|prior| prior != error))
    })
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

#[cfg(test)]
#[path = "main_hotkey_startup_schema_tests.rs"]
mod tests;
