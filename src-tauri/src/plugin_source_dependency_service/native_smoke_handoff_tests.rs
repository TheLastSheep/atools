use super::*;
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};

fn report() -> Value {
    let mut report: Value =
        serde_json::from_str(include_str!("fixtures/native-smoke-success-v61-shape.json"))
            .expect("checked in successful native report shape");
    report["profile"] = json!(super::super::case::CALCULATOR.report_profile);
    report["sourceCaseId"] = json!(super::super::case::CALCULATOR.case_id);
    report
}

#[test]
fn actual_v61_success_shape_accepts_six_tasks_and_one_verified_ui_install() {
    let fixture = report();
    assert_eq!(require_quiescent_success(&fixture), Ok(()));
    let source = fixture.get("sourceProvenance").unwrap();
    let valid = validate_report(
        super::super::case::CALCULATOR,
        &fixture,
        source["sourceRevisionBefore"].as_str().unwrap(),
        source["manifestSha256"].as_str().unwrap(),
        source["inventorySha256"].as_str().unwrap(),
    );
    assert!(valid.is_ok());
}

#[test]
fn calculator_success_report_cannot_be_relabelled_as_tetris() {
    let fixture = report();
    let source = fixture.get("sourceProvenance").unwrap();
    let error = validate_report(
        super::super::case::TETRIS,
        &fixture,
        source["sourceRevisionBefore"].as_str().unwrap(),
        source["manifestSha256"].as_str().unwrap(),
        source["inventorySha256"].as_str().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, "HANDOFF_SOURCE_IDENTITY_MISMATCH");
}

#[test]
fn calculator_success_report_cannot_be_relabelled_as_todo_neo() {
    let fixture = report();
    let source = fixture.get("sourceProvenance").unwrap();
    let error = validate_report(
        super::super::case::TODO_NEO,
        &fixture,
        source["sourceRevisionBefore"].as_str().unwrap(),
        source["manifestSha256"].as_str().unwrap(),
        source["inventorySha256"].as_str().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, "HANDOFF_SOURCE_IDENTITY_MISMATCH");
}

#[test]
fn calculator_handoff_rejects_a_report_with_the_wrong_profile() {
    let mut fixture = report();
    fixture["profile"] = json!(super::super::case::TETRIS.report_profile);
    let source = fixture.get("sourceProvenance").unwrap();
    let error = validate_report(
        super::super::case::CALCULATOR,
        &fixture,
        source["sourceRevisionBefore"].as_str().unwrap(),
        source["manifestSha256"].as_str().unwrap(),
        source["inventorySha256"].as_str().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, "HANDOFF_SOURCE_IDENTITY_MISMATCH");
}

#[test]
fn task_inventory_must_match_run_identity_and_install_semantics() {
    let mut fixture = report();
    fixture["server"]["taskRunRows"][0]["capabilityId"] = json!("convert_ztools_plugin");
    let error = require_quiescent_success(&fixture).unwrap_err();
    assert_eq!(error.code, "HANDOFF_TASK_INVENTORY_INVALID");
    assert_eq!(error.stage, "task_inventory");
}

#[test]
fn conversion_dependency_identity_mismatch_fails_closed() {
    let mut fixture = report();
    fixture["taskRuns"][5]["output"]["dependencyTreeSha256"] = json!("00".repeat(32));
    let source = fixture.get("sourceProvenance").unwrap();
    let error = validate_report(
        super::super::case::CALCULATOR,
        &fixture,
        source["sourceRevisionBefore"].as_str().unwrap(),
        source["manifestSha256"].as_str().unwrap(),
        source["inventorySha256"].as_str().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, "HANDOFF_OUTPUT_CHAIN_MISMATCH");
}

#[test]
fn handoff_failure_is_bounded_and_recovery_root_is_preserved() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let root = PathBuf::from(format!(
        "/private/tmp/atools-batch235-handoff-negative-{suffix}"
    ));
    fs::create_dir(&root).expect("fresh test root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private test root");
    let fixture = Fixture {
        case: super::super::case::CALCULATOR,
        root: root.clone(),
        cache: root.join("app-cache"),
        app_data: root.join("app-data"),
        report: PathBuf::from(format!(
            "/private/tmp/atools-batch235-handoff-report-{suffix}.json"
        )),
        source: PathBuf::from(super::super::case::CALCULATOR.source_root),
        source_manifest_sha256: "00".repeat(32),
        source_inventory_sha256: "00".repeat(32),
        source_bytes: 0,
        source_files: 0,
        source_revision_before: "00".repeat(32),
        retain_converted_handoff: true,
    };
    let mut failed = json!({"passed":true,"server":{"cleanupSafe":true}});
    finalize(&fixture, &mut failed).expect("failure is reported");
    assert_eq!(failed["convertedUiHandoff"]["available"], false);
    assert_eq!(
        failed["convertedUiHandoff"]["failure"]["stage"],
        "quiescence"
    );
    assert_eq!(
        failed["convertedUiHandoff"]["failure"]["code"],
        "HANDOFF_NOT_QUIESCENT"
    );
    assert_eq!(failed["server"]["privateDataPreservedForRecovery"], true);
    assert!(root.exists());
    fs::remove_dir_all(root).expect("test cleanup");
}

