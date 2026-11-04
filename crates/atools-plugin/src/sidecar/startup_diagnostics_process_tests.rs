use super::startup_diagnostics::{
    classify_initialize_startup_failure, StartupFailureKind, StartupPhase, StartupProcessStatus,
    StartupTrace,
};
use super::SidecarProcess;
use crate::sidecar::{SidecarLaunchSpec, SidecarStatus};
use atools_core::{PluginRuntimeKind, PluginRuntimeTransport};
use serde_json::json;
use std::collections::BTreeMap;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

#[cfg(unix)]
#[tokio::test]
async fn real_sidecar_callbacks_record_initialize_write_parse_and_matching_response() {
    let temp = tempfile::tempdir().unwrap();
    let worker = temp.path().join("worker.sh");
    std::fs::write(
        &worker,
        "#!/bin/sh\nIFS= read -r request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}'\nsleep 30\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&worker).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&worker, permissions).unwrap();
    let spec = SidecarLaunchSpec {
        plugin_id: "diag-fixture".into(),
        plugin_dir: temp.path().to_path_buf(),
        entry: PathBuf::from(&worker),
        runtime: PluginRuntimeKind::Rust,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: Vec::new(),
        env: BTreeMap::new(),
        startup_timeout: Duration::from_secs(1),
        request_timeout: Duration::from_secs(1),
    };
    let command = spec
        .command_with_node_selector(
            &super::NodeRuntimeSelector::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let trace = Arc::new(StartupTrace::new());
    let process =
        SidecarProcess::spawn_with_command_and_diagnostics(spec, command, Some(trace.clone()))
            .await
            .unwrap();
    let result = process
        .request_with_timeout("initialize", json!({}), Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(result["protocolVersion"], 1);
    trace.record(StartupPhase::InitializeCompleted, None, None);
    trace.seal();
    let snapshot = trace.snapshot(process.owned_pid, StartupProcessStatus::Running, false);
    let phases = snapshot
        .events
        .iter()
        .map(|event| event.phase)
        .collect::<Vec<_>>();
    assert!(phases.contains(&StartupPhase::SidecarSpawned));
    assert!(phases.contains(&StartupPhase::SidecarRunning));
    assert!(phases.contains(&StartupPhase::InitializeRequestWritten));
    assert!(phases.contains(&StartupPhase::FirstStdoutParsed));
    assert!(phases.contains(&StartupPhase::InitializeResponseMatched));
    assert_eq!(phases.last(), Some(&StartupPhase::InitializeCompleted));
    assert!(snapshot.events.iter().any(|event| {
        event.phase == StartupPhase::InitializeResponseMatched && event.request_id == Some(1)
    }));
    assert_eq!(process.status(), SidecarStatus::Running);
    process.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn protocol_failure_reports_cleanup_only_after_child_is_reaped() {
    let temp = tempfile::tempdir().unwrap();
    let worker = temp.path().join("worker.sh");
    std::fs::write(
        &worker,
        "#!/bin/sh\nIFS= read -r request\nprintf 'not-json\\n'\nsleep 30\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&worker).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&worker, permissions).unwrap();
    let spec = SidecarLaunchSpec {
        plugin_id: "diag-failure-fixture".into(),
        plugin_dir: temp.path().to_path_buf(),
        entry: PathBuf::from(&worker),
        runtime: PluginRuntimeKind::Rust,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: Vec::new(),
        env: BTreeMap::new(),
        startup_timeout: Duration::from_secs(1),
        request_timeout: Duration::from_secs(1),
    };
    let command = spec
        .command_with_node_selector(
            &super::NodeRuntimeSelector::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let trace = Arc::new(StartupTrace::new());
    let process =
        SidecarProcess::spawn_with_command_and_diagnostics(spec, command, Some(trace.clone()))
            .await
            .unwrap();
    let result = process
        .request_with_timeout("initialize", json!({}), Duration::from_secs(1))
        .await;
    assert!(matches!(
        result,
        Err(crate::sidecar::SidecarError::Protocol(_))
    ));

    tokio::time::timeout(Duration::from_secs(1), async {
        while process.status() == SidecarStatus::Running {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("actor should finish terminate_child and publish terminal status");
    trace.seal();
    let snapshot = trace.snapshot(process.owned_pid, StartupProcessStatus::Crashed, true);
    assert_eq!(snapshot.cleanup_completed, Some(true));
}

#[cfg(unix)]
#[tokio::test]
async fn closed_child_stdin_reports_initialize_write_failure_and_reaped_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let worker = temp.path().join("worker.sh");
    std::fs::write(
        &worker,
        "#!/bin/sh\nexec 0<&-\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"method\":\"fixture/ready\"}'\nsleep 30\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&worker).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&worker, permissions).unwrap();
    let spec = SidecarLaunchSpec {
        plugin_id: "diag-write-failure-fixture".into(),
        plugin_dir: temp.path().to_path_buf(),
        entry: PathBuf::from(&worker),
        runtime: PluginRuntimeKind::Rust,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: Vec::new(),
        env: BTreeMap::new(),
        startup_timeout: Duration::from_secs(1),
        request_timeout: Duration::from_secs(1),
    };
    let command = spec
        .command_with_node_selector(
            &super::NodeRuntimeSelector::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let trace = Arc::new(StartupTrace::new());
    let process =
        SidecarProcess::spawn_with_command_and_diagnostics(spec, command, Some(trace.clone()))
            .await
            .unwrap();

    tokio::time::timeout(Duration::from_secs(1), async {
        while !trace.has_phase(StartupPhase::FirstStdoutParsed) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("fixed child ready notification must be parsed before the request");
    let result = process
        .request_with_timeout("initialize", json!({}), Duration::from_secs(1))
        .await;
    assert!(matches!(
        &result,
        Err(crate::sidecar::SidecarError::Crashed(_))
    ));

    tokio::time::timeout(Duration::from_secs(1), async {
        while process.status() == SidecarStatus::Running {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("actor should finish cleanup and publish terminal status");
    trace.seal();
    let snapshot = trace.snapshot(process.owned_pid, StartupProcessStatus::Crashed, true);
    assert!(trace.has_phase(StartupPhase::FirstStdoutParsed));
    assert!(!trace.has_phase(StartupPhase::InitializeRequestWritten));
    assert!(trace.initialize_write_failed());
    assert_eq!(
        classify_initialize_startup_failure(&result.unwrap_err(), &trace, process.startup_status(),),
        super::startup_diagnostics::StartupFailureKind::InitializeWrite
    );
    assert_eq!(snapshot.cleanup_completed, Some(true));
}

#[cfg(unix)]
#[tokio::test]
async fn exited_child_before_initialize_is_crashed_without_a_write_failure_marker() {
    use super::startup_diagnostics::StartupFailureKind;

    let temp = tempfile::tempdir().unwrap();
    let worker = temp.path().join("worker.sh");
    std::fs::write(&worker, "#!/bin/sh\nexit 17\n").unwrap();
    let mut permissions = std::fs::metadata(&worker).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&worker, permissions).unwrap();
    let spec = SidecarLaunchSpec {
        plugin_id: "diag-early-exit-fixture".into(),
        plugin_dir: temp.path().to_path_buf(),
        entry: PathBuf::from(&worker),
        runtime: PluginRuntimeKind::Rust,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: Vec::new(),
        env: BTreeMap::new(),
        startup_timeout: Duration::from_secs(1),
        request_timeout: Duration::from_secs(1),
    };
    let command = spec
        .command_with_node_selector(
            &super::NodeRuntimeSelector::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let trace = Arc::new(StartupTrace::new());
    let process =
        SidecarProcess::spawn_with_command_and_diagnostics(spec, command, Some(trace.clone()))
            .await;

    match process {
        Err(crate::sidecar::SidecarError::Startup {
            failure,
            diagnostic,
        }) => {
            assert_eq!(failure, StartupFailureKind::StartupCrashed);
            assert!(diagnostic
                .snapshot
                .events
                .iter()
                .any(|event| event.phase == StartupPhase::SidecarRunning));
            assert!(!diagnostic
                .snapshot
                .events
                .iter()
                .any(|event| { event.phase == StartupPhase::InitializeRequestWritten }));
        }
        Err(error) => panic!("unexpected startup error: {error}"),
        Ok(process) => {
            tokio::time::timeout(Duration::from_secs(1), async {
                while process.status() == SidecarStatus::Running {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the child exits before an initialize request is sent");
            let error = process
                .request_with_timeout("initialize", json!({}), Duration::from_millis(20))
                .await
                .unwrap_err();
            assert!(!trace.initialize_write_failed());
            assert!(!trace.has_phase(StartupPhase::InitializeRequestWritten));
            assert_eq!(
                classify_initialize_startup_failure(&error, &trace, process.startup_status(),),
                StartupFailureKind::StartupCrashed
            );
        }
    }
}

#[cfg(feature = "native-smoke")]
#[tokio::test]
async fn fixture_diagnostics_rejects_missing_host_authorization_before_path_resolution() {
    let error = crate::legacy_node::LegacyNodeSession::start_with_diagnostics(
        "unauthorized-diagnostic-fixture",
        std::path::Path::new("/path/that/must/not/be-read"),
        std::path::Path::new("/also/missing"),
        false,
    )
    .await;
    assert!(matches!(
        error,
        Err(crate::sidecar::SidecarError::InvalidEntry(_))
    ));
}
