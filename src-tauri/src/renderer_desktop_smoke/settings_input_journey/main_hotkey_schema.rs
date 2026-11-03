use serde_json::{json, Value};
use std::path::Path;

pub(super) const REPORT_NAME: &str = "native-main-hotkey-report.json";
pub(super) const SCOPE: &str = "hidden-original-vue-main-hotkey";
pub(super) const HOTKEY_A: &str = "Command+Ctrl+Option+Shift+F10";
pub(super) const HOTKEY_B: &str = "Command+Ctrl+Option+Shift+F11";
pub(super) const HOTKEY_C: &str = "Command+Ctrl+Option+Shift+F12";
pub(super) const BASELINE_INVALID: &str = "settings-main-hotkey-baseline-invalid";
pub(super) const OPEN_FAILED: &str = "settings-main-hotkey-open-failed";
pub(super) const RECORD_FAILED: &str = "settings-main-hotkey-record-failed";
pub(super) const CHANGE_FAILED: &str = "settings-main-hotkey-change-failed";
pub(super) const REOPEN_FAILED: &str = "settings-main-hotkey-reopen-failed";
pub(super) const CONFLICT_FAILED: &str = "settings-main-hotkey-conflict-failed";
pub(super) const RESTORE_FAILED: &str = "settings-main-hotkey-restore-failed";
pub(super) const READBACK_INVALID: &str = "settings-main-hotkey-readback-invalid";
pub(super) const UNRELATED_CHANGED: &str = "settings-main-hotkey-unrelated-changed";
pub(super) const CLOSE_FAILED: &str = "settings-main-hotkey-close-failed";
pub(super) const CLEANUP_FAILED: &str = "settings-main-hotkey-cleanup-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-main-hotkey-report-write-failed";
pub(super) const JOURNEY_FAILED: &str = "settings-input-main-hotkey-failed";

const OBSERVATION_KEYS: &[&str] = &[
    "initialOwnedRegistered",
    "initialUiMatches",
    "recordDispatched",
    "changedStored",
    "changedOwnedRegistered",
    "previousUnregistered",
    "changedUiMatches",
    "freshChildOnReopen",
    "reopenUiMatches",
    "reopenStored",
    "reopenOwnedRegistered",
    "conflictDispatched",
    "conflictUiRestored",
    "conflictStoredUnchanged",
    "conflictPrimaryPreserved",
    "conflictOtherPreserved",
    "restoreDispatched",
    "restoredStored",
    "restoredOwnedRegistered",
    "alternateUnregistered",
    "unrelatedPreserved",
    "childClosed",
    "ownedPrimaryReleased",
    "otherShortcutReleased",
    "mainRawHotkeyMutationDenied",
    "childRawHotkeyMutationDenied",
    "pluginUiOpened",
    "preloadStarted",
];
const SUCCESS_TRUE: &[&str] = &[
    "initialOwnedRegistered",
    "initialUiMatches",
    "recordDispatched",
    "changedStored",
    "changedOwnedRegistered",
    "previousUnregistered",
    "changedUiMatches",
    "freshChildOnReopen",
    "reopenUiMatches",
    "reopenStored",
    "reopenOwnedRegistered",
    "conflictDispatched",
    "conflictUiRestored",
    "conflictStoredUnchanged",
    "conflictPrimaryPreserved",
    "conflictOtherPreserved",
    "restoreDispatched",
    "restoredStored",
    "restoredOwnedRegistered",
    "alternateUnregistered",
    "unrelatedPreserved",
    "childClosed",
    "ownedPrimaryReleased",
    "otherShortcutReleased",
    "mainRawHotkeyMutationDenied",
    "childRawHotkeyMutationDenied",
];
const ERROR_CODES: &[&str] = &[
    BASELINE_INVALID,
    OPEN_FAILED,
    RECORD_FAILED,
    CHANGE_FAILED,
    REOPEN_FAILED,
    CONFLICT_FAILED,
    RESTORE_FAILED,
    READBACK_INVALID,
    UNRELATED_CHANGED,
    CLOSE_FAILED,
    CLEANUP_FAILED,
    REPORT_WRITE_FAILED,
];

pub(super) fn empty_observations() -> Value {
    let mut observations = serde_json::Map::new();
    for key in OBSERVATION_KEYS {
        observations.insert((*key).to_owned(), Value::Null);
    }
    Value::Object(observations)
}

