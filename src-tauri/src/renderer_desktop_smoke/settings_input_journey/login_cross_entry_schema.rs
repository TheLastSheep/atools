use serde_json::{json, Value};
use std::path::Path;

#[path = "login_cross_entry_gate.rs"]
mod gate;
#[path = "login_cross_entry_probe_schema.rs"]
mod probe_schema;

#[cfg(test)]
#[path = "login_cross_entry_schema_tests.rs"]
mod tests;

pub(super) const REPORT_NAME: &str = "native-login-cross-entry-report.json";
pub(super) const BASELINE_INVALID: &str = "settings-login-cross-entry-baseline-invalid";
pub(super) const SEED_FAILED: &str = "settings-login-cross-entry-seed-failed";
pub(super) const CHILD_CLOSE_FAILED: &str = "settings-login-cross-entry-child-close-failed";
pub(super) const FALLBACK_OPEN_FAILED: &str = "settings-login-cross-entry-fallback-open-failed";
pub(super) const FALLBACK_PROBE_INVALID: &str = "settings-login-cross-entry-fallback-probe-invalid";
pub(super) const FALLBACK_DISABLE_FAILED: &str =
    "settings-login-cross-entry-fallback-disable-failed";
pub(super) const VUE_READBACK_INVALID: &str = "settings-login-cross-entry-vue-readback-invalid";
pub(super) const VUE_ENABLE_FAILED: &str = "settings-login-cross-entry-vue-enable-failed";
pub(super) const FALLBACK_SAVE_FAILED: &str = "settings-login-cross-entry-fallback-save-failed";
pub(super) const CONFLICT_INVALID: &str = "settings-login-cross-entry-conflict-invalid";
pub(super) const REREAD_INVALID: &str = "settings-login-cross-entry-reread-invalid";
pub(super) const RESTORE_FAILED: &str = "settings-login-cross-entry-restore-failed";
pub(super) const COORDINATOR_TIMEOUT: &str = "settings-login-cross-entry-coordinator-timeout";
pub(super) const CLEANUP_FAILED: &str = "settings-login-cross-entry-cleanup-failed";
pub(super) const FALLBACK_CLOSE_TIMEOUT: &str = "settings-login-cross-entry-fallback-close-timeout";
pub(super) const FALLBACK_CLOSE_REPLACED: &str =
    "settings-login-cross-entry-fallback-close-replaced";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-login-cross-entry-report-write-failed";

const ERRORS: &[&str] = &[
    BASELINE_INVALID,
    SEED_FAILED,
    CHILD_CLOSE_FAILED,
    FALLBACK_OPEN_FAILED,
    FALLBACK_PROBE_INVALID,
    FALLBACK_DISABLE_FAILED,
    VUE_READBACK_INVALID,
    VUE_ENABLE_FAILED,
    FALLBACK_SAVE_FAILED,
    CONFLICT_INVALID,
    REREAD_INVALID,
    RESTORE_FAILED,
    COORDINATOR_TIMEOUT,
    CLEANUP_FAILED,
    FALLBACK_CLOSE_TIMEOUT,
    FALLBACK_CLOSE_REPLACED,
    REPORT_WRITE_FAILED,
];

