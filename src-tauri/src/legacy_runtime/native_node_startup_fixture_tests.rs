use super::*;
use serde_json::json;

fn profile(case_id: &str, plugin_id: &str) -> Value {
    json!({"caseId":case_id,"id":plugin_id,"runtime":"node"})
}

fn deepread_profile() -> Value {
    crate::plugin_source_build::converted_source_registry::profile("converted-deepread-source")
        .unwrap()
}

fn deepread_identity() -> StartupDiagnosticHandoffIdentity {
    let pins =
        crate::plugin_source_build::converted_source_registry::handoff("converted-deepread-source")
            .unwrap();
    StartupDiagnosticHandoffIdentity {
        case_id: "converted-deepread-source".into(),
        source_case_id: pins["sourceCaseId"].as_str().unwrap().into(),
        plugin_id: "deepread".into(),
        plugin_version: "1.1.2".into(),
        artifact_kind: pins["artifactKind"].as_str().unwrap().into(),
        handoff_status: pins["handoffStatus"].as_str().unwrap().into(),
        native_ui_consumer_supported: pins["nativeUiConsumerSupported"].as_bool().unwrap(),
        manifest_sha256: pins["manifestSha256"].as_str().unwrap().into(),
        installed_package_tree_sha256: pins["installedPackageTreeSha256"].as_str().unwrap().into(),
    }
}

#[test]
fn converted_deepread_diagnostics_require_the_exact_reviewed_handoff_identity() {
    let run_id = uuid::Uuid::new_v4().to_string();
    let profile = deepread_profile();
    let identity = deepread_identity();
    let configured =
        NativeNodeStartupFixture::new_converted_deepread(&profile, &run_id, Some(&identity));
    let report = configured.report(&Database::in_memory().unwrap()).unwrap();
    assert_eq!(report["enabled"], true);
    assert_eq!(report["caseId"], "converted-deepread-source");
    assert_eq!(report["pluginId"], "deepread");
    assert_eq!(report["captureStatus"], "not_exercised");
    assert_eq!(report["associationVerified"], false);
    assert!(!report.to_string().contains("/private/"));

    assert!(
        NativeNodeStartupFixture::new_converted_deepread(&profile, &run_id, None)
            .report(&Database::in_memory().unwrap())
            .is_none()
    );
    let mut wrong = deepread_identity();
    wrong.case_id = "converted-todo-neo-source".into();
    assert!(
        NativeNodeStartupFixture::new_converted_deepread(&profile, &run_id, Some(&wrong))
            .report(&Database::in_memory().unwrap())
            .is_none()
    );
    wrong = deepread_identity();
    let replacement = if wrong.manifest_sha256.starts_with('0') {
        "1"
    } else {
        "0"
    };
    wrong.manifest_sha256.replace_range(..1, replacement);
    assert!(
        NativeNodeStartupFixture::new_converted_deepread(&profile, &run_id, Some(&wrong))
            .report(&Database::in_memory().unwrap())
            .is_none()
    );
    let mut wrong_profile = profile.clone();
    wrong_profile["title"] = json!("other title");
    assert!(NativeNodeStartupFixture::new_converted_deepread(
        &wrong_profile,
        &run_id,
        Some(&identity)
    )
    .report(&Database::in_memory().unwrap())
    .is_none());
    assert!(NativeNodeStartupFixture::new_converted_deepread(
        &profile,
        "not-a-run-uuid",
        Some(&identity)
    )
    .report(&Database::in_memory().unwrap())
    .is_none());
}

#[test]
fn only_explicit_registered_editor_fixture_receives_scoped_permit() {
    let app_run = uuid::Uuid::new_v4().to_string();
    let owner = format!("window:main:{}", uuid::Uuid::new_v4());
    let fixture = Arc::new(NativeNodeStartupFixture::new(
        &profile("local-plain-text", "plain-text"),
        &app_run,
        true,
        false,
    ));
    assert!(fixture.permit("plain-text", &owner).is_some());
    assert!(fixture.permit("other-plugin", &owner).is_none());
    assert!(fixture
        .permit("plain-text", "window:settings:instance")
        .is_none());

    let production = NativeNodeStartupFixture::new(
        &profile("local-plain-text", "plain-text"),
        &app_run,
        false,
        false,
    );
    assert!(production.report(&Database::in_memory().unwrap()).is_none());
    assert!(Arc::new(production).permit("plain-text", &owner).is_none());

    let worker = NativeNodeStartupFixture::new(
        &profile("local-json-editor", "json-editor"),
        &app_run,
        true,
        true,
    );
    assert!(Arc::new(worker).permit("json-editor", &owner).is_none());

    let mismatched_profile = Arc::new(NativeNodeStartupFixture::new(
        &profile("local-plain-text", "json-editor"),
        &app_run,
        true,
        false,
    ));
    assert!(mismatched_profile.permit("json-editor", &owner).is_none());
}

