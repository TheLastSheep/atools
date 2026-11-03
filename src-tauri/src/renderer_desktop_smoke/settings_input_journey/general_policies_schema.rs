use serde_json::{json, Value};
use std::path::Path;

#[path = "general_policies_clipboard_facts.rs"]
mod clipboard_facts;
#[path = "general_policies_clipboard_gate.rs"]
mod clipboard_gate;
#[path = "general_policies_probe_schema.rs"]
mod probe_schema;
#[path = "general_policies_window_facts.rs"]
mod window_facts;
#[path = "general_policies_window_gate.rs"]
mod window_gate;

pub(super) const REPORT_NAME: &str = "native-general-policies-report.json";
pub(super) const BASELINE_INVALID: &str = "settings-input-general-policies-baseline-invalid";
pub(super) const OPEN_FAILED: &str = "settings-input-general-policies-open-failed";
pub(super) const WINDOW_POLICY_FAILED: &str =
    "settings-input-general-policies-window-policy-failed";
pub(super) const WINDOW_GEOMETRY_INVALID: &str =
    "settings-input-general-policies-window-geometry-invalid";
pub(super) const CLIPBOARD_EDIT_FAILED: &str =
    "settings-input-general-policies-clipboard-edit-failed";
pub(super) const CLIPBOARD_CAPTURE_FAILED: &str =
    "settings-input-general-policies-clipboard-capture-failed";
pub(super) const REOPEN_FAILED: &str = "settings-input-general-policies-reopen-failed";
pub(super) const RESTORE_FAILED: &str = "settings-input-general-policies-restore-failed";
pub(super) const UNRELATED_CHANGED: &str = "settings-input-general-policies-unrelated-changed";
pub(super) const SAFETY_INVALID: &str = "settings-input-general-policies-safety-invalid";
pub(super) const CLOSE_FAILED: &str = "settings-input-general-policies-close-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-input-general-policies-report-write-failed";
pub(super) const READBACK_INVALID: &str = "settings-input-general-policies-readback-invalid";
const SCOPE: &str = "hidden-original-General-position-and-retention";
pub(super) const PHASES: &[&str] = &[
    "baseline",
    "afterCursor",
    "afterPrimary",
    "afterLastActive",
    "afterRememberSave",
    "afterRememberMove",
    "afterRememberRestore",
    "after30Save",
    "after30Capture",
    "after1Save",
    "after1Capture",
    "afterReset180",
    "afterResetCapture",
    "afterFreshReopen",
    "afterRestore",
    "afterClose",
];
const ERROR_CODES: &[&str] = &[
    BASELINE_INVALID,
    OPEN_FAILED,
    WINDOW_POLICY_FAILED,
    WINDOW_GEOMETRY_INVALID,
    CLIPBOARD_EDIT_FAILED,
    CLIPBOARD_CAPTURE_FAILED,
    REOPEN_FAILED,
    RESTORE_FAILED,
    UNRELATED_CHANGED,
    SAFETY_INVALID,
    CLOSE_FAILED,
    REPORT_WRITE_FAILED,
    READBACK_INVALID,
];
const REPORT_KEYS: &[&str] = &[
    "schemaVersion",
    "journey",
    "scope",
    "runId",
    "identifier",
    "pid",
    "root",
    "observations",
    "errors",
];
const OBSERVATION_KEYS: &[&str] = &[
    "windowUi",
    "geometry",
    "clipboard",
    "windowSafety",
    "pluginUiOpened",
    "preloadStarted",
    "childClosed",
];

pub(super) fn empty_observations() -> Value {
    json!({
        "windowUi": window_facts::empty_window_ui(),
        "geometry": window_facts::empty_geometry(),
        "clipboard": clipboard_facts::empty_clipboard(),
        "windowSafety": window_facts::empty_safety(),
        "pluginUiOpened": null, "preloadStarted": null, "childClosed": null,
    })
}

pub(super) fn build(
    profile: &super::super::profile::Profile,
    observations: Value,
    errors: &[&'static str],
) -> Value {
    json!({
        "schemaVersion": 1, "journey": "settings-general-policies", "scope": SCOPE,
        "runId": profile.run_id, "identifier": profile.identifier,
        "pid": std::process::id(), "root": profile.root.to_string_lossy(),
        "observations": observations, "errors": errors,
    })
}

pub(super) fn valid_report(profile: &super::super::profile::Profile, report: &Value) -> bool {
    exact_keys(report, REPORT_KEYS)
        && report["schemaVersion"].as_u64() == Some(1)
        && report["journey"].as_str() == Some("settings-general-policies")
        && report["scope"].as_str() == Some(SCOPE)
        && report["runId"].as_str() == Some(profile.run_id.as_str())
        && report["identifier"].as_str() == Some(profile.identifier.as_str())
        && report["pid"].as_u64() == Some(std::process::id() as u64)
        && report["root"].as_str() == Some(profile.root.to_string_lossy().as_ref())
        && profile.identifier == format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        && valid_run_id(&profile.run_id)
        && profile.output.file_name().and_then(|name| name.to_str()) == Some("native-report.json")
        && profile.root.parent() == Some(Path::new("/private/tmp"))
        && profile.root.file_name().and_then(|name| name.to_str())
            == Some(format!("atools-renderer-settings-input-{}", profile.run_id).as_str())
        && valid_observations(&report["observations"])
        && valid_errors(&report["errors"])
}

pub(super) fn observations_passed(value: &Value) -> bool {
    valid_observations(value)
        && window_gate::passed(value)
        && clipboard_gate::passed(value)
        && value["clipboard"]["finalUiDays"].as_u64()
            == Some(
                value["clipboard"]["initialStoredDays"]
                    .as_u64()
                    .unwrap_or(180),
            )
        && value["clipboard"]["finalStoredDays"].as_u64()
            == Some(
                value["clipboard"]["initialStoredDays"]
                    .as_u64()
                    .unwrap_or(180),
            )
        && PHASES.iter().all(|phase| {
            value["windowSafety"]["phases"][*phase]["visible"].as_bool() == Some(false)
                && value["windowSafety"]["phases"][*phase]["focused"].as_bool() == Some(false)
        })
        && value["windowSafety"]["focusEventsBefore"].as_u64() == Some(0)
        && value["windowSafety"]["focusEventsAfter"] == value["windowSafety"]["focusEventsBefore"]
        && value["pluginUiOpened"].as_bool() == Some(false)
        && value["preloadStarted"].as_bool() == Some(false)
        && value["childClosed"].as_bool() == Some(true)
}

fn valid_observations(value: &Value) -> bool {
    exact_keys(value, OBSERVATION_KEYS)
        && window_facts::valid_window_ui(&value["windowUi"])
        && window_facts::valid_geometry(&value["geometry"])
        && clipboard_facts::valid_clipboard(&value["clipboard"])
        && window_facts::valid_safety(&value["windowSafety"])
        && ["pluginUiOpened", "preloadStarted", "childClosed"]
            .iter()
            .all(|key| value[*key].is_null() || value[*key].is_boolean())
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
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

fn valid_run_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    probe_schema::valid_operation(operation, caller)
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    probe_schema::validate_probe_evidence(operation, value)
}