#[test]
fn tetris_handoff_failure_is_evidence_only_and_preserves_recovery_root() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let root = PathBuf::from(format!(
        "/private/tmp/atools-batch235-tetris-handoff-negative-{suffix}"
    ));
    fs::create_dir(&root).expect("fresh test root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private test root");
    let case = super::super::case::TETRIS;
    let mut fixture = Fixture {
        case,
        root: root.clone(),
        cache: root.join("app-cache"),
        app_data: root.join("app-data"),
        report: PathBuf::from(format!(
            "/private/tmp/atools-batch235-tetris-report-{suffix}.json"
        )),
        source: PathBuf::from(case.source_root),
        source_manifest_sha256: "00".repeat(32),
        source_inventory_sha256: "00".repeat(32),
        source_bytes: 0,
        source_files: 0,
        source_revision_before: "00".repeat(32),
        retain_converted_handoff: true,
    };
    let mut failed = json!({"passed":true,"server":{"cleanupSafe":true}});
    finalize(&fixture, &mut failed).expect("failure is reported");
    assert_eq!(failed["passed"], false);
    assert_eq!(failed["convertedSourceEvidence"]["available"], false);
    assert_eq!(
        failed["convertedSourceEvidence"]["businessUsabilityVerified"],
        false
    );
    assert_eq!(
        failed["convertedSourceEvidence"]["nativeUiConsumerSupported"],
        false
    );
    assert_eq!(
        failed["convertedSourceEvidence"]["failure"]["stage"],
        "quiescence"
    );
    assert_eq!(
        failed["convertedSourceEvidence"]["failure"]["code"],
        "HANDOFF_NOT_QUIESCENT"
    );
    assert!(failed.get("convertedUiHandoff").is_none());
    assert_eq!(failed["server"]["privateDataPreservedForRecovery"], true);
    assert!(root.exists());
    fs::remove_dir_all(root).expect("test cleanup");

    let recovery_root = PathBuf::from(format!(
        "/private/tmp/atools-batch235-tetris-pipeline-negative-{suffix}"
    ));
    fs::create_dir(&recovery_root).expect("fresh recovery root");
    fs::set_permissions(&recovery_root, fs::Permissions::from_mode(0o700))
        .expect("private recovery root");
    fixture.root = recovery_root.clone();
    let mut pipeline_failed = json!({"passed":false,"server":{"cleanupSafe":false}});
    finalize(&fixture, &mut pipeline_failed).expect("pipeline failure is reported");
    assert_eq!(
        pipeline_failed["convertedSourceEvidence"]["available"],
        false
    );
    assert_eq!(
        pipeline_failed["convertedSourceEvidence"]["businessUsabilityVerified"],
        false
    );
    assert_eq!(
        pipeline_failed["convertedSourceEvidence"]["nativeUiConsumerSupported"],
        false
    );
    assert_eq!(
        pipeline_failed["convertedSourceEvidence"]["failure"]["stage"],
        "pipeline"
    );
    assert!(pipeline_failed.get("convertedUiHandoff").is_none());
    assert_eq!(
        pipeline_failed["server"]["privateDataPreservedForRecovery"],
        true
    );
    assert!(recovery_root.exists());
    fs::remove_dir_all(recovery_root).expect("recovery cleanup");
}

#[test]
fn todo_neo_failure_is_evidence_only_and_preserves_recovery_root() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let root = PathBuf::from(format!(
        "/private/tmp/atools-batch235-todo-handoff-negative-{suffix}"
    ));
    fs::create_dir(&root).expect("fresh test root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private test root");
    let case = super::super::case::TODO_NEO;
    let fixture = Fixture {
        case,
        root: root.clone(),
        cache: root.join("app-cache"),
        app_data: root.join("app-data"),
        report: PathBuf::from(format!(
            "/private/tmp/atools-batch235-todo-report-{suffix}.json"
        )),
        source: PathBuf::from(case.source_root),
        source_manifest_sha256: "00".repeat(32),
        source_inventory_sha256: "00".repeat(32),
        source_bytes: 0,
        source_files: 0,
        source_revision_before: "00".repeat(32),
        retain_converted_handoff: true,
    };
    let mut failed = json!({"passed":true,"server":{"cleanupSafe":true}});
    finalize(&fixture, &mut failed).expect("failure is reported");
    assert_eq!(failed["passed"], false);
    assert_eq!(failed["convertedSourceEvidence"]["available"], false);
    assert_eq!(
        failed["convertedSourceEvidence"]["businessUsabilityVerified"],
        false
    );
    assert_eq!(
        failed["convertedSourceEvidence"]["nativeUiConsumerSupported"],
        false
    );
    assert_eq!(
        failed["convertedSourceEvidence"]["failure"]["code"],
        "HANDOFF_NOT_QUIESCENT"
    );
    assert!(failed.get("convertedUiHandoff").is_none());
    assert_eq!(failed["server"]["privateDataPreservedForRecovery"], true);
    assert!(root.exists());
    fs::remove_dir_all(root).expect("test cleanup");
}