#[test]
fn enabled_fixture_without_a_node_startup_capture_is_not_reported_as_verified() {
    let fixture = NativeNodeStartupFixture::new(
        &profile("local-plain-text", "plain-text"),
        &uuid::Uuid::new_v4().to_string(),
        true,
        false,
    );
    let report = fixture.report(&Database::in_memory().unwrap()).unwrap();
    assert_eq!(report["captureStatus"], "not_exercised");
    assert_eq!(report["associationVerified"], false);
}

#[test]
fn dropping_an_unsettled_authorized_attempt_marks_capture_incomplete() {
    let fixture = Arc::new(NativeNodeStartupFixture::new(
        &profile("local-plain-text", "plain-text"),
        &uuid::Uuid::new_v4().to_string(),
        true,
        false,
    ));
    let permit = fixture
        .permit(
            "plain-text",
            &format!("window:main:{}", uuid::Uuid::new_v4()),
        )
        .unwrap();
    drop(permit.begin_attempt());
    let report = fixture.report(&Database::in_memory().unwrap()).unwrap();
    assert_eq!(report["captureComplete"], false);
    assert_eq!(report["captureStatus"], "incomplete");
    assert_eq!(report["associationVerified"], false);
}

#[test]
fn rejected_success_capture_marks_report_incomplete() {
    let app_run = uuid::Uuid::new_v4().to_string();
    let owner = format!("window:main:{}", uuid::Uuid::new_v4());
    let fixture = Arc::new(NativeNodeStartupFixture::new(
        &profile("local-plain-text", "plain-text"),
        &app_run,
        true,
        false,
    ));
    let permit = fixture.permit("plain-text", &owner).unwrap();
    let snapshot = StartupDiagnosticSnapshot {
        schema_version: 1,
        elapsed_ms: 2,
        events: Vec::new(),
        resolution_source: None,
        selected_executable_path_sha256: None,
        node_version: None,
        node_version_source: atools_plugin::sidecar::StartupVersionSource::Unavailable,
        owned_pid: None,
        sidecar_status: atools_plugin::sidecar::StartupProcessStatus::Unavailable,
        last_try_wait: atools_plugin::sidecar::StartupTryWait::Unobserved,
        last_try_wait_elapsed_ms: None,
        stderr_bytes: 0,
        stderr_hashed_bytes: 0,
        stderr_sha256: None,
        stderr_truncated: false,
        stdout_read: Default::default(),
        cleanup_required: false,
        cleanup_completed: None,
    };
    let task_run_id = atools_core::task_run::TaskRun::new(
        "plugin.plain-text.legacy_node",
        atools_core::task_run::TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"open"}),
    )
    .id;
    let raw_uuid = task_run_id.strip_prefix("run-").unwrap();
    let wrong_prefix = format!("task-{raw_uuid}");
    assert!(is_task_run_id(&task_run_id));
    assert!(!is_task_run_id(raw_uuid));
    assert!(!is_task_run_id(&wrong_prefix));
    assert!(!permit.record_success(raw_uuid, &snapshot));
    assert!(!permit.record_success(&wrong_prefix, &snapshot));
    for _ in 0..=MAX_SUCCESS_SNAPSHOTS {
        let _ = permit.record_success(&task_run_id, &snapshot);
    }
    let report = fixture.report(&Database::in_memory().unwrap()).unwrap();
    assert_eq!(report["captureComplete"], false);
    assert_eq!(report["captureStatus"], "incomplete");
    assert_eq!(report["associationVerified"], false);
}
