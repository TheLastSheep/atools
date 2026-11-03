use super::io::{read_stdout_lines, write_message};
use super::node_children::NodeChildrenOwner;
use super::process::{terminate_child, OwnedSidecarChild, SharedCleanupError};
use super::response::{fail_pending, route_response};
use super::startup_diagnostics::{
    StartupPhase, StartupResponseOutcome, StartupTrace, StartupTryWait,
};
use super::supervisor::ProcessCommand;
use super::{SidecarError, SidecarStatus};
use atools_core::PluginRuntimeTransport;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Holds a process-budget slot until the root and its managed children are reaped.
pub(super) struct ProcessReapPermit(Option<OwnedSemaphorePermit>);

impl ProcessReapPermit {
    pub(super) fn new(permit: Option<OwnedSemaphorePermit>) -> Self {
        Self(permit)
    }

    pub(super) fn confirm_reaped(&mut self) {
        drop(self.0.take());
    }
}

impl Drop for ProcessReapPermit {
    fn drop(&mut self) {
        // If this task is aborted or panics while the child may still exist,
        // fail closed rather than reusing the slot without a wait confirmation.
        if let Some(permit) = self.0.take() {
            permit.forget();
        }
    }
}

pub(super) async fn run_process(
    mut child: OwnedSidecarChild,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut command_rx: mpsc::Receiver<ProcessCommand>,
    status_tx: watch::Sender<SidecarStatus>,
    transport: PluginRuntimeTransport,
    diagnostics: Option<Arc<StartupTrace>>,
    mut reap_permit: ProcessReapPermit,
    node_children: Option<NodeChildrenOwner>,
    shared_cleanup_error: SharedCleanupError,
) {
    let (line_tx, mut line_rx) = mpsc::channel(128);
    tokio::spawn(read_stdout_lines(stdout, line_tx, diagnostics.clone()));
    let mut pending = HashMap::<u64, oneshot::Sender<Result<Value, SidecarError>>>::new();
    let mut initialize_request_id = None;
    let mut poll = tokio::time::interval(PROCESS_POLL_INTERVAL);
    if let Some(trace) = &diagnostics {
        trace.record(StartupPhase::SidecarRunning, None, None);
    }
    let _ = status_tx.send(SidecarStatus::Running);

    loop {
        tokio::select! {
            _ = poll.tick() => {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let managed_cleanup = close_node_children(&node_children, &shared_cleanup_error).await;
                        if child.reaped() && managed_cleanup.is_ok() {
                            reap_permit.confirm_reaped();
                        }
                        if child.reaped() {
                            let _ = child
                                .confirm_process_group_gone_after_reap(Duration::from_secs(1))
                                .await;
                        }
                        let cleanup_error = managed_cleanup.err()
                            .or_else(|| child.cleanup_result())
                            .or_else(|| shared_cleanup_error.get());
                        if let Some(trace) = &diagnostics {
                            trace.record_try_wait(StartupTryWait::Exited(status.code()));
                            trace.record_cleanup_completed(child.reaped() && cleanup_error.is_none());
                        }
                        let error = match cleanup_error {
                            Some(cleanup_error) => SidecarError::Crashed(format!(
                                "exit status {status}; managed child or sidecar cleanup failed: {cleanup_error}"
                            )),
                            None => SidecarError::Crashed(format!("exit status {status}")),
                        };
                        fail_pending(&mut pending, error);
                        let _ = status_tx.send(SidecarStatus::Crashed);
                        break;
                    }
                    Ok(None) => {
                        if let Some(trace) = &diagnostics {
                            trace.record_try_wait(StartupTryWait::Running);
                        }
                    }
                    Err(error) => {
                        if let Some(trace) = &diagnostics {
                            trace.record_try_wait(StartupTryWait::Failed);
                        }
                        let _ = terminate_with_diagnostic(
                            &mut child,
                            &diagnostics,
                            &mut reap_permit,
                            &node_children,
                            &shared_cleanup_error,
                        )
                        .await;
                        fail_pending(&mut pending, SidecarError::Crashed(error.to_string()));
                        let _ = status_tx.send(SidecarStatus::Crashed);
                        break;
                    }
                }
            }
            Some(line) = line_rx.recv() => {
                match line {
                    Ok(value) => {
                        if let (Some(trace), Some(id)) = (&diagnostics, value.get("id").and_then(Value::as_u64)) {
                            if initialize_request_id == Some(id) && pending.contains_key(&id) {
                                let outcome = if value.get("result").is_some() {
                                    StartupResponseOutcome::Result
                                } else if value.get("error").is_some() {
                                    StartupResponseOutcome::RemoteError
                                } else {
                                    StartupResponseOutcome::Malformed
                                };
                                trace.record_initialize_response(id, outcome);
                            }
                        }
                        route_response(value, &mut pending)
                    }
                    Err(error) => {
                        fail_pending(&mut pending, error);
                        let _ = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                            &node_children, &shared_cleanup_error).await;
                        let _ = status_tx.send(SidecarStatus::Crashed);
                        break;
                    }
                }
            }
            command = command_rx.recv() => {
                let Some(command) = command else {
                    fail_pending(&mut pending, SidecarError::NotRunning);
                    let cleanup = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                        &node_children, &shared_cleanup_error).await;
                    let status = if cleanup.is_ok() {
                        SidecarStatus::Stopped
                    } else {
                        SidecarStatus::Crashed
                    };
                    let _ = status_tx.send(status);
                    break;
                };
                // Drop can fail to enqueue Shutdown when the bounded queue is
                // full. Once its sender closes, abandon queued work and reap now.
                if command_rx.is_closed() {
                    fail_pending(&mut pending, SidecarError::NotRunning);
                    let cleanup = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                        &node_children, &shared_cleanup_error).await;
                    let status = if cleanup.is_ok() {
                        SidecarStatus::Stopped
                    } else {
                        SidecarStatus::Crashed
                    };
                    let _ = status_tx.send(status);
                    break;
                }
                match command {
                    ProcessCommand::Request { id, method, params, response } => {
                        let message = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params});
                        let bytes_written = match write_message(&mut stdin, &message).await {
                            Ok(bytes_written) => bytes_written,
                            Err(error) => {
                                if method == "initialize" {
                                    if let Some(trace) = &diagnostics {
                                        trace.record_initialize_write_failure();
                                    }
                                }
                                let _ = response.send(Err(error.clone()));
                                fail_pending(&mut pending, error);
                                let _ = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                                    &node_children, &shared_cleanup_error).await;
                                let _ = status_tx.send(SidecarStatus::Crashed);
                                break;
                            }
                        };
                        if method == "initialize" {
                            initialize_request_id = Some(id);
                            if let Some(trace) = &diagnostics {
                                trace.record(
                                    StartupPhase::InitializeRequestWritten,
                                    Some(id),
                                    Some(bytes_written as u64),
                                );
                            }
                        }
                        pending.insert(id, response);
                    }
                    ProcessCommand::Notify { method, params, response } => {
                        let message = json!({"jsonrpc":"2.0", "method":method, "params":params});
                        let result = write_message(&mut stdin, &message).await.map(|_| ());
                        if let Err(error) = &result {
                            fail_pending(&mut pending, error.clone());
                            let _ = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                                &node_children, &shared_cleanup_error).await;
                            let _ = status_tx.send(SidecarStatus::Crashed);
                            let _ = response.send(result);
                            break;
                        }
                        let _ = response.send(result);
                    }
                    ProcessCommand::Cancel { id } => {
                        // This cancels one RPC request only; other work keeps the Node session alive.
                        // Managed children are closed when the whole root process terminates.
                        pending.remove(&id);
                        let message = if transport == PluginRuntimeTransport::McpStdio {
                            json!({"jsonrpc":"2.0", "method":"notifications/cancelled", "params":{"requestId":id, "reason":"ATools request timeout or cancellation"}})
                        } else {
                            json!({"jsonrpc":"2.0", "method":"$/cancelRequest", "params":{"id":id}})
                        };
                        if let Err(error) = write_message(&mut stdin, &message).await {
                            fail_pending(&mut pending, error);
                            let _ = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                                &node_children, &shared_cleanup_error).await;
                            let _ = status_tx.send(SidecarStatus::Crashed);
                            break;
                        }
                    }
                    ProcessCommand::Shutdown { response } => {
                        fail_pending(&mut pending, SidecarError::Cancelled);
                        let result = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                            &node_children, &shared_cleanup_error).await;
                        let status = if result.is_ok() {
                            SidecarStatus::Stopped
                        } else {
                            SidecarStatus::Crashed
                        };
                        let _ = status_tx.send(status);
                        let _ = response.send(result);
                        break;
                    }
                }
            }
            else => {
                let cleanup = terminate_with_diagnostic(&mut child, &diagnostics, &mut reap_permit,
                    &node_children, &shared_cleanup_error).await;
                fail_pending(&mut pending, SidecarError::NotRunning);
                let status = if cleanup.is_ok() {
                    SidecarStatus::Stopped
                } else {
                    SidecarStatus::Crashed
                };
                let _ = status_tx.send(status);
                break;
            }
        }
    }
}