pub(super) fn build(
    profile: &super::super::profile::Profile,
    observations: Value,
    errors: &[&'static str],
) -> Value {
    json!({
        "schemaVersion": 1,
        "journey": "settings-main-hotkey",
        "scope": SCOPE,
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "observations": observations,
        "errors": errors,
    })
}

pub(super) fn valid_report(profile: &super::super::profile::Profile, report: &Value) -> bool {
    const REPORT_KEYS: &[&str] = &[
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
    let Some(object) = report.as_object() else {
        return false;
    };
    object.len() == REPORT_KEYS.len()
        && REPORT_KEYS.iter().all(|key| object.contains_key(*key))
        && report["schemaVersion"].as_u64() == Some(1)
        && report["journey"].as_str() == Some("settings-main-hotkey")
        && report["scope"].as_str() == Some(SCOPE)
        && report["identifier"].as_str() == Some(profile.identifier.as_str())
        && report["root"].as_str() == Some(profile.root.to_string_lossy().as_ref())
        && report["pid"].as_u64() == Some(std::process::id() as u64)
        && report["runId"].as_str() == Some(profile.run_id.as_str())
        && profile.identifier == format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        && valid_run_id(&profile.run_id)
        && profile.root.parent() == Some(Path::new("/private/tmp"))
        && profile.root.file_name().and_then(|name| name.to_str())
            == Some(format!("atools-renderer-settings-input-{}", profile.run_id).as_str())
        && profile.output.file_name().and_then(|name| name.to_str()) == Some("native-report.json")
        && valid_observations(&report["observations"])
        && valid_errors(&report["errors"])
}

pub(super) fn observations_passed(observations: &Value) -> bool {
    valid_observations(observations)
        && SUCCESS_TRUE
            .iter()
            .all(|key| observations[*key].as_bool() == Some(true))
        && observations["pluginUiOpened"].as_bool() == Some(false)
        && observations["preloadStarted"].as_bool() == Some(false)
}

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    match operation {
        "mainRawHotkeyMutation" => caller == "main",
        "childRawHotkeyMutation" => caller.starts_with("ztools-settings-"),
        "childMainHotkeyInspect" | "childMainHotkeyRecord" => {
            caller.starts_with("ztools-settings-")
        }
        _ => false,
    }
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    if matches!(
        operation,
        "mainRawHotkeyMutation" | "childRawHotkeyMutation"
    ) {
        let valid = value
            .as_object()
            .is_some_and(|object| object.len() == 1 && value["aclDenied"].is_boolean());
        return Some(if valid {
            Ok(())
        } else {
            Err("settings-input-probe-protocol-rejected")
        });
    }
    let base = [
        "routeGeneral",
        "controlUnique",
        "displayValue",
        "storedValue",
        "documentHidden",
        "documentHasFocus",
    ];
    let record = operation == "childMainHotkeyRecord";
    let keys = if record {
        [
            &base[..],
            &[
                "clickDispatched",
                "keyDownDispatched",
                "keyUpDispatched",
                "rejectionObserved",
            ][..],
        ]
        .concat()
    } else if operation == "childMainHotkeyInspect" {
        base.to_vec()
    } else {
        return None;
    };
    let Some(object) = value.as_object() else {
        return Some(Err("settings-input-probe-protocol-rejected"));
    };
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Some(Err("settings-input-probe-protocol-rejected"));
    }
    let booleans = if record {
        [
            &base[..2],
            &base[4..],
            &[
                "clickDispatched",
                "keyDownDispatched",
                "keyUpDispatched",
                "rejectionObserved",
            ][..],
        ]
        .concat()
    } else {
        [&base[..2], &base[4..]].concat()
    };
    let values_valid = ["displayValue", "storedValue"].iter().all(|key| {
        value[*key].is_null()
            || [HOTKEY_A, HOTKEY_B, HOTKEY_C]
                .iter()
                .any(|allowed| value[*key].as_str() == Some(*allowed))
    });
    let valid = booleans.iter().all(|key| value[*key].is_boolean()) && values_valid;
    Some(if valid {
        Ok(())
    } else {
        Err("settings-input-probe-protocol-rejected")
    })
}

fn valid_observations(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == OBSERVATION_KEYS.len()
        && OBSERVATION_KEYS.iter().all(|key| object.contains_key(*key))
        && OBSERVATION_KEYS
            .iter()
            .all(|key| value[*key].is_null() || value[*key].is_boolean())
}

fn valid_errors(value: &Value) -> bool {
    let Some(errors) = value.as_array() else {
        return false;
    };
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
}

fn valid_run_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::{valid_operation, validate_probe_evidence};
    use serde_json::json;

    #[test]
    fn raw_global_shortcut_probe_is_bound_to_main_and_settings_child_callers() {
        assert!(valid_operation("mainRawHotkeyMutation", "main"));
        assert!(!valid_operation(
            "mainRawHotkeyMutation",
            "ztools-settings-1"
        ));
        assert!(valid_operation(
            "childRawHotkeyMutation",
            "ztools-settings-1"
        ));
        assert!(!valid_operation("childRawHotkeyMutation", "main"));
        assert!(!valid_operation("childRawHotkeyMutation", "other-child"));
    }

    #[test]
    fn raw_global_shortcut_probe_accepts_only_one_boolean_acl_fact() {
        for operation in ["mainRawHotkeyMutation", "childRawHotkeyMutation"] {
            assert_eq!(
                validate_probe_evidence(operation, &json!({ "aclDenied": true })),
                Some(Ok(()))
            );
            assert_eq!(
                validate_probe_evidence(operation, &json!({ "aclDenied": false })),
                Some(Ok(()))
            );
            for invalid in [
                json!({ "aclDenied": null }),
                json!({ "aclDenied": true, "other": false }),
                json!([]),
            ] {
                assert!(validate_probe_evidence(operation, &invalid)
                    .is_some_and(|result| result.is_err()));
            }
        }
    }
}
