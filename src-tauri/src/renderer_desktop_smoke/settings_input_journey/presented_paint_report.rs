use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const ERRORS: &[&str] = &[
    "settings-input-presented-paint-identity-invalid",
    "settings-input-presented-paint-show-failed",
    "settings-input-presented-paint-visible-state-invalid",
    "settings-input-presented-paint-focus-changed",
    "settings-input-presented-paint-theme-selection-invalid",
    "settings-input-presented-paint-theme-convergence-timeout",
    "settings-input-presented-paint-readiness-timeout",
    "settings-input-presented-paint-snapshot-failed",
    "settings-input-presented-paint-restore-failed",
    "settings-input-presented-paint-hide-failed",
    "settings-input-presented-paint-watchdog-expired",
];

const REPORT_NAME: &str = "native-presented-paint-report.json";

pub(super) fn empty(profile: &super::super::profile::Profile) -> Value {
    json!({
        "schemaVersion": 2,
        "journey": "settings-input-presented-paint",
        "scope": "owned-settings-child-visible-unfocused",
        "mode": "visible-unfocused",
        "attempted": true,
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "elapsedMs": 0,
        "passed": false,
        "presentation": empty_presentation(),
        "windowTrace": empty_window_trace(),
        "steps": [],
        "restoration": empty_restoration(),
        "cleanup": empty_cleanup(),
        "errors": [],
    })
}

pub(super) fn empty_window_trace() -> Value {
    json!({
        "schemaVersion": 1,
        "baseline": Value::Null,
        "afterOrderFront": Value::Null,
        "lastVisibility": Value::Null,
        "afterHide": Value::Null,
        "visibilitySamples": 0,
    })
}

pub(super) fn empty_step(theme: &str) -> Value {
    json!({
        "theme": theme,
        "themeControlFound": false,
        "themeMenuOpened": false,
        "optionSetValid": false,
        "selectionDispatched": false,
        "selected": false,
        "selectedTheme": Value::Null,
        "databaseTheme": Value::Null,
        "childMediaDark": Value::Null,
        "mainMediaDark": Value::Null,
        "nativeAppearance": Value::Null,
        "readiness": if theme == "system" { Value::Null } else { empty_readiness() },
        "presentation": empty_presentation(),
        "snapshot": if theme == "system" {
            not_required_snapshot()
        } else {
            unverified_snapshot("settings-input-presented-paint-snapshot-failed")
        },
    })
}

pub(super) fn empty_readiness() -> Value {
    json!({
        "routeGeneral": false,
        "mediaMatches": false,
        "menusAbsent": false,
        "rootTextMatches": false,
        "sidebarTextMatches": false,
        "labelTextMatches": false,
        "framesObserved": false,
        "settled": false,
    })
}

pub(super) fn empty_presentation() -> Value {
    json!({
        "visible": Value::Null,
        "windowFocused": Value::Null,
        "windowKey": Value::Null,
        "appActive": Value::Null,
        "frontmostIsSelf": Value::Null,
    })
}

pub(super) fn empty_restoration() -> Value {
    json!({
        "selectedTheme": Value::Null,
        "databaseTheme": Value::Null,
        "childMediaDark": Value::Null,
        "mainMediaDark": Value::Null,
        "nativeAppearance": Value::Null,
        "presentation": empty_presentation(),
    })
}

pub(super) fn empty_cleanup() -> Value {
    json!({
        "hideConfirmed": false,
        "visible": Value::Null,
        "windowFocused": Value::Null,
        "windowKey": Value::Null,
        "appActive": Value::Null,
        "frontmostIsSelf": Value::Null,
    })
}

pub(super) fn not_required_snapshot() -> Value {
    json!({ "state": "not-required", "filename": Value::Null, "evidence": Value::Null, "reason": Value::Null })
}

pub(super) fn unverified_snapshot(reason: &'static str) -> Value {
    json!({
        "state": "unverified",
        "filename": Value::Null,
        "evidence": Value::Null,
        "reason": if ERRORS.contains(&reason) {
            reason
        } else {
            "settings-input-presented-paint-snapshot-failed"
        },
    })
}

pub(super) fn captured_snapshot(filename: &'static str, evidence: Value) -> Value {
    json!({ "state": "captured", "filename": filename, "evidence": evidence, "reason": Value::Null })
}

pub(super) fn add_error(report: &mut Value, code: &'static str) {
    if !ERRORS.contains(&code) {
        return;
    }
    if let Some(errors) = report["errors"].as_array_mut() {
        if !errors.iter().any(|error| error.as_str() == Some(code)) {
            errors.push(Value::String(code.to_owned()));
        }
    }
}

