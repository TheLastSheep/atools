use serde_json::{json, Value};
use std::path::Path;

pub(super) const REPORT_NAME: &str = "native-tray-visibility-report.json";
pub(super) const BASELINE_INVALID: &str = "settings-tray-visibility-baseline-invalid";
pub(super) const OPEN_FAILED: &str = "settings-tray-visibility-open-failed";
pub(super) const DISABLE_FAILED: &str = "settings-tray-visibility-disable-failed";
pub(super) const REOPEN_FAILED: &str = "settings-tray-visibility-reopen-failed";
pub(super) const ENABLE_FAILED: &str = "settings-tray-visibility-enable-failed";
pub(super) const READBACK_INVALID: &str = "settings-tray-visibility-readback-invalid";
pub(super) const UNRELATED_CHANGED: &str = "settings-tray-visibility-unrelated-changed";
pub(super) const CLOSE_FAILED: &str = "settings-tray-visibility-close-failed";
pub(super) const CLEANUP_FAILED: &str = "settings-tray-visibility-cleanup-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-tray-visibility-report-write-failed";

const OBSERVATION_KEYS: &[&str] = &[
    "startupDefaultVisible",
    "initialUiEnabled",
    "disableDispatched",
    "disabledStored",
    "disabledNative",
    "freshChildOnReopen",
    "reopenUiDisabled",
    "reopenStoredDisabled",
    "reopenNativeDisabled",
    "enableDispatched",
    "enabledStored",
    "enabledNative",
    "unrelatedPreserved",
    "childClosed",
    "trayReleased",
    "pluginUiOpened",
    "preloadStarted",
];
const SUCCESS_TRUE: &[&str] = &[
    "startupDefaultVisible",
    "initialUiEnabled",
    "disableDispatched",
    "disabledStored",
    "disabledNative",
    "freshChildOnReopen",
    "reopenUiDisabled",
    "reopenStoredDisabled",
    "reopenNativeDisabled",
    "enableDispatched",
    "enabledStored",
    "enabledNative",
    "unrelatedPreserved",
    "childClosed",
    "trayReleased",
];
const ERROR_CODES: &[&str] = &[
    BASELINE_INVALID,
    OPEN_FAILED,
    DISABLE_FAILED,
    REOPEN_FAILED,
    ENABLE_FAILED,
    READBACK_INVALID,
    UNRELATED_CHANGED,
    CLOSE_FAILED,
    CLEANUP_FAILED,
    REPORT_WRITE_FAILED,
];

pub(super) fn empty_observations() -> Value {
    let mut value = serde_json::Map::new();
    for key in OBSERVATION_KEYS {
        value.insert((*key).to_owned(), Value::Null);
    }
    Value::Object(value)
}

