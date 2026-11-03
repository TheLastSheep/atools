//! QuickJS worker loop and callback delivery.

use super::{IpcCallback, WorkerCommand};
use crate::bridge::IpcCall;
use anyhow::Context as AnyhowContext;
use anyhow::Result;
use crossbeam_channel as cbc;
use rquickjs::{Context, Function, Runtime};
use std::collections::HashMap;
use tracing::{debug, error, warn};

// ---------------------------------------------------------------------------
// Worker thread
// ---------------------------------------------------------------------------

/// Main loop for the QuickJS worker thread.
///
/// Owns the `rquickjs::Runtime` and per-plugin `Context`s. Uses
/// `crossbeam_channel::select!` to process both incoming commands from the
/// async API and returning IPC callbacks from the dispatcher -- without ever
/// blocking on handler results.
pub(super) fn worker_main(
    command_rx: cbc::Receiver<WorkerCommand>,
    ipc_tx: cbc::Sender<IpcCall>,
    callback_rx: cbc::Receiver<IpcCallback>,
) -> Result<()> {
    debug!("QuickJS worker thread started");

    // Create the QuickJS runtime.
    let runtime = Runtime::new().context("Failed to create QuickJS runtime")?;
    runtime.set_memory_limit(256 * 1024 * 1024); // 256 MB
    runtime.set_max_stack_size(1024 * 1024); // 1 MB

    // Map plugin_id -> Context.
    let mut contexts: HashMap<String, Context> = HashMap::new();
    let mut shutdown_requested = false;

    loop {
        // Block until some event is ready: either a new command from the
        // async API or an IPC callback from the dispatcher.
        crossbeam_channel::select! {
            recv(command_rx) -> msg => {
                match msg {
                    Ok(WorkerCommand::CreateContext { plugin_id, response }) => {
                        let r = super::context_ops::create_context_impl(&runtime, &mut contexts, &plugin_id, &ipc_tx);
                        let _ = response.send(r);
                    }
                    Ok(WorkerCommand::InvalidatePlugin { plugin_id, response }) => {
                        contexts.remove(&plugin_id);
                        let _ = response.send(Ok(()));
                    }
                    Ok(WorkerCommand::ExecutePreload { plugin_id, preload_code, response }) => {
                        let r = super::context_ops::execute_preload_impl(&runtime, &mut contexts, &plugin_id, &preload_code, &ipc_tx);
                        let _ = response.send(r);
                    }
                    Ok(WorkerCommand::EmitEvent { plugin_id, event, payload, response }) => {
                        let r = super::context_ops::emit_event_impl(&mut contexts, &plugin_id, &event, &payload);
                        let _ = response.send(r);
                    }
                    Ok(WorkerCommand::CallFunction { plugin_id, fn_name, args, response }) => {
                        let r = super::context_ops::call_function_impl(
                            &runtime,
                            &mut contexts,
                            &plugin_id,
                            &fn_name,
                            &args,
                            &command_rx,
                            &ipc_tx,
                            &callback_rx,
                            &mut shutdown_requested,
                        );
                        let _ = response.send(r);
                    }
                    Ok(WorkerCommand::Shutdown) => {
                        debug!("Received shutdown command");
                        break;
                    }
                    Err(_) => {
                        debug!("Command channel disconnected, shutting down worker");
                        break;
                    }
                }
            }
            recv(callback_rx) -> msg => {
                match msg {
                    Ok(cb) => drain_one_callback(&mut contexts, cb),
                    Err(_) => {
                        debug!("Callback channel disconnected");
                    }
                }
            }
        }

        if shutdown_requested {
            break;
        }

        // After handling a command, opportunistically drain any pending
        // callbacks so that JS Promises are resolved promptly.
        drain_callbacks_nonblocking(&mut contexts, &callback_rx);
    }

    debug!("QuickJS worker thread shutting down");
    Ok(())
}

/// Drain all currently-pending IPC callbacks (non-blocking) and deliver them
/// to the appropriate JS contexts.
fn drain_callbacks_nonblocking(
    contexts: &mut HashMap<String, Context>,
    callback_rx: &cbc::Receiver<IpcCallback>,
) {
    while let Ok(cb) = callback_rx.try_recv() {
        drain_one_callback(contexts, cb);
    }
}

/// Deliver a single IPC callback to the matching JS context by invoking
/// `____resolve____(reqId, json)` or `____reject____(reqId, error)`.
pub(super) fn drain_one_callback(contexts: &mut HashMap<String, Context>, cb: IpcCallback) {
    let (plugin_id, req_id, result) = cb;

    let ctx = match contexts.get(&plugin_id) {
        Some(c) => c,
        None => {
            warn!(
                "IPC callback for unknown plugin {} (req_id={}), dropping",
                plugin_id, req_id
            );
            return;
        }
    };

    let _ = ctx.with(|ctx| -> Result<()> {
        let globals = ctx.globals();

        if result.success {
            let resolve_fn: Function = globals
                .get("____resolve____")
                .context("____resolve____ not found")?;

            let json_str = serde_json::to_string(&result.value).unwrap_or_else(|_| "null".into());
            resolve_fn
                .call::<_, ()>((req_id.to_string(), json_str))
                .map_err(|e| {
                    let msg = format!("Failed to call ____resolve____: {:?}", e);
                    error!("{}", msg);
                    anyhow::anyhow!(msg)
                })?;
        } else {
            let reject_fn: Function = globals
                .get("____reject____")
                .context("____reject____ not found")?;

            let err_str = match result.value.as_str() {
                Some(s) => s.to_string(),
                None => serde_json::to_string(&result.value).unwrap_or_else(|_| "IPC error".into()),
            };
            reject_fn
                .call::<_, ()>((req_id.to_string(), err_str))
                .map_err(|e| {
                    let msg = format!("Failed to call ____reject____: {:?}", e);
                    error!("{}", msg);
                    anyhow::anyhow!(msg)
                })?;
        }

        // Execute any pending microtasks (Promise handlers).
        // Execute any pending microtasks (Promise handlers).
        // Loop until no more jobs are pending.
        while ctx.execute_pending_job() {}

        Ok(())
    });
}