pub(super) fn push_step(report: &mut Value, step: Value) {
    if let Some(steps) = report["steps"].as_array_mut() {
        steps.push(step);
    }
}

pub(super) fn set_restoration(report: &mut Value, value: Value) {
    report["restoration"] = value;
}

pub(super) fn set_cleanup(report: &mut Value, value: Value) {
    report["cleanup"] = value;
}

pub(super) fn set_presentation(report: &mut Value, value: Value) {
    report["presentation"] = value;
}

pub(super) fn set_window_trace(report: &mut Value, value: Value) {
    report["windowTrace"] = value;
}

pub(super) fn finalize(report: &mut Value, elapsed_ms: u64) {
    report["elapsedMs"] = Value::from(elapsed_ms);
    report["passed"] = Value::Bool(passes(report));
}

fn passes(report: &Value) -> bool {
    let Some(steps) = report["steps"].as_array() else {
        return false;
    };
    steps.len() == 3
        && steps.iter().zip(["light", "dark", "system"]).all(|(step, theme)| {
            step["theme"].as_str() == Some(theme)
                && step["themeControlFound"].as_bool() == Some(true)
                && step["themeMenuOpened"].as_bool() == Some(true)
                && step["optionSetValid"].as_bool() == Some(true)
                && step["selectionDispatched"].as_bool() == Some(true)
                && step["selected"].as_bool() == Some(true)
                && step["selectedTheme"].as_str() == Some(theme)
                && step["databaseTheme"].as_str() == Some(theme)
                && appearance_matches(step)
                && presentation_unfocused(&step["presentation"])
                && if theme == "system" {
                    step["readiness"].is_null()
                        && step["snapshot"]["state"].as_str() == Some("not-required")
                } else {
                    crate::renderer_desktop_smoke::settings_input_journey::material_report::snapshot_readiness_settled(&step["readiness"])
                        && step["snapshot"]["state"].as_str() == Some("captured")
                }
        })
        && presentation_unfocused(&report["presentation"])
        && report["restoration"]["selectedTheme"].as_str() == Some("dark")
        && report["restoration"]["databaseTheme"].as_str() == Some("dark")
        && report["restoration"]["childMediaDark"].as_bool() == Some(true)
        && report["restoration"]["mainMediaDark"].as_bool() == Some(true)
        && report["restoration"]["nativeAppearance"].as_str() == Some("dark")
        && presentation_unfocused(&report["restoration"]["presentation"])
        && report["cleanup"]["hideConfirmed"].as_bool() == Some(true)
        && report["cleanup"]["visible"].as_bool() == Some(false)
        && report["cleanup"]["windowFocused"].as_bool() == Some(false)
        && report["cleanup"]["windowKey"].as_bool() == Some(false)
        && report["cleanup"]["appActive"].as_bool() == Some(false)
        && report["cleanup"]["frontmostIsSelf"].as_bool() == Some(false)
        && window_trace_passes(&report["windowTrace"], &report["cleanup"])
        && report["errors"].as_array().is_some_and(Vec::is_empty)
}

fn window_trace_passes(trace: &Value, cleanup: &Value) -> bool {
    const TRACE_KEYS: [&str; 6] = [
        "schemaVersion",
        "baseline",
        "afterOrderFront",
        "lastVisibility",
        "afterHide",
        "visibilitySamples",
    ];
    const FACT_KEYS: [&str; 8] = [
        "visible",
        "occlusionVisible",
        "onActiveSpace",
        "windowFocused",
        "windowKey",
        "appActive",
        "appHidden",
        "frontmostIsSelf",
    ];
    let Some(trace_object) = trace.as_object() else {
        return false;
    };
    let samples = trace["visibilitySamples"].as_u64();
    let last = &trace["lastVisibility"];
    if trace_object.len() != TRACE_KEYS.len()
        || TRACE_KEYS
            .iter()
            .any(|key| !trace_object.contains_key(*key))
        || trace["schemaVersion"].as_u64() != Some(1)
        || !samples.is_some_and(|count| count <= 256)
        || samples.is_some_and(|count| (count == 0) != last.is_null())
    {
        return false;
    }

    let phase_is_well_formed = |phase: &Value| {
        let Some(object) = phase.as_object() else {
            return phase.is_null();
        };
        object.len() == FACT_KEYS.len()
            && FACT_KEYS.iter().all(|key| {
                object
                    .get(*key)
                    .is_some_and(|value| value.is_boolean() || value.is_null())
            })
    };
    let baseline = &trace["baseline"];
    let after_front = &trace["afterOrderFront"];
    let visibility = last;
    let after_hide = &trace["afterHide"];
    if ![baseline, after_front, visibility, after_hide]
        .iter()
        .all(|phase| phase_is_well_formed(phase))
    {
        return false;
    }

    fact(baseline, "visible", false)
        && unfocused(baseline, false)
        && fact(after_front, "visible", true)
        && unfocused(after_front, true)
        && fact(visibility, "visible", true)
        && fact(visibility, "occlusionVisible", true)
        && fact(visibility, "onActiveSpace", true)
        && unfocused(visibility, true)
        && fact(after_hide, "visible", false)
        && unfocused(after_hide, false)
        && cleanup_matches_after_hide(cleanup, after_hide)
}