pub(super) fn build(
    profile: &super::super::profile::Profile,
    observations: Value,
    errors: &[&'static str],
) -> Value {
    json!({
        "schemaVersion": 1,
        "journey": "settings-tray-visibility",
        "scope": "hidden-original-vue-tray-visibility",
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
        && report["journey"].as_str() == Some("settings-tray-visibility")
        && report["scope"].as_str() == Some("hidden-original-vue-tray-visibility")
        && report["identifier"].as_str() == Some(profile.identifier.as_str())
        && report["root"].as_str() == Some(profile.root.to_string_lossy().as_ref())
        && report["pid"].as_u64() == Some(std::process::id() as u64)
        && report["runId"].as_str() == Some(profile.run_id.as_str())
        && profile.identifier == format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        && valid_run_id(&profile.run_id)
        && profile.output.file_name().and_then(|name| name.to_str()) == Some("native-report.json")
        && valid_observations(&report["observations"])
        && valid_errors(&report["errors"])
        && profile.root.parent() == Some(Path::new("/private/tmp"))
        && profile.root.file_name().and_then(|name| name.to_str())
            == Some(format!("atools-renderer-settings-input-{}", profile.run_id).as_str())
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
    matches!(
        operation,
        "childTrayVisibilityInspect" | "childTrayVisibilitySet"
    ) && caller.starts_with("ztools-settings-")
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    let mut keys = vec![
        "routeGeneral",
        "controlUnique",
        "uiEnabled",
        "storedEnabled",
        "documentHidden",
        "documentHasFocus",
    ];
    let is_set = match operation {
        "childTrayVisibilityInspect" => false,
        "childTrayVisibilitySet" => {
            keys.extend(["inputDispatched", "changeDispatched"]);
            true
        }
        _ => return None,
    };
    let Some(object) = value.as_object() else {
        return Some(Err("settings-input-probe-protocol-rejected"));
    };
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Some(Err("settings-input-probe-protocol-rejected"));
    }
    let base_bools_valid = [
        "routeGeneral",
        "controlUnique",
        "uiEnabled",
        "storedEnabled",
    ]
    .iter()
    .all(|key| value[*key].as_bool().is_some());
    let dispatch_valid = !is_set
        || ["inputDispatched", "changeDispatched"]
            .iter()
            .all(|key| value[*key].as_bool().is_some());
    let focus_valid = ["documentHidden", "documentHasFocus"]
        .iter()
        .all(|key| value[*key].is_null() || value[*key].is_boolean());
    let valid = base_bools_valid && dispatch_valid && focus_valid;
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
    use super::{build, empty_observations, observations_passed, valid_operation, valid_report};
    use serde_json::json;

    fn profile() -> super::super::super::profile::Profile {
        super::super::super::profile::Profile::from_args(&[
            "--fixture-root".into(),
            "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef".into(),
            "--renderer-dist".into(),
            "/tmp/dist".into(),
            "--output".into(),
            "/tmp/native-report.json".into(),
            "--auto-clear".into(),
            "never".into(),
            "--run-id".into(),
            "0123456789abcdef0123456789abcdef".into(),
            "--journey".into(),
            "settings-input".into(),
        ])
        .expect("valid private profile")
    }

    fn complete() -> serde_json::Value {
        let mut value = empty_observations();
        for key in [
            "startupDefaultVisible",
            "initialUiEnabled",
            "disableDispatched",
            "disabledStored",
            "disabledNative",
            "freshChildOnReopen",
            "reopenUiDisabled",
            "reopenStoredDisabled",
            "reopenNativeDisabled",
            "enableDispatched",
            "enabledStored",
            "enabledNative",
            "unrelatedPreserved",
            "childClosed",
            "trayReleased",
        ] {
            value[key] = json!(true);
        }
        value["pluginUiOpened"] = json!(false);
        value["preloadStarted"] = json!(false);
        value
    }

    #[test]
    fn sidecar_requires_exact_owner_schema_all_ui_and_native_facts() {
        let profile = profile();
        let observations = complete();
        let report = build(&profile, observations.clone(), &[]);
        assert!(valid_report(&profile, &report));
        assert!(observations_passed(&observations));
        let mut extra = report.clone();
        extra["passed"] = json!(true);
        assert!(!valid_report(&profile, &extra));
        let mut wrong_owner = report;
        wrong_owner["pid"] = json!(std::process::id() + 1);
        assert!(!valid_report(&profile, &wrong_owner));
        let mut null_fact = observations;
        null_fact["trayReleased"] = serde_json::Value::Null;
        assert!(!observations_passed(&null_fact));
    }

    #[test]
    fn probe_dispatch_is_child_only_and_rejects_unknown_or_non_boolean_facts() {
        assert!(valid_operation(
            "childTrayVisibilityInspect",
            "ztools-settings-1"
        ));
        assert!(!valid_operation("childTrayVisibilitySet", "main"));
        let evidence = json!({
            "routeGeneral": true, "controlUnique": true, "uiEnabled": false,
            "storedEnabled": false, "documentHidden": true, "documentHasFocus": false,
            "inputDispatched": true, "changeDispatched": true,
        });
        assert_eq!(
            super::validate_probe_evidence("childTrayVisibilitySet", &evidence),
            Some(Ok(()))
        );
        let mut invalid = evidence;
        invalid["changeDispatched"] = json!(null);
        assert!(
            super::validate_probe_evidence("childTrayVisibilitySet", &invalid)
                .unwrap()
                .is_err()
        );
    }
}
