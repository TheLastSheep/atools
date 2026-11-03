use super::{build, empty_stage, valid_report};
use serde_json::{json, Value};

fn probe_observation() -> Value {
    json!({
        "ready": true,
        "controlUnique": true,
        "enabled": true,
        "disabled": false,
        "indeterminate": false,
        "overviewUnknown": false,
        "hasConflictMessage": false,
        "saveState": "idle"
    })
}

fn profile() -> crate::renderer_desktop_smoke::profile::Profile {
    let run_id = "0123456789abcdef0123456789abcdef";
    crate::renderer_desktop_smoke::profile::Profile::from_args(&[
        "--fixture-root".into(),
        format!("/private/tmp/atools-renderer-settings-input-{run_id}"),
        "--renderer-dist".into(),
        "/tmp/renderer".into(),
        "--output".into(),
        format!("/private/tmp/run-{run_id}/native-report.json"),
        "--auto-clear".into(),
        "never".into(),
        "--run-id".into(),
        run_id.into(),
        "--journey".into(),
        "settings-input".into(),
    ])
    .expect("valid settings-input profile")
}

fn vue(enabled: bool, native: bool, database: bool, marker: Option<bool>, action: bool) -> Value {
    let mut value = empty_stage("vue");
    value["ready"] = json!(true);
    value["controlUnique"] = json!(true);
    value["enabled"] = json!(enabled);
    value["routeGeneral"] = json!(true);
    value["getterEnabled"] = json!(enabled);
    value["nativeEnabled"] = json!(native);
    value["databaseEnabled"] = json!(database);
    value["unknownMarkerPreserved"] = marker.map(Value::Bool).unwrap_or(Value::Null);
    if action {
        value["actionDispatched"] = json!(true);
        value["actionSucceeded"] = json!(true);
    }
    value
}

fn fallback(
    enabled: Option<bool>,
    native: bool,
    database: bool,
    action: bool,
    conflict: bool,
    saved: bool,
) -> Value {
    let mut value = empty_stage("fallback");
    value["ready"] = json!(true);
    value["controlUnique"] = json!(true);
    value["enabled"] = enabled.map(Value::Bool).unwrap_or(Value::Null);
    value["disabled"] = json!(conflict);
    value["indeterminate"] = json!(conflict);
    value["overviewUnknown"] = json!(conflict);
    value["hasConflictMessage"] = json!(conflict);
    value["saveState"] = if saved {
        json!("saved")
    } else {
        json!("unknown")
    };
    value["nativeEnabled"] = json!(native);
    value["databaseEnabled"] = json!(database);
    value["unknownMarkerPreserved"] = json!(true);
    if action {
        value["actionDispatched"] = json!(true);
        value["actionSucceeded"] = json!(true);
    }
    value
}

fn passed_report(profile: &crate::renderer_desktop_smoke::profile::Profile) -> Value {
    let hash = "a".repeat(64);
    let database = json!({
        "beforeSha256": hash,
        "afterSha256": hash,
        "originalLaunchAtLogin": true
    });
    let stages = json!({
        "initial": vue(true, true, false, Some(true), false),
        "fallbackInitial": fallback(Some(true), true, false, false, false, false),
        "fallbackDisabled": fallback(Some(false), false, false, true, false, false),
        "vueAfterDisabled": vue(false, false, false, Some(true), false),
        "vueReenabled": vue(true, true, false, Some(true), true),
        "fallbackFresh": fallback(Some(true), true, false, false, false, false),
        "ordinarySave": fallback(Some(true), true, false, true, false, true),
        "conflict": fallback(None, false, false, true, true, false),
        "reread": fallback(Some(false), false, false, true, false, false),
        "final": vue(true, true, true, None, true),
    });
    let counters = json!({
        "readLaunchAtLogin": 3,
        "changeLaunchAtLogin": 2,
        "saveGeneralSettings": 1,
    });
    let cleanup = json!({
        "fallbackWindowCount": 0,
        "coordinatorTerminal": true,
        "databaseRestored": true,
        "pendingProbes": 0,
    });
    build(profile, &database, &stages, &counters, &cleanup, &[])
}

#[test]
fn empty_partial_report_is_shape_valid_but_not_passed() {
    let profile = profile();
    let report = super::super::login_cross_entry_schema::empty_report(&profile);
    assert!(valid_report(&profile, &report));
    assert_eq!(report["passed"], false);
}

#[test]
fn fallback_close_diagnostics_are_valid_failure_reports() {
    let profile = profile();
    for code in [
        super::super::login_cross_entry_schema::FALLBACK_CLOSE_TIMEOUT,
        super::super::login_cross_entry_schema::FALLBACK_CLOSE_REPLACED,
    ] {
        let mut report = passed_report(&profile);
        report["errors"] = json!([code]);
        report["passed"] = json!(false);
        assert!(
            valid_report(&profile, &report),
            "{code} must be allowlisted"
        );
        assert_eq!(report["passed"], false, "{code} cannot pass the journey");
    }
}

