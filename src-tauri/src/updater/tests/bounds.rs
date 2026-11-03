use super::status::DeferredBackend;
use crate::updater::{UpdateCommandError, UpdateCoordinator, UpdateMetadata};

#[test]
fn status_field_limits_use_utf8_bytes_and_accept_exact_boundaries() {
    let metadata = UpdateMetadata {
        candidate_id: "0".repeat(32),
        prepared: None,
        current_version: "v".repeat(128),
        version: "v".repeat(128),
        date: Some("d".repeat(128)),
        body: Some("b".repeat(48 * 1024)),
    };
    metadata
        .validate_status_fields()
        .expect("all metadata fields at limits");

    let oversized_current_version = UpdateMetadata {
        candidate_id: "0".repeat(32),
        prepared: None,
        current_version: "é".repeat(65),
        version: "1.0.1".into(),
        date: None,
        body: None,
    };
    assert_eq!(
        oversized_current_version
            .validate_status_fields()
            .expect_err("130 UTF-8 bytes exceed currentVersion limit")
            .code,
        "state_response_too_large"
    );
    let mut oversized_version = metadata.clone();
    oversized_version.version.push('v');
    assert_eq!(
        oversized_version
            .validate_status_fields()
            .expect_err("version exceeds field limit")
            .code,
        "state_response_too_large"
    );
    let mut oversized_date = metadata.clone();
    oversized_date.date.as_mut().expect("date").push('d');
    assert_eq!(
        oversized_date
            .validate_status_fields()
            .expect_err("date exceeds field limit")
            .code,
        "state_response_too_large"
    );
    let mut oversized_body = metadata.clone();
    oversized_body.body.as_mut().expect("body").push('b');
    assert_eq!(
        oversized_body
            .validate_status_fields()
            .expect_err("body exceeds field limit")
            .code,
        "state_response_too_large"
    );

    let error = UpdateCommandError::new("c".repeat(128), "m".repeat(8 * 1024));
    error
        .validate_status_fields()
        .expect("error fields at limits");
    let oversized_error = UpdateCommandError::new("é".repeat(65), "m".repeat(8 * 1024));
    assert_eq!(
        oversized_error
            .validate_status_fields()
            .expect_err("error code uses UTF-8 bytes")
            .code,
        "state_response_too_large"
    );
    let oversized_message = UpdateCommandError::new("code", "m".repeat(8 * 1024 + 1));
    assert_eq!(
        oversized_message
            .validate_status_fields()
            .expect_err("message exceeds field limit")
            .code,
        "state_response_too_large"
    );
}

#[tokio::test]
async fn status_rejects_oversized_metadata_fields_before_returning_snapshot() {
    let coordinator = UpdateCoordinator::default();
    let mut backend = DeferredBackend::unblocked();
    backend.update = Some(UpdateMetadata {
        candidate_id: "0".repeat(32),
        prepared: None,
        current_version: format!("1.0.0+{}", "x".repeat(123)),
        version: "1.0.1".into(),
        date: None,
        body: None,
    });
    assert_eq!(
        backend
            .update
            .as_ref()
            .expect("fixture")
            .current_version
            .len(),
        129
    );
    let error = coordinator
        .check(&backend)
        .await
        .expect_err("first candidate rejects oversized metadata");
    assert_eq!(error.code, "state_response_too_large");
    let status = coordinator.status().await.unwrap();
    assert!(status.update.is_none());
    assert!(!status.checked);
}

#[tokio::test]
async fn status_rejects_large_json_after_control_char_escaping() {
    let coordinator = UpdateCoordinator::default();
    let mut backend = DeferredBackend::unblocked();
    backend.update.as_mut().expect("fixture").body = Some("\0".repeat(12 * 1024));
    let error = coordinator
        .check(&backend)
        .await
        .expect_err("first candidate rejects escaped JSON overflow");
    assert_eq!(error.code, "state_response_too_large");
    assert!(coordinator.status().await.unwrap().update.is_none());
}

#[tokio::test]
async fn status_rejects_oversized_last_error_fields() {
    let coordinator = UpdateCoordinator::default();
    let mut backend = DeferredBackend::unblocked();
    backend.check_error = Some(UpdateCommandError::new(
        "check_failed",
        "e".repeat(8 * 1024 + 1),
    ));
    coordinator
        .check(&backend)
        .await
        .expect_err("fixture check fails");

    let status = coordinator
        .status()
        .await
        .expect("invalid provider error must not poison future snapshots");
    assert_eq!(status.last_error.unwrap().code, "internal");
    assert!(coordinator.view().is_ok());
}