pub(super) fn fallback_close_error(error: &'static str) -> Option<&'static str> {
    match error {
        "settings-input-window-close-timeout" => Some(FALLBACK_CLOSE_TIMEOUT),
        "settings-input-window-replaced" => Some(FALLBACK_CLOSE_REPLACED),
        _ => None,
    }
}

const STAGES: &[(&str, &str)] = &[
    ("initial", "vue"),
    ("fallbackInitial", "fallback"),
    ("fallbackDisabled", "fallback"),
    ("vueAfterDisabled", "vue"),
    ("vueReenabled", "vue"),
    ("fallbackFresh", "fallback"),
    ("ordinarySave", "fallback"),
    ("conflict", "fallback"),
    ("reread", "fallback"),
    ("final", "vue"),
];

const STAGE_KEYS: &[&str] = &[
    "surface",
    "ready",
    "controlUnique",
    "enabled",
    "disabled",
    "indeterminate",
    "overviewUnknown",
    "hasConflictMessage",
    "saveState",
    "routeGeneral",
    "getterEnabled",
    "actionDispatched",
    "actionSucceeded",
    "nativeEnabled",
    "databaseEnabled",
    "unknownMarkerPreserved",
];

pub(super) fn empty_report(profile: &super::super::profile::Profile) -> Value {
    let mut stages = serde_json::Map::new();
    for (name, surface) in STAGES {
        let mut value = empty_stage(surface);
        value["surface"] = Value::String((*surface).to_owned());
        stages.insert((*name).to_owned(), value);
    }
    json!({
        "schemaVersion": 1,
        "kind": "settings-login-cross-entry",
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "database": {
            "beforeSha256": null,
            "afterSha256": null,
            "originalLaunchAtLogin": null,
        },
        "stages": stages,
        "counters": {
            "readLaunchAtLogin": null,
            "changeLaunchAtLogin": null,
            "saveGeneralSettings": null,
        },
        "cleanup": {
            "fallbackWindowCount": null,
            "coordinatorTerminal": null,
            "databaseRestored": null,
            "pendingProbes": null,
        },
        "errors": [],
        "passed": false,
    })
}

pub(super) fn empty_stage(surface: &str) -> Value {
    json!({
        "surface": surface,
        "ready": null,
        "controlUnique": null,
        "enabled": null,
        "disabled": null,
        "indeterminate": null,
        "overviewUnknown": null,
        "hasConflictMessage": null,
        "saveState": null,
        "routeGeneral": null,
        "getterEnabled": null,
        "actionDispatched": null,
        "actionSucceeded": null,
        "nativeEnabled": null,
        "databaseEnabled": null,
        "unknownMarkerPreserved": null,
    })
}

pub(super) fn build(
    profile: &super::super::profile::Profile,
    database: &Value,
    stages: &Value,
    counters: &Value,
    cleanup: &Value,
    errors: &[&'static str],
) -> Value {
    let mut report = empty_report(profile);
    report["database"] = database.clone();
    report["stages"] = stages.clone();
    report["counters"] = counters.clone();
    report["cleanup"] = cleanup.clone();
    report["errors"] = json!(errors);
    report["passed"] = Value::Bool(business_passed(database, stages, counters, cleanup, errors));
    report
}

pub(super) fn valid_report(profile: &super::super::profile::Profile, report: &Value) -> bool {
    const KEYS: &[&str] = &[
        "schemaVersion",
        "kind",
        "identifier",
        "root",
        "pid",
        "runId",
        "database",
        "stages",
        "counters",
        "cleanup",
        "errors",
        "passed",
    ];
    exact_keys(report, KEYS)
        && report["schemaVersion"].as_u64() == Some(1)
        && report["kind"].as_str() == Some("settings-login-cross-entry")
        && report["identifier"].as_str() == Some(profile.identifier.as_str())
        && report["root"].as_str() == Some(profile.root.to_string_lossy().as_ref())
        && report["pid"].as_u64() == Some(std::process::id() as u64)
        && report["runId"].as_str() == Some(profile.run_id.as_str())
        && valid_profile(profile)
        && valid_database(&report["database"])
        && valid_stages(&report["stages"])
        && valid_counters(&report["counters"])
        && valid_cleanup(&report["cleanup"])
        && valid_errors(&report["errors"])
        && report["passed"].as_bool()
            == Some(gate::business_passed(
                &report["database"],
                &report["stages"],
                &report["counters"],
                &report["cleanup"],
                &report["errors"]
                    .as_array()
                    .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                    .unwrap_or_default(),
            ))
}

pub(super) fn business_passed(
    database: &Value,
    stages: &Value,
    counters: &Value,
    cleanup: &Value,
    errors: &[&str],
) -> bool {
    gate::business_passed(database, stages, counters, cleanup, errors)
}

pub(super) fn stage_matches(
    name: &str,
    stage: &Value,
    original_launch_at_login: Option<bool>,
) -> bool {
    gate::stage_matches(name, stage, original_launch_at_login)
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

pub(super) fn stage_observation(surface: &str, action: Option<&Value>) -> Value {
    probe_schema::stage_observation(surface, action)
}

pub(super) fn valid_database(value: &Value) -> bool {
    exact_keys(
        value,
        &["beforeSha256", "afterSha256", "originalLaunchAtLogin"],
    ) && valid_hash(&value["beforeSha256"])
        && valid_hash(&value["afterSha256"])
        && bool_fact(&value["originalLaunchAtLogin"])
}

pub(super) fn valid_stages(value: &Value) -> bool {
    let keys = STAGES.iter().map(|(key, _)| *key).collect::<Vec<_>>();
    exact_keys(value, &keys)
        && STAGES
            .iter()
            .all(|(name, surface)| valid_stage(&value[*name], surface))
}

fn valid_stage(value: &Value, surface: &str) -> bool {
    exact_keys(value, STAGE_KEYS)
        && value["surface"].as_str() == Some(surface)
        && [
            "ready",
            "controlUnique",
            "enabled",
            "disabled",
            "indeterminate",
            "overviewUnknown",
            "hasConflictMessage",
            "routeGeneral",
            "getterEnabled",
            "actionDispatched",
            "actionSucceeded",
            "nativeEnabled",
            "databaseEnabled",
            "unknownMarkerPreserved",
        ]
        .iter()
        .all(|key| bool_fact(&value[*key]))
        && valid_save_state(&value["saveState"])
}

pub(super) fn valid_counters(value: &Value) -> bool {
    exact_keys(
        value,
        &[
            "readLaunchAtLogin",
            "changeLaunchAtLogin",
            "saveGeneralSettings",
        ],
    ) && [
        "readLaunchAtLogin",
        "changeLaunchAtLogin",
        "saveGeneralSettings",
    ]
    .iter()
    .all(|key| nullable_count(&value[*key]))
}

pub(super) fn valid_cleanup(value: &Value) -> bool {
    exact_keys(
        value,
        &[
            "fallbackWindowCount",
            "coordinatorTerminal",
            "databaseRestored",
            "pendingProbes",
        ],
    ) && nullable_count(&value["fallbackWindowCount"])
        && nullable_bool(&value["coordinatorTerminal"])
        && nullable_bool(&value["databaseRestored"])
        && nullable_count(&value["pendingProbes"])
}

fn valid_errors(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= 32
            && items
                .iter()
                .all(|item| item.as_str().is_some_and(|code| ERRORS.contains(&code)))
            && items
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == items.len()
    })
}

fn valid_profile(profile: &super::super::profile::Profile) -> bool {
    profile.settings_input_journey
        && !profile.builtin_state_journey
        && !profile.main_hotkey_recovery_first
        && !profile.main_hotkey_recovery_second
        && profile.identifier == format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        && profile.root
            == Path::new("/private/tmp")
                .join(format!("atools-renderer-settings-input-{}", profile.run_id))
}

fn valid_hash(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn valid_save_state(value: &Value) -> bool {
    value.is_null()
        || matches!(
            value.as_str(),
            Some("saved" | "saving" | "error" | "unknown")
        )
}

fn bool_fact(value: &Value) -> bool {
    nullable_bool(value)
}

fn nullable_bool(value: &Value) -> bool {
    value.is_null() || value.is_boolean()
}

fn nullable_count(value: &Value) -> bool {
    value.is_null() || value.as_u64().is_some_and(|count| count <= 4096)
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}
