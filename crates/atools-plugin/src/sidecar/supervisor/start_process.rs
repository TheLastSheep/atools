use super::{SidecarError, SidecarLaunchSpec, SidecarProcess, SidecarStatus};
use crate::sidecar::io::capture_stderr;
use crate::sidecar::node_children::{NodeChildrenLaunch, NodeChildrenOwner};
use crate::sidecar::process::{terminate_child, OwnedSidecarChild, SharedCleanupError};
use crate::sidecar::process_loop::{run_process, ProcessReapPermit};
use crate::sidecar::startup_diagnostics::{
    classify_wait_until_running_failure, StartupFailureDiagnostic, StartupFailureKind,
    StartupPhase, StartupProcessStatus, StartupTrace,
};
use std::collections::VecDeque;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, RwLock};

pub(super) async fn spawn(
    spec: SidecarLaunchSpec,
    mut command: Command,
    diagnostics: Option<Arc<StartupTrace>>,
    permit: Option<OwnedSemaphorePermit>,
    node_children_launch: Option<NodeChildrenLaunch>,
) -> Result<Arc<SidecarProcess>, SidecarError> {
    let child = command
        .spawn()
        .map_err(|error| match diagnostics.as_ref() {
            Some(trace) => {
                trace.seal();
                let snapshot = trace.snapshot(None, StartupProcessStatus::Unavailable, false);
                SidecarError::Startup {
                    failure: StartupFailureKind::NodeSpawn,
                    diagnostic: StartupFailureDiagnostic {
                        schema_version: 1,
                        failure: StartupFailureKind::NodeSpawn,
                        snapshot,
                    },
                }
            }
            None => SidecarError::Spawn(error.to_string()),
        })?;
    let node_children_owner = node_children_launch.map(NodeChildrenLaunch::start);
    let mut reap_permit = ProcessReapPermit::new(permit);
    let owned_pid = child.id();
    let cleanup_error = SharedCleanupError::default();
    let mut child = OwnedSidecarChild::new(child, cleanup_error.clone());
    if let Some(trace) = &diagnostics {
        trace.record(StartupPhase::SidecarSpawned, None, None);
    }
    let (stdin, stdout, stderr_pipe) = match child.take_stdio() {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
        _ => {
            let managed_cleanup = close_node_children(&node_children_owner, &cleanup_error).await;
            let termination = terminate_child(&mut child).await;
            let termination_error = termination
                .as_ref()
                .err()
                .cloned()
                .or_else(|| {
                    termination
                        .as_ref()
                        .ok()
                        .and_then(|result| result.group_error.clone())
                })
                .or_else(|| child.cleanup_result());
            if child.reaped() && managed_cleanup.is_ok() && termination_error.is_none() {
                reap_permit.confirm_reaped();
            }
            let cleanup_error = managed_cleanup
                .err()
                .or(termination_error)
                .or_else(|| cleanup_error.get());
            if let Some(trace) = &diagnostics {
                trace.record_cleanup_completed(child.reaped() && cleanup_error.is_none());
            }
            let message = match cleanup_error {
                Some(error) => {
                    format!("child stdio pipe is unavailable; process cleanup failed: {error}")
                }
                None => "child stdio pipe is unavailable".to_string(),
            };
            return Err(SidecarError::Spawn(message));
        }
    };
    let (command_tx, command_rx) = mpsc::channel(128);
    let (status_tx, status_rx) = watch::channel(SidecarStatus::Starting);
    let stderr = Arc::new(RwLock::new(VecDeque::new()));
    let stderr_for_task = stderr.clone();
    let diagnostics_for_stderr = diagnostics.clone();
    tokio::spawn(async move {
        capture_stderr(stderr_pipe, stderr_for_task, diagnostics_for_stderr).await;
    });
    tokio::spawn(run_process(
        child,
        stdin,
        stdout,
        command_rx,
        status_tx,
        spec.transport,
        diagnostics.clone(),
        reap_permit,
        node_children_owner,
        cleanup_error.clone(),
    ));
    let process = Arc::new(SidecarProcess {
        plugin_id: spec.plugin_id,
        transport: spec.transport,
        request_timeout: spec.request_timeout,
        next_id: AtomicU64::new(1),
        command_tx,
        status_rx,
        stderr,
        mcp_initialize_result: tokio::sync::Mutex::new(None),
        cleanup_error,
        owned_pid,
    });
    if let Err(error) = process.wait_until_running(spec.startup_timeout).await {
        if let Some(trace) = diagnostics {
            let status_before_cleanup = process.startup_status();
            trace.seal();
            let _ = process.shutdown().await;
            let failure = classify_wait_until_running_failure(
                &error,
                status_before_cleanup,
                trace.child_termination_observed(),
            );
            let snapshot = trace.snapshot(process.owned_pid, status_before_cleanup, true);
            return Err(SidecarError::Startup {
                failure,
                diagnostic: StartupFailureDiagnostic {
                    schema_version: 1,
                    failure,
                    snapshot,
                },
            });
        }
        return Err(error);
    }
    Ok(process)
}

async fn close_node_children(
    owner: &Option<NodeChildrenOwner>,
    cleanup_error: &SharedCleanupError,
) -> Result<(), SidecarError> {
    if let Some(owner) = owner {
        if let Err(error) = owner.close().await {
            cleanup_error.record(error.clone());
            return Err(error);
        }
    }
    Ok(())
}