async fn terminate_with_diagnostic(
    child: &mut OwnedSidecarChild,
    diagnostics: &Option<Arc<StartupTrace>>,
    reap_permit: &mut ProcessReapPermit,
    node_children: &Option<NodeChildrenOwner>,
    shared_cleanup_error: &SharedCleanupError,
) -> Result<(), SidecarError> {
    let managed_cleanup = close_node_children(node_children, shared_cleanup_error).await;
    let result = terminate_child(child).await;
    if child.reaped() && managed_cleanup.is_ok() {
        reap_permit.confirm_reaped();
    }
    let cleanup_error = managed_cleanup
        .err()
        .or_else(|| result.as_ref().err().cloned())
        .or_else(|| {
            result
                .as_ref()
                .ok()
                .and_then(|termination| termination.group_error.clone())
        })
        .or_else(|| child.cleanup_result())
        .or_else(|| shared_cleanup_error.get());
    let cleanup_completed = child.reaped() && cleanup_error.is_none();
    if let Some(trace) = diagnostics {
        trace.record_cleanup_completed(cleanup_completed);
    }
    match cleanup_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

async fn close_node_children(
    node_children: &Option<NodeChildrenOwner>,
    shared_cleanup_error: &SharedCleanupError,
) -> Result<(), SidecarError> {
    if let Some(owner) = node_children {
        if let Err(error) = owner.close().await {
            shared_cleanup_error.record(error.clone());
            return Err(error);
        }
    }
    Ok(())
}
