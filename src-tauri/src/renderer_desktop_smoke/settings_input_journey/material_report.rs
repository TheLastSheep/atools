use serde_json::{json, Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub(super) const STAGE_KEYS: [&str; 12] = [
    "startup",
    "openAllCommands",
    "mainMatch",
    "mainNoMatch",
    "mainClear",
    "pinSearch",
    "childValueReturn",
    "ownerRotation",
    "closeCleanup",
    "freshReopen",
    "unpinSearch",
    "finalCleanup",
];

pub(super) const OBSERVATION_KEYS: &[&str] = &[
    "supported",
    "installed",
    "mainOwner",
    "settingsLeaseCount",
    "totalOwners",
    "cleanupPending",
    "effectCount",
    "tag",
    "material",
    "blendingMode",
    "state",
    "effectiveAppearance",
];

pub(super) const ERRORS: &[&str] = &[
    "settings-input-material-observation-unavailable",
    "settings-input-material-observation-invalid",
    "settings-input-material-stage-duplicate",
    "settings-input-material-stage-not-observed",
    "settings-input-material-theme-probe-invalid",
    "settings-input-material-theme-initial-invalid",
    "settings-input-material-theme-step-invalid",
    "settings-input-material-theme-restore-invalid",
    "settings-input-material-stop-failed",
    "settings-input-material-cleanup-observation-invalid",
    "settings-input-material-report-write-failed",
];

const THEMES: &[&str] = &["system", "light", "dark"];
const SNAPSHOT_REASONS: &[&str] = &[
    "settings-input-material-snapshot-not-attempted",
    "settings-input-material-snapshot-unsettled",
    "settings-input-material-snapshot-write-failed",
    "settings-input-material-report-write-failed",
    "settings-input-snapshot-requires-macos",
    "settings-input-snapshot-dispatch-failed",
    "settings-input-snapshot-timeout",
    "settings-input-snapshot-callback-interrupted",
    "settings-input-snapshot-native-failed",
    "settings-input-snapshot-dimensions-invalid",
    "settings-input-snapshot-intermediate-too-large",
    "settings-input-snapshot-encoding-failed",
    "settings-input-snapshot-png-invalid",
    "settings-input-snapshot-png-decode-failed",
    "settings-input-snapshot-blank",
];

const SNAPSHOT_KEYS: [&str; 6] = [
    "width",
    "height",
    "pngBytes",
    "sha256",
    "nonUniform",
    "nonTransparent",
];
const SNAPSHOT_READINESS_KEYS: [&str; 8] = [
    "routeGeneral",
    "mediaMatches",
    "menusAbsent",
    "rootTextMatches",
    "sidebarTextMatches",
    "labelTextMatches",
    "framesObserved",
    "settled",
];

pub(super) fn empty(profile: &super::super::profile::Profile) -> Value {
    json!({
        "schemaVersion": 1,
        "journey": "settings-input-material",
        "scope": "hidden-original-vue-native-window-material",
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "passed": false,
        "elapsedMs": 0,
        "stages": [],
        "theme": {
            "passed": false,
            "initial": Value::Null,
            "steps": [],
            "restoration": Value::Null,
        },
        "snapshots": {
            "light": unverified_snapshot("settings-input-material-snapshot-not-attempted"),
            "dark": unverified_snapshot("settings-input-material-snapshot-not-attempted"),
        },
        "paintDiagnostics": super::paint_diagnostics::empty_paint_diagnostics(),
        "cleanup": Value::Null,
        "errors": [],
    })
}

pub(super) fn sanitize_observation(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.len() != OBSERVATION_KEYS.len()
        || OBSERVATION_KEYS
            .iter()
            .any(|key| !object.contains_key(*key))
    {
        return None;
    }
    let mut result = Map::new();
    for key in OBSERVATION_KEYS {
        result.insert((*key).to_owned(), value[*key].clone());
    }
    Some(Value::Object(result))
}

pub(super) fn active_observation_valid(value: &Value, child_expected: bool) -> bool {
    let Some(value) = sanitize_observation(value) else {
        return false;
    };
    let leases = u64::from(child_expected);
    value["supported"].as_bool() == Some(true)
        && value["installed"].as_bool() == Some(true)
        && value["mainOwner"].as_bool() == Some(true)
        && value["settingsLeaseCount"].as_u64() == Some(leases)
        && value["totalOwners"].as_u64() == Some(1 + leases)
        && value["cleanupPending"].as_bool() == Some(false)
        && value["effectCount"].as_u64() == Some(1)
        && value["tag"].as_i64() == Some(91_376_254)
        && value["material"].as_i64() == Some(15)
        && value["blendingMode"].as_i64() == Some(0)
        && value["state"].as_i64() == Some(0)
        && valid_appearance(value["effectiveAppearance"].as_str())
}

pub(super) fn released_observation_valid(value: &Value) -> bool {
    let Some(value) = sanitize_observation(value) else {
        return false;
    };
    value["supported"].as_bool() == Some(true)
        && value["installed"].as_bool() == Some(true)
        && value["mainOwner"].as_bool() == Some(false)
        && value["settingsLeaseCount"].as_u64() == Some(0)
        && value["totalOwners"].as_u64() == Some(0)
        && value["cleanupPending"].as_bool() == Some(false)
        && value["effectCount"].as_u64() == Some(0)
        && value["tag"].is_null()
        && value["material"].is_null()
        && value["blendingMode"].is_null()
        && value["state"].is_null()
        && valid_appearance(value["effectiveAppearance"].as_str())
}

pub(super) fn expected_child(key: &str) -> bool {
    !["startup", "closeCleanup", "finalCleanup"].contains(&key)
}

pub(super) fn push_stage(
    report: &mut Value,
    key: &str,
    elapsed_ms: u64,
    observation: Option<Value>,
    child_draws_background: Option<bool>,
) {
    if !STAGE_KEYS.contains(&key) {
        add_error(report, "settings-input-material-observation-invalid");
        return;
    }
    let duplicate = report["stages"]
        .as_array()
        .expect("material stages are an array")
        .iter()
        .any(|stage| stage["key"].as_str() == Some(key));
    if duplicate {
        add_error(report, "settings-input-material-stage-duplicate");
        return;
    }
    let observation_valid = observation
        .as_ref()
        .is_some_and(|value| active_observation_valid(value, expected_child(key)));
    let background_valid = if expected_child(key) {
        child_draws_background == Some(false)
    } else {
        child_draws_background.is_none()
    };
    let valid = observation_valid && background_valid;
    if observation.is_none() {
        add_error(report, "settings-input-material-observation-unavailable");
    }
    if !valid {
        add_error(report, "settings-input-material-observation-invalid");
    }
    let stage = json!({
        "key": key,
        "elapsedMs": elapsed_ms,
        "passed": valid,
        "actual": observation,
        "childDrawsBackground": child_draws_background,
        "errors": if valid { Vec::<&str>::new() } else { vec!["settings-input-material-observation-invalid"] },
    });
    report["stages"]
        .as_array_mut()
        .expect("material stages are an array")
        .push(stage);
}

pub(super) fn set_initial_theme(report: &mut Value, value: Value) {
    report["theme"]["initial"] = value;
}

pub(super) fn push_theme_step(report: &mut Value, value: Value) {
    if let Some(steps) = report["theme"]["steps"].as_array_mut() {
        steps.push(value);
    } else {
        add_error(report, "settings-input-material-theme-step-invalid");
    }
}

pub(super) fn set_theme_restoration(report: &mut Value, value: Value) {
    report["theme"]["restoration"] = value;
}

pub(super) fn set_theme_passed(report: &mut Value, passed: bool) {
    report["theme"]["passed"] = Value::Bool(passed);
    if !passed {
        add_error(report, "settings-input-material-theme-step-invalid");
    }
}

pub(super) fn set_snapshot(report: &mut Value, theme: &str, value: Value) {
    if matches!(theme, "light" | "dark") {
        report["snapshots"][theme] = value;
    }
}

pub(super) fn set_cleanup(report: &mut Value, value: Value) {
    report["cleanup"] = value;
}

pub(super) fn add_error(report: &mut Value, code: &'static str) {
    if !ERRORS.contains(&code) {
        return;
    }
    let errors = report["errors"]
        .as_array_mut()
        .expect("material errors are an array");
    let value = Value::String(code.to_owned());
    if !errors.contains(&value) {
        errors.push(value);
    }
}

pub(super) fn finalize(report: &mut Value, elapsed_ms: u64) {
    let stages = report["stages"].as_array().cloned().unwrap_or_default();
    let mut ordered = Vec::with_capacity(STAGE_KEYS.len());
    for key in STAGE_KEYS {
        if let Some(stage) = stages
            .iter()
            .find(|stage| stage["key"].as_str() == Some(key))
        {
            ordered.push(stage.clone());
        } else {
            ordered.push(json!({
                "key": key,
                "elapsedMs": 0,
                "passed": false,
                "actual": Value::Null,
                "errors": ["settings-input-material-stage-not-observed"],
            }));
            add_error(report, "settings-input-material-stage-not-observed");
        }
    }
    report["stages"] = Value::Array(ordered);
    report["elapsedMs"] = Value::from(elapsed_ms);
    report["passed"] = Value::Bool(compute_passed(report));
}

pub(super) fn compute_passed(report: &Value) -> bool {
    let stages = match report["stages"].as_array() {
        Some(stages) if stages.len() == STAGE_KEYS.len() => stages,
        _ => return false,
    };
    let stages_ok = stages.iter().zip(STAGE_KEYS).all(|(stage, key)| {
        stage["key"].as_str() == Some(key)
            && stage["passed"].as_bool() == Some(true)
            && stage["elapsedMs"].as_u64().is_some_and(|value| value > 0)
            && active_observation_valid(&stage["actual"], expected_child(key))
            && child_background_valid(key, &stage["childDrawsBackground"])
            && stage["errors"].as_array().is_some_and(Vec::is_empty)
    });
    let theme_ok = report["theme"]["passed"].as_bool() == Some(true);
    let cleanup_ok = report["cleanup"]["passed"].as_bool() == Some(true)
        && report["cleanup"]["stopAcknowledged"].as_bool() == Some(true)
        && released_observation_valid(&report["cleanup"]["actual"]);
    stages_ok && theme_ok && cleanup_ok && report["errors"].as_array().is_some_and(Vec::is_empty)
}

fn child_background_valid(key: &str, value: &Value) -> bool {
    if expected_child(key) {
        value.as_bool() == Some(false)
    } else {
        value.is_null()
    }
}

pub(super) fn unverified_snapshot(reason: &'static str) -> Value {
    unverified_snapshot_with_readiness(reason, None)
}

pub(super) fn unverified_snapshot_with_readiness(
    reason: &'static str,
    readiness: Option<Value>,
) -> Value {
    json!({
        "state": "unverified",
        "filename": Value::Null,
        "reason": if SNAPSHOT_REASONS.contains(&reason) { reason } else { SNAPSHOT_REASONS[0] },
        "evidence": Value::Null,
        "readiness": readiness.filter(valid_snapshot_readiness),
    })
}

pub(super) fn captured_snapshot(
    filename: &'static str,
    evidence: Value,
    readiness: Value,
) -> Value {
    json!({
        "state": "captured",
        "filename": filename,
        "reason": Value::Null,
        "evidence": evidence,
        "readiness": readiness,
    })
}

pub(super) fn snapshot_readiness_settled(value: &Value) -> bool {
    valid_snapshot_readiness(value)
        && value["settled"].as_bool() == Some(true)
        && SNAPSHOT_READINESS_KEYS[..7]
            .iter()
            .all(|key| value[*key].as_bool() == Some(true))
}

pub(super) fn valid_snapshot_readiness(value: &Value) -> bool {
    if !exact_keys(value, &SNAPSHOT_READINESS_KEYS)
        || SNAPSHOT_READINESS_KEYS
            .iter()
            .any(|key| !value[*key].is_boolean())
    {
        return false;
    }
    let settled_facts = SNAPSHOT_READINESS_KEYS[..7]
        .iter()
        .all(|key| value[*key].as_bool() == Some(true));
    value["settled"].as_bool() == Some(settled_facts)
}

pub(super) fn valid_snapshot_evidence(value: &Value, png_bytes: usize, sha256: &str) -> bool {
    exact_keys(value, &SNAPSHOT_KEYS)
        && (16..=4096).contains(&value["width"].as_u64().unwrap_or(0))
        && (16..=4096).contains(&value["height"].as_u64().unwrap_or(0))
        && value["pngBytes"].as_u64() == Some(png_bytes as u64)
        && value["sha256"].as_str() == Some(sha256)
        && value["nonUniform"].as_bool() == Some(true)
        && value["nonTransparent"].as_bool() == Some(true)
}

pub(super) fn write_report(
    profile: &super::super::profile::Profile,
    report: &Value,
) -> Result<(), &'static str> {
    let path = report_path(profile)?;
    write_private_file(
        &path,
        &serde_json::to_vec(report).map_err(|_| "settings-input-material-report-write-failed")?,
        "settings-input-material-report-write-failed",
    )
}

