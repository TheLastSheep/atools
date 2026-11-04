use super::startup_diagnostics::{
    classify_initialize_startup_failure, classify_wait_until_running_failure, StartupFailureKind,
    StartupPhase, StartupProcessStatus, StartupTrace, StartupTryWait,
};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

#[test]
fn startup_trace_is_monotonic_bounded_and_contains_only_typed_fields() {
    let trace = StartupTrace::new();
    trace.record_try_wait(StartupTryWait::Running);
    for phase in [
        StartupPhase::SidecarSpawned,
        StartupPhase::SidecarRunning,
        StartupPhase::InitializeRequestWritten,
        StartupPhase::FirstStdoutParsed,
        StartupPhase::InitializeResponseMatched,
    ] {
        trace.record(phase, None, None);
    }

    let snapshot = trace.snapshot(Some(42), StartupProcessStatus::Running, true);
    assert_eq!(snapshot.events.len(), 5);
    assert!(snapshot
        .events
        .windows(2)
        .all(|pair| pair[0].elapsed_ms <= pair[1].elapsed_ms));
    assert!(snapshot.events.len() <= 12);
    let encoded = serde_json::to_vec(&snapshot).unwrap();
    assert!(
        encoded.len() <= 2048,
        "snapshot size {} exceeded cap",
        encoded.len()
    );

    let value: Value = serde_json::from_slice(&encoded).unwrap();
    let serialized = value.to_string();
    for forbidden in ["/private/plugin", "AToolsAuthSecret", "raw stderr", "argv"] {
        assert!(!serialized.contains(forbidden));
    }
}

#[test]
fn cleanup_snapshot_requires_actor_terminal_evidence_even_after_seal() {
    let trace = StartupTrace::new();
    trace.seal();
    let missing = trace.snapshot(None, StartupProcessStatus::Crashed, true);
    assert_eq!(missing.cleanup_completed, None);

    trace.record_cleanup_completed(false);
    let failed = trace.snapshot(None, StartupProcessStatus::Crashed, true);
    assert_eq!(failed.cleanup_completed, Some(false));

    let completed = StartupTrace::new();
    completed.seal();
    completed.record_cleanup_completed(true);
    let verified = completed.snapshot(None, StartupProcessStatus::Crashed, true);
    assert_eq!(verified.cleanup_completed, Some(true));
}

#[test]
fn stderr_digest_counts_raw_bytes_caps_hash_work_and_seals() {
    let trace = StartupTrace::new();
    let input = vec![b'x'; 300 * 1024];
    trace.record_stderr(&input);
    trace.record_try_wait(StartupTryWait::Running);
    let first = trace.snapshot(Some(7), StartupProcessStatus::Running, false);

    assert_eq!(first.stderr_bytes, input.len() as u64);
    assert_eq!(first.stderr_hashed_bytes, 256 * 1024);
    assert!(first.stderr_truncated);
    assert_eq!(first.stderr_sha256.as_deref().unwrap().len(), 64);

    trace.seal();
    let frozen = trace.snapshot(Some(7), StartupProcessStatus::Running, true);
    std::thread::sleep(Duration::from_millis(3));
    trace.record_stderr(b"must not change sealed snapshot");
    trace.record_try_wait(StartupTryWait::Running);
    trace.record(StartupPhase::InitializeCompleted, None, None);
    let sealed = trace.snapshot(Some(7), StartupProcessStatus::Running, true);
    assert_eq!(sealed.events.len(), first.events.len());
    assert_eq!(sealed.stderr_bytes, first.stderr_bytes);
    assert_eq!(sealed.stderr_sha256, first.stderr_sha256);
    assert_eq!(sealed.elapsed_ms, frozen.elapsed_ms);
}

