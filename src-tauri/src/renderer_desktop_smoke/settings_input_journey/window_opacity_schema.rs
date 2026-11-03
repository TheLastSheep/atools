use serde_json::{json, Value};
use std::path::Path;

pub(super) const SCOPE: &str = "hidden-original-vue-window-opacity";
pub(super) const REPORT_NAME: &str = "native-window-opacity-report.json";
pub(super) const BASELINE_INVALID: &str = "settings-window-opacity-baseline-invalid";
pub(super) const OPEN_FAILED: &str = "settings-window-opacity-open-failed";
pub(super) const CHANGE_FAILED: &str = "settings-window-opacity-change-failed";
pub(super) const REOPEN_FAILED: &str = "settings-window-opacity-reopen-failed";
pub(super) const RESTORE_FAILED: &str = "settings-window-opacity-restore-failed";
pub(super) const READBACK_INVALID: &str = "settings-window-opacity-readback-invalid";
pub(super) const UNRELATED_CHANGED: &str = "settings-window-opacity-unrelated-changed";
pub(super) const CLOSE_FAILED: &str = "settings-window-opacity-close-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-window-opacity-report-write-failed";

const ERROR_CODES: &[&str] = &[
    BASELINE_INVALID,
    OPEN_FAILED,
    CHANGE_FAILED,
    REOPEN_FAILED,
    RESTORE_FAILED,
    READBACK_INVALID,
    UNRELATED_CHANGED,
    CLOSE_FAILED,
    REPORT_WRITE_FAILED,
];
const BOOL_KEYS: &[&str] = &[
    "initialStateValid",
    "changeDispatched",
    "changedUiMatches",
    "changedStored",
    "changedNativeMatches",
    "freshChildOnReopen",
    "reopenUiMatches",
    "reopenStored",
    "reopenNativeMatches",
    "restoreDispatched",
    "restoredStored",
    "restoredNativeMatches",
    "unrelatedPreserved",
    "closed",
    "pluginUiOpened",
    "preloadStarted",
];
const OPACITY_KEYS: &[&str] = &[
    "changedNativeOpacity",
    "reopenedNativeOpacity",
    "restoredNativeOpacity",
];
const SUCCESS_TRUE: &[&str] = &[
    "initialStateValid",
    "changeDispatched",
    "changedUiMatches",
    "changedStored",
    "changedNativeMatches",
    "freshChildOnReopen",
    "reopenUiMatches",
    "reopenStored",
    "reopenNativeMatches",
    "restoreDispatched",
    "restoredStored",
    "restoredNativeMatches",
    "unrelatedPreserved",
    "closed",
];
const OBSERVATION_KEYS: &[&str] = &[
    "initialStateValid",
    "changeDispatched",
    "changedUiMatches",
    "changedStored",
    "changedNativeMatches",
    "freshChildOnReopen",
    "reopenUiMatches",
    "reopenStored",
    "reopenNativeMatches",
    "restoreDispatched",
    "restoredStored",
    "restoredNativeMatches",
    "unrelatedPreserved",
    "closed",
    "pluginUiOpened",
    "preloadStarted",
    "changedNativeOpacity",
    "reopenedNativeOpacity",
    "restoredNativeOpacity",
];