pub(super) fn write_snapshot(
    profile: &super::super::profile::Profile,
    filename: &'static str,
    bytes: &[u8],
) -> Result<(), &'static str> {
    if !matches!(
        filename,
        "native-general-light.png" | "native-general-dark.png"
    ) || bytes.len() > 8 * 1024 * 1024
    {
        return Err("settings-input-material-snapshot-write-failed");
    }
    let parent = report_parent(profile)?;
    write_private_file(
        &parent.join(filename),
        bytes,
        "settings-input-material-snapshot-write-failed",
    )
}

fn report_path(profile: &super::super::profile::Profile) -> Result<PathBuf, &'static str> {
    if profile.output.file_name().and_then(|name| name.to_str()) != Some("native-report.json")
        || profile.run_id.len() != 32
        || !profile
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("settings-input-material-report-write-failed");
    }
    Ok(report_parent(profile)?.join("native-material-report.json"))
}

fn report_parent(profile: &super::super::profile::Profile) -> Result<PathBuf, &'static str> {
    let parent = profile
        .output
        .parent()
        .ok_or("settings-input-material-report-write-failed")?;
    let expected_name = format!("run-{}", profile.run_id);
    if !parent.is_absolute()
        || parent.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
    {
        return Err("settings-input-material-report-write-failed");
    }
    let info =
        fs::symlink_metadata(parent).map_err(|_| "settings-input-material-report-write-failed")?;
    if info.file_type().is_symlink() || !info.is_dir() {
        return Err("settings-input-material-report-write-failed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if info.permissions().mode() & 0o777 != 0o700 {
            return Err("settings-input-material-report-write-failed");
        }
    }
    let canonical =
        fs::canonicalize(parent).map_err(|_| "settings-input-material-report-write-failed")?;
    if canonical != parent {
        return Err("settings-input-material-report-write-failed");
    }
    Ok(parent.to_path_buf())
}

fn write_private_file(path: &Path, bytes: &[u8], error: &'static str) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|_| error)?;
    if !file.metadata().map_err(|_| error)?.is_file() {
        return Err(error);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| error)?;
    }
    file.write_all(bytes).map_err(|_| error)?;
    file.sync_all().map_err(|_| error)
}

fn valid_appearance(value: Option<&str>) -> bool {
    matches!(value, Some("light" | "dark"))
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

#[cfg(test)]
#[path = "material_report_tests.rs"]
mod tests;