#[test]
fn concurrent_phase_callbacks_are_timestamped_in_append_order() {
    let trace = Arc::new(StartupTrace::new());
    let phases = [
        StartupPhase::NodeResolveStarted,
        StartupPhase::NodeResolved,
        StartupPhase::NodeResolveFailed,
        StartupPhase::SidecarSpawned,
        StartupPhase::SidecarRunning,
        StartupPhase::InitializeRequestWritten,
        StartupPhase::FirstStdoutParsed,
        StartupPhase::InitializeResponseMatched,
        StartupPhase::InitializeCompleted,
    ];
    let workers = phases
        .into_iter()
        .map(|phase| {
            let trace = trace.clone();
            std::thread::spawn(move || trace.record(phase, None, None))
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }

    let snapshot = trace.snapshot(None, StartupProcessStatus::Unavailable, false);
    assert!(snapshot
        .events
        .windows(2)
        .all(|pair| pair[0].elapsed_ms <= pair[1].elapsed_ms));
}

#[test]
fn startup_phase_names_are_stable_and_do_not_expose_arbitrary_strings() {
    assert_eq!(
        serde_json::to_string(&StartupPhase::SidecarRunning).unwrap(),
        "\"sidecar_running\""
    );
    assert_eq!(
        serde_json::to_string(&StartupTryWait::Running).unwrap(),
        "{\"state\":\"running\"}"
    );
}

#[test]
fn selected_runtime_digest_and_node_version_are_strict_and_redacted() {
    use super::startup_diagnostics::{StartupResolutionSource, StartupVersionSource};

    let trace = StartupTrace::new();
    trace.record_selected_executable_path(std::path::Path::new("/private/plugin/node"));
    trace.record_node_version(Some("22.14.0"));
    let snapshot = trace.snapshot(None, StartupProcessStatus::Unavailable, false);
    assert_eq!(
        snapshot.resolution_source,
        Some(StartupResolutionSource::SharedProductionResolver)
    );
    assert_eq!(snapshot.node_version.as_deref(), Some("22.14.0"));
    assert_eq!(
        snapshot.node_version_source,
        StartupVersionSource::InitializeResponse
    );
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialized.contains("/private/plugin/node"));

    let invalid = StartupTrace::new();
    invalid.record_node_version(Some("v22.14.0-secret"));
    let snapshot = invalid.snapshot(None, StartupProcessStatus::Unavailable, false);
    assert_eq!(snapshot.node_version, None);
    assert_eq!(
        snapshot.node_version_source,
        StartupVersionSource::Unavailable
    );
}

#[test]
fn startup_failure_classification_uses_write_attempt_and_terminal_evidence() {
    let trace = StartupTrace::new();
    assert_eq!(
        classify_initialize_startup_failure(
            &crate::sidecar::SidecarError::NotRunning,
            &trace,
            StartupProcessStatus::Crashed,
        ),
        StartupFailureKind::StartupCrashed
    );
    assert_eq!(
        classify_initialize_startup_failure(
            &crate::sidecar::SidecarError::NotRunning,
            &trace,
            StartupProcessStatus::Running,
        ),
        StartupFailureKind::StartupProtocol
    );
    assert_eq!(
        classify_initialize_startup_failure(
            &crate::sidecar::SidecarError::Timeout(1500),
            &trace,
            StartupProcessStatus::Running,
        ),
        StartupFailureKind::InitializeResponse
    );

    assert_eq!(
        classify_wait_until_running_failure(
            &crate::sidecar::SidecarError::Timeout(1500),
            StartupProcessStatus::Starting,
            false,
        ),
        StartupFailureKind::WaitUntilRunning
    );
    assert_eq!(
        classify_wait_until_running_failure(
            &crate::sidecar::SidecarError::NotRunning,
            StartupProcessStatus::Stopped,
            false,
        ),
        StartupFailureKind::StartupProtocol
    );
    assert_eq!(
        classify_wait_until_running_failure(
            &crate::sidecar::SidecarError::NotRunning,
            StartupProcessStatus::Stopped,
            true,
        ),
        StartupFailureKind::StartupCrashed
    );

    trace.record_initialize_write_failure();
    assert_eq!(
        classify_initialize_startup_failure(
            &crate::sidecar::SidecarError::Crashed("pipe closed".into()),
            &trace,
            StartupProcessStatus::Crashed,
        ),
        StartupFailureKind::InitializeWrite
    );
}
