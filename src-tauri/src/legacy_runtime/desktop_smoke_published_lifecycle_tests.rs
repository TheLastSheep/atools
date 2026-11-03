use super::*;

fn fixture() -> (tempfile::TempDir, Lifecycle) {
    let directory = tempfile::tempdir().unwrap();
    let lifecycle = Lifecycle::new(
        directory.path().join("native.json"),
        json!({
        "runId":"owned-run","profile":{"id":"fixed-fixture"},
        "packageSha256":"fixed-sha","executionMode":"original_ui"}),
    );
    (directory, lifecycle)
}
fn report(lifecycle: &Lifecycle) -> Value {
    serde_json::from_slice(&std::fs::read(&lifecycle.path).unwrap()).unwrap()
}
fn successful() -> Value {
    json!({"passed":true,"cleanupComplete":true,"cleanupStatus":"complete",
        "identityValid":true,"taskRunsTerminal":true,"finalRuntimeDrained":true})
}
#[test]
fn early_loop_return_always_leaves_failed_identity_bound_cleanup_unknown_report() {
    let (_directory, lifecycle) = fixture();
    lifecycle.phase("native-configured").unwrap();
    lifecycle.run_event("exit-requested", None);
    lifecycle.run_event("exit", None);
    lifecycle.loop_returned(0);
    assert!(!lifecycle.after_loop(0, true, Value::Null).unwrap());
    let value = report(&lifecycle);
    assert_eq!(value["runId"], "owned-run");
    assert_eq!(value["packageSha256"], "fixed-sha");
    for key in [
        "passed",
        "cleanupComplete",
        "identityValid",
        "taskRunsTerminal",
        "finalRuntimeDrained",
    ] {
        assert_eq!(value[key], false, "{key}");
    }
    assert_eq!(value["cleanupStatus"], "unknown");
    assert_eq!(value["eventLoopExitCode"], 0);
    assert!(value["nativeLifecycle"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["event"] == "exit-requested" && e["code"].is_null()));
}
#[test]
fn report_receipt_interim_records_only_counts_status_and_never_input_or_error_text() {
    let (_directory, lifecycle) = fixture();
    lifecycle.received(
        "frontend-report-received",
        &json!({"passed":true,
        "checks":{"private-check-SENTINEL":true},"query":"RAW_QUERY_SENTINEL",
        "rawOption":{"key":"RAW_OPTION_SENTINEL"},"error":"RAW_ERROR_SENTINEL"}),
    );
    let value = report(&lifecycle);
    assert_eq!(value["passed"], false);
    assert_eq!(value["cleanupComplete"], false);
    assert_eq!(value["nativeLifecycle"]["receipt"]["frontendPassed"], true);
    assert_eq!(value["nativeLifecycle"]["receipt"]["checkCount"], 1);
    assert!(!serde_json::to_string(&value).unwrap().contains("SENTINEL"));
}
#[test]
fn successful_report_is_preserved_through_exit_events_but_nonzero_loop_code_fails() {
    for code in [0, 1] {
        let (_directory, lifecycle) = fixture();
        assert!(lifecycle.finalize(successful()).unwrap());
        lifecycle.run_event("exit-requested", Some(code));
        lifecycle.loop_returned(code);
        assert_eq!(
            lifecycle.after_loop(code, true, Value::Null).unwrap(),
            code == 0
        );
        let value = report(&lifecycle);
        assert_eq!(value["cleanupComplete"], true);
        assert_eq!(value["passed"], code == 0);
        assert_eq!(value["nativeLifecycle"]["events"][1]["code"], code);
    }
}
#[test]
fn late_cleanup_cannot_overwrite_failed_fallback_after_loop_return() {
    let (_directory, lifecycle) = fixture();
    lifecycle.loop_returned(0);
    // Simulate slow cleanup after loop return; late shutdown must already be rejected.
    assert_eq!(
        lifecycle.finalize(successful()).unwrap_err(),
        "PUBLISHED_LIFECYCLE_CLOSED"
    );
    lifecycle.after_loop(0, true, Value::Null).unwrap();
    assert_eq!(report(&lifecycle)["cleanupStatus"], "unknown");
    assert_eq!(report(&lifecycle)["passed"], false);
}
#[test]
fn phase_whitelist_rejects_input_content_and_checkpoint_never_claims_cleanup() {
    let (_directory, lifecycle) = fixture();
    for phase in [
        "RAW_PRIVATE_QUERY_SENTINEL",
        "arbitrary-lowercase-query",
        "",
        &"x".repeat(65),
    ] {
        assert_eq!(
            lifecycle.phase(phase).unwrap_err(),
            "UNREGISTERED_PUBLISHED_PHASE"
        );
    }
    lifecycle.phase("cleanup-dialogs-start").unwrap();
    let value = report(&lifecycle);
    assert_eq!(value["passed"], false);
    assert_eq!(value["cleanupComplete"], false);
    assert!(!serde_json::to_string(&value).unwrap().contains("SENTINEL"));
}
#[test]
fn frontend_can_record_only_fixed_business_or_entry_phases_with_explicit_source() {
    let (_directory, lifecycle) = fixture();
    assert_eq!(FRONTEND_PHASES.len(), 79);
    for phase in FRONTEND_PHASES {
        lifecycle.frontend_phase(phase).unwrap();
    }
    assert!(lifecycle
        .frontend_phase("cleanup-dialogs-complete")
        .is_err());
    let value = report(&lifecycle);
    assert!(value["nativeLifecycle"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["source"] == "frontend"));
    assert_eq!(value["cleanupComplete"], false);
}
#[test]
fn phase_history_and_foreground_records_are_separate_and_bounded() {
    let (_directory, lifecycle) = fixture();
    for _ in 0..MAX_EVENTS + 2 {
        lifecycle.phase("native-setup").unwrap();
    }
    lifecycle.foreground(json!({"events":[{"event":"native-destroyed"}]}));
    let value = report(&lifecycle);
    assert_eq!(
        value["nativeLifecycle"]["events"].as_array().unwrap().len(),
        MAX_EVENTS
    );
    assert_eq!(value["nativeLifecycle"]["overflowed"], true);
    assert_eq!(
        value["nativeLifecycle"]["windowEvents"]["events"][0]["event"],
        "native-destroyed"
    );
}
#[test]
fn exhausted_phase_history_drops_extra_events_without_more_io() {
    let (_directory, lifecycle) = fixture();
    for _ in 0..MAX_EVENTS + 1 {
        lifecycle.phase("native-setup").unwrap();
    }
    std::fs::remove_file(&lifecycle.path).unwrap();
    std::fs::create_dir(&lifecycle.path).unwrap();
    lifecycle.phase("native-setup").unwrap();
    assert_eq!(lifecycle.state.lock().write_failures, 0);
}
#[test]
fn write_failure_is_explicit_and_latched_without_stopping_later_cleanup_records() {
    let (_directory, lifecycle) = fixture();
    std::fs::create_dir(&lifecycle.path).unwrap();
    assert_eq!(
        lifecycle.phase("native-setup").unwrap_err(),
        "REPORT_RENAME_FAILED"
    );
    std::fs::remove_dir(&lifecycle.path).unwrap();
    lifecycle.phase("cleanup-dialogs-complete").unwrap();
    assert!(!lifecycle.finalize(successful()).unwrap());
    assert_eq!(report(&lifecycle)["nativeLifecycle"]["writeFailures"], 1);
    assert_eq!(report(&lifecycle)["passed"], false);
}
#[test]
fn oversize_report_failure_falls_back_to_bounded_failed_report() {
    let (_directory, lifecycle) = fixture();
    let mut value = successful();
    value["oversize"] = json!("x".repeat(MAX_BYTES));
    assert_eq!(lifecycle.finalize(value).unwrap_err(), "REPORT_SIZE_LIMIT");
    lifecycle.loop_returned(1);
    assert!(!lifecycle.after_loop(1, false, Value::Null).unwrap());
    let value = report(&lifecycle);
    assert_eq!(value["temporaryDataRemoved"], false);
    assert_eq!(value["cleanupStatus"], "unknown");
    assert_eq!(value["nativeLifecycle"]["writeFailures"], 1);
}