fn unfocused(value: &Value, require_app_hidden: bool) -> bool {
    ["windowFocused", "windowKey", "appActive", "frontmostIsSelf"]
        .iter()
        .all(|key| value[*key].as_bool() == Some(false))
        && (!require_app_hidden || value["appHidden"].as_bool() == Some(false))
}

fn fact(value: &Value, key: &str, expected: bool) -> bool {
    value[key].as_bool() == Some(expected)
}

fn cleanup_matches_after_hide(cleanup: &Value, after_hide: &Value) -> bool {
    [
        "visible",
        "windowFocused",
        "windowKey",
        "appActive",
        "frontmostIsSelf",
    ]
    .iter()
    .all(
        |key| match (cleanup[*key].as_bool(), after_hide[*key].as_bool()) {
            (Some(left), Some(right)) => left == right,
            _ => true,
        },
    )
}

#[cfg(test)]
#[path = "presented_paint_report_tests.rs"]
mod tests;

fn appearance_matches(step: &Value) -> bool {
    let expected = match step["theme"].as_str() {
        Some("light") => Some("light"),
        Some("dark") => Some("dark"),
        Some("system") => step["nativeAppearance"].as_str(),
        _ => None,
    };
    expected.is_some()
        && step["nativeAppearance"].as_str() == expected
        && step["childMediaDark"].as_bool() == Some(expected == Some("dark"))
        && step["mainMediaDark"].as_bool() == Some(expected == Some("dark"))
}

fn presentation_unfocused(value: &Value) -> bool {
    value["visible"].as_bool() == Some(true)
        && value["windowFocused"].as_bool() == Some(false)
        && value["windowKey"].as_bool() == Some(false)
        && value["appActive"].as_bool() == Some(false)
        && value["frontmostIsSelf"].as_bool() == Some(false)
}

pub(super) fn write_report(
    profile: &super::super::profile::Profile,
    report: &Value,
) -> Result<(), &'static str> {
    let path = output_path(profile, REPORT_NAME)?;
    let bytes =
        serde_json::to_vec(report).map_err(|_| "settings-input-presented-paint-hide-failed")?;
    write_private_file(&path, &bytes)
}

pub(super) fn write_snapshot(
    profile: &super::super::profile::Profile,
    filename: &'static str,
    bytes: &[u8],
) -> Result<(), &'static str> {
    if !matches!(
        filename,
        "native-presented-general-light.png" | "native-presented-general-dark.png"
    ) || bytes.is_empty()
        || bytes.len() > 8 * 1024 * 1024
    {
        return Err("settings-input-presented-paint-snapshot-failed");
    }
    write_private_file(&output_path(profile, filename)?, bytes)
}

fn output_path(
    profile: &super::super::profile::Profile,
    filename: &str,
) -> Result<PathBuf, &'static str> {
    if profile.output.file_name().and_then(|name| name.to_str()) != Some("native-report.json")
        || profile.run_id.len() != 32
        || !profile
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("settings-input-presented-paint-identity-invalid");
    }
    let parent = profile
        .output
        .parent()
        .ok_or("settings-input-presented-paint-identity-invalid")?;
    let expected_name = format!("run-{}", profile.run_id);
    if !parent.is_absolute()
        || parent.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
    {
        return Err("settings-input-presented-paint-identity-invalid");
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|_| "settings-input-presented-paint-identity-invalid")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("settings-input-presented-paint-identity-invalid");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return Err("settings-input-presented-paint-identity-invalid");
        }
    }
    let canonical =
        fs::canonicalize(parent).map_err(|_| "settings-input-presented-paint-identity-invalid")?;
    if canonical != parent {
        return Err("settings-input-presented-paint-identity-invalid");
    }
    Ok(parent.join(filename))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "settings-input-presented-paint-snapshot-failed")?;
    if !file
        .metadata()
        .map_err(|_| "settings-input-presented-paint-snapshot-failed")?
        .is_file()
    {
        return Err("settings-input-presented-paint-snapshot-failed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "settings-input-presented-paint-snapshot-failed")?;
    }
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "settings-input-presented-paint-snapshot-failed")
}