pub(super) fn empty_observations() -> Value {
    let mut value = serde_json::Map::new();
    for key in BOOL_KEYS.iter().chain(OPACITY_KEYS) {
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
        "journey": "settings-window-opacity",
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
    if object.len() != REPORT_KEYS.len()
        || REPORT_KEYS.iter().any(|key| !object.contains_key(*key))
        || report["schemaVersion"].as_u64() != Some(1)
        || report["journey"].as_str() != Some("settings-window-opacity")
        || report["scope"].as_str() != Some(SCOPE)
        || report["identifier"].as_str() != Some(profile.identifier.as_str())
        || report["root"].as_str() != Some(profile.root.to_string_lossy().as_ref())
        || report["pid"].as_u64() != Some(std::process::id() as u64)
        || report["runId"].as_str() != Some(profile.run_id.as_str())
        || profile.identifier != format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        || !valid_run_id(&profile.run_id)
        || profile.output.file_name().and_then(|name| name.to_str()) != Some("native-report.json")
        || !valid_observations(&report["observations"])
        || !valid_errors(&report["errors"])
    {
        return false;
    }
    let Some(root_name) = profile.root.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    root_name == format!("atools-renderer-settings-input-{}", profile.run_id)
        && profile.root.parent() == Some(Path::new("/private/tmp"))
}

pub(super) fn observations_passed(value: &Value) -> bool {
    if !valid_observations(value) {
        return false;
    }
    SUCCESS_TRUE
        .iter()
        .all(|key| value[*key].as_bool() == Some(true))
        && value["pluginUiOpened"].as_bool() == Some(false)
        && value["preloadStarted"].as_bool() == Some(false)
        && near(value["changedNativeOpacity"].as_f64(), 0.65)
        && near(value["reopenedNativeOpacity"].as_f64(), 0.65)
        && near(value["restoredNativeOpacity"].as_f64(), 1.0)
}

fn valid_observations(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == OBSERVATION_KEYS.len()
        && OBSERVATION_KEYS.iter().all(|key| object.contains_key(*key))
        && BOOL_KEYS
            .iter()
            .all(|key| value[*key].is_null() || value[*key].is_boolean())
        && OPACITY_KEYS.iter().all(|key| {
            value[*key].is_null()
                || value[*key]
                    .as_f64()
                    .is_some_and(|opacity| opacity.is_finite() && (0.0..=1.0).contains(&opacity))
        })
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
            .all(|(index, error)| errors[..index].iter().all(|previous| previous != error))
}

fn valid_run_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn near(value: Option<f64>, expected: f64) -> bool {
    value.is_some_and(|actual| actual.is_finite() && (actual - expected).abs() <= 0.005000001)
}

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    matches!(
        operation,
        "childWindowOpacityInspect" | "childWindowOpacitySet"
    ) && caller.starts_with("ztools-settings-")
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    let (keys, has_dispatch): (&[&str], bool) = match operation {
        "childWindowOpacityInspect" => (
            &[
                "routeGeneral",
                "controlUnique",
                "rangeValid",
                "uiOpacity",
                "documentHidden",
                "documentHasFocus",
                "storedOpacity",
            ],
            false,
        ),
        "childWindowOpacitySet" => (
            &[
                "routeGeneral",
                "controlUnique",
                "rangeValid",
                "uiOpacity",
                "documentHidden",
                "documentHasFocus",
                "storedOpacity",
                "inputDispatched",
                "changeDispatched",
            ],
            true,
        ),
        _ => return None,
    };
    let Some(object) = value.as_object() else {
        return Some(Err("settings-input-probe-protocol-rejected"));
    };
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Some(Err("settings-input-probe-protocol-rejected"));
    }
    let bool_keys = if has_dispatch {
        &[
            "routeGeneral",
            "controlUnique",
            "rangeValid",
            "inputDispatched",
            "changeDispatched",
        ][..]
    } else {
        &["routeGeneral", "controlUnique", "rangeValid"][..]
    };
    let valid_bools = bool_keys.iter().all(|key| value[*key].as_bool().is_some());
    let valid_document = ["documentHidden", "documentHasFocus"]
        .iter()
        .all(|key| value[*key].is_null() || value[*key].is_boolean());
    let valid_opacity = ["uiOpacity", "storedOpacity"].iter().all(|key| {
        value[*key].is_null()
            || value[*key]
                .as_f64()
                .is_some_and(|opacity| opacity.is_finite() && (0.3..=1.0).contains(&opacity))
    });
    Some(if valid_bools && valid_document && valid_opacity {
        Ok(())
    } else {
        Err("settings-input-probe-protocol-rejected")
    })
}

#[cfg(test)]
mod tests {
    use super::{build, empty_observations, observations_passed, valid_report};
    use serde_json::json;

    fn profile() -> super::super::super::profile::Profile {
        super::super::super::profile::Profile::from_args(&[
            "--fixture-root".into(),
            "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef".into(),
            "--renderer-dist".into(),
            "/tmp/dist".into(),
            "--output".into(),
            "/tmp/run-0123456789abcdef0123456789abcdef/native-report.json".into(),
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
        let mut observations = empty_observations();
        for key in [
            "initialStateValid",
            "changeDispatched",
            "changedUiMatches",
            "changedStored",
            "changedNativeMatches",
            "freshChildOnReopen",
            "reopenUiMatches",
            "reopenStored",
            "reopenNativeMatches",
            "restoreDispatched",
            "restoredStored",
            "restoredNativeMatches",
            "unrelatedPreserved",
            "closed",
        ] {
            observations[key] = json!(true);
        }
        observations["pluginUiOpened"] = json!(false);
        observations["preloadStarted"] = json!(false);
        observations["changedNativeOpacity"] = json!(0.65);
        observations["reopenedNativeOpacity"] = json!(0.65);
        observations["restoredNativeOpacity"] = json!(1.0);
        observations
    }

    #[test]
    fn report_requires_exact_owner_schema_and_every_native_opacity_fact() {
        let profile = profile();
        let observations = complete();
        let report = build(&profile, observations.clone(), &[]);
        assert!(valid_report(&profile, &report));
        assert!(observations_passed(&observations));

        let mut unknown = report.clone();
        unknown["passed"] = json!(true);
        assert!(!valid_report(&profile, &unknown));
        let mut null_opacity = observations.clone();
        null_opacity["changedNativeOpacity"] = serde_json::Value::Null;
        assert!(!observations_passed(&null_opacity));
        let mut wrong_owner = report;
        wrong_owner["pid"] = json!(std::process::id() + 1);
        assert!(!valid_report(&profile, &wrong_owner));
    }
}