#[test]
fn frozen_cross_entry_facts_recompute_to_pass() {
    let profile = profile();
    let report = passed_report(&profile);
    assert!(valid_report(&profile, &report));
    assert_eq!(report["passed"], true);
}

#[test]
fn native_reread_facts_use_the_shared_stage_gate() {
    let mut reread = json!({
        "surface": "fallback",
        "ready": true,
        "controlUnique": true,
        "enabled": false,
        "disabled": false,
        "indeterminate": false,
        "overviewUnknown": false,
        "hasConflictMessage": false,
        "saveState": "saved",
        "routeGeneral": null,
        "getterEnabled": null,
        "actionDispatched": true,
        "actionSucceeded": true,
        "nativeEnabled": false,
        "databaseEnabled": false,
        "unknownMarkerPreserved": true
    });
    let schema = super::super::login_cross_entry_schema::stage_matches;
    assert!(schema("reread", &reread, None));
    reread["unknownMarkerPreserved"] = json!(false);
    assert!(!schema("reread", &reread, None));
}

#[test]
fn non_applicable_vue_facts_and_database_writes_cannot_be_forged() {
    let profile = profile();
    let mut report = passed_report(&profile);
    report["stages"]["initial"]["overviewUnknown"] = json!(false);
    report["passed"] = json!(true);
    assert!(!valid_report(&profile, &report));

    let mut report = passed_report(&profile);
    report["stages"]["vueReenabled"]["databaseEnabled"] = json!(true);
    report["passed"] = json!(true);
    assert!(!valid_report(&profile, &report));

    let mut report = passed_report(&profile);
    report["stages"]["vueAfterDisabled"]["unknownMarkerPreserved"] = json!(false);
    report["passed"] = json!(true);
    assert!(!valid_report(&profile, &report));
}

#[test]
fn counters_cleanup_and_conflict_action_remain_strict() {
    let profile = profile();
    let mut report = passed_report(&profile);
    report["counters"]["changeLaunchAtLogin"] = json!(1);
    report["passed"] = json!(true);
    assert!(!valid_report(&profile, &report));

    let mut report = passed_report(&profile);
    report["cleanup"]["databaseRestored"] = json!(false);
    report["passed"] = json!(true);
    assert!(!valid_report(&profile, &report));

    let mut report = passed_report(&profile);
    report["stages"]["conflict"]["actionSucceeded"] = json!(false);
    report["passed"] = json!(true);
    assert!(!valid_report(&profile, &report));
}

#[test]
fn action_dispatch_is_observed_and_never_inferred_from_ok() {
    let not_dispatched = json!({
        "ok": false,
        "dispatched": false,
        "reason": "control-unavailable",
        "before": probe_observation(),
        "after": probe_observation()
    });
    assert!(
        super::probe_schema::validate_probe_evidence("fallbackLoginDisable", &not_dispatched)
            .expect("action operation")
            .is_ok()
    );
    let stage = super::probe_schema::stage_observation("fallback", Some(&not_dispatched));
    assert_eq!(stage["actionDispatched"], false);
    assert_eq!(stage["actionSucceeded"], false);

    let uncertain = json!({
        "ok": true,
        "dispatched": null,
        "reason": null,
        "before": probe_observation(),
        "after": probe_observation()
    });
    assert!(
        super::probe_schema::validate_probe_evidence("fallbackLoginDisable", &uncertain)
            .expect("action operation")
            .is_ok()
    );
    let stage = super::probe_schema::stage_observation("fallback", Some(&uncertain));
    assert_eq!(stage["actionDispatched"], Value::Null);
    assert_eq!(stage["actionSucceeded"], false);

    let confirmed = json!({
        "ok": true,
        "dispatched": true,
        "reason": null,
        "before": probe_observation(),
        "after": probe_observation()
    });
    assert!(
        super::probe_schema::validate_probe_evidence("fallbackLoginDisable", &confirmed)
            .expect("action operation")
            .is_ok()
    );
    let stage = super::probe_schema::stage_observation("fallback", Some(&confirmed));
    assert_eq!(stage["actionDispatched"], true);
    assert_eq!(stage["actionSucceeded"], true);

    let placeholder_unknown = json!({
        "ok": true,
        "dispatched": true,
        "reason": null,
        "before": probe_observation(),
        "after": probe_observation(),
        "placeholderObserved": null
    });
    assert!(super::probe_schema::validate_probe_evidence(
        "fallbackLoginSave",
        &placeholder_unknown
    )
    .expect("placeholder action operation")
    .is_ok());
    let stage = super::probe_schema::stage_observation("fallback", Some(&placeholder_unknown));
    assert_eq!(stage["actionDispatched"], true);
    assert_eq!(stage["actionSucceeded"], false);

    let mut placeholder_confirmed = placeholder_unknown;
    placeholder_confirmed["placeholderObserved"] = json!(true);
    assert!(super::probe_schema::validate_probe_evidence(
        "fallbackLoginSave",
        &placeholder_confirmed
    )
    .expect("placeholder action operation")
    .is_ok());
    let stage = super::probe_schema::stage_observation("fallback", Some(&placeholder_confirmed));
    assert_eq!(stage["actionSucceeded"], true);
}
