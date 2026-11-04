//! QuickJS-based JavaScript runtime manager for plugin execution
//!
//! Two-thread architecture:
//! - Worker thread: owns the QuickJS Runtime + per-plugin Contexts. Processes commands
//!   from the async API (tokio mpsc) and drains IPC callbacks from the dispatcher.
//! - IPC dispatcher thread: owns a tokio runtime and the `dyn IpcHandler`. Calls handler
//!   methods and sends results back via crossbeam channel.
//!
//! The Promise-based shim (in bridge.rs) means the native `____IPC____` function returns
//! immediately (req_id) -- JS continues running. Callbacks are consumed by the worker's
//! select! loop between JS evals and invoke `____resolve____`/`____reject____` globals.

use std::collections::HashMap;
use std::sync::Arc;
use std::thread;

use anyhow::Context as AnyhowContext;
use anyhow::Result;
use crossbeam_channel as cbc;
use tokio::sync::oneshot;
use tracing::{debug, error, info};

use crate::bridge::{IpcCall, IpcResult};
use crate::ipc_handler::IpcHandler;

/// Commands sent from the async API to the QuickJS worker thread.
enum WorkerCommand {
    /// Load and execute a plugin's preload script.
    ExecutePreload {
        plugin_id: String,
        preload_code: String,
        response: oneshot::Sender<Result<()>>,
    },
    /// Create an empty context for a plugin.
    CreateContext {
        plugin_id: String,
        response: oneshot::Sender<Result<()>>,
    },
    /// Remove one plugin's QuickJS context from the worker.
    InvalidatePlugin {
        plugin_id: String,
        response: oneshot::Sender<Result<()>>,
    },
    /// Emit a lifecycle event to a plugin.
    EmitEvent {
        plugin_id: String,
        event: String,
        payload: String,
        response: oneshot::Sender<Result<()>>,
    },
    /// Call a function in a plugin's context.
    CallFunction {
        plugin_id: String,
        fn_name: String,
        args: String,
        response: oneshot::Sender<Result<String>>,
    },
    /// Shut down the worker thread.
    Shutdown,
}

/// A callback from the IPC dispatcher to be delivered to a JS context.
/// Fields: `(plugin_id, req_id, bridge IpcResult)`.
type IpcCallback = (String, u64, IpcResult);

#[path = "runtime/async_agent_tool_results.rs"]
mod async_agent_tool_results;
#[path = "runtime/context_ops.rs"]
mod context_ops;
#[path = "runtime/ipc_dispatcher.rs"]
mod ipc_dispatcher;
#[path = "runtime/node_preload_bridge.rs"]
mod node_preload_bridge;
#[path = "runtime/worker.rs"]
mod worker;

// Keep the existing invalidation fixture's parent-module import stable.
#[cfg(test)]
use worker::drain_one_callback;

/// QuickJS Runtime Manager.
///
/// Manages a dedicated worker thread that hosts a QuickJS runtime and an IPC
/// dispatcher thread that owns a tokio runtime plus the `dyn IpcHandler`. All
/// JavaScript execution happens on the worker thread to avoid Send/Sync
/// issues with rquickjs contexts.
pub struct JsRuntime {
    command_tx: cbc::Sender<WorkerCommand>,
    worker_handle: Option<thread::JoinHandle<()>>,
    ipc_thread_handle: Option<thread::JoinHandle<()>>,
    node_bridges: Arc<std::sync::RwLock<HashMap<String, crate::node_preload::NodePreloadBridge>>>,
    node_runtime_selector: crate::sidecar::NodeRuntimeSelector,
}

impl Clone for JsRuntime {
    fn clone(&self) -> Self {
        Self {
            command_tx: self.command_tx.clone(),
            worker_handle: None,
            ipc_thread_handle: None,
            node_bridges: self.node_bridges.clone(),
            node_runtime_selector: self.node_runtime_selector.clone(),
        }
    }
}

impl JsRuntime {
    /// Create a new JavaScript runtime backed by the given IPC handler.
    ///
    /// Spawns two OS threads:
    /// 1. An IPC dispatcher thread hosting a tokio runtime and `handler`.
    /// 2. A QuickJS worker thread hosting the JS runtime and per-plugin contexts.
    pub fn new(handler: Arc<dyn IpcHandler>) -> Result<Self> {
        Self::new_with_node_runtime_selector(
            handler,
            crate::sidecar::NodeRuntimeSelector::default(),
        )
    }

    /// Create a runtime with a host-provided selector for Node preload bridges.
    pub fn new_with_node_runtime_selector(
        handler: Arc<dyn IpcHandler>,
        node_runtime_selector: crate::sidecar::NodeRuntimeSelector,
    ) -> Result<Self> {
        let (command_tx, command_rx) = cbc::unbounded::<WorkerCommand>();

        // Crossbeam channels for the IPC pipeline.
        let (ipc_tx, ipc_rx): (cbc::Sender<IpcCall>, cbc::Receiver<IpcCall>) = cbc::unbounded();
        let (cb_tx, cb_rx): (cbc::Sender<IpcCallback>, cbc::Receiver<IpcCallback>) =
            cbc::unbounded();

        // Spawn the IPC dispatcher thread.
        let ipc_thread_handle = thread::Builder::new()
            .name("ipc-dispatcher".into())
            .spawn(move || {
                ipc_dispatcher::ipc_dispatcher_main(ipc_rx, cb_tx, handler);
            })
            .context("Failed to spawn IPC dispatcher thread")?;

        // Spawn the QuickJS worker thread.
        let worker_handle = thread::Builder::new()
            .name("quickjs-worker".into())
            .spawn(move || {
                if let Err(e) = worker::worker_main(command_rx, ipc_tx, cb_rx) {
                    error!("QuickJS worker thread failed: {:?}", e);
                }
            })
            .context("Failed to spawn QuickJS worker thread")?;

        info!("QuickJS runtime initialized (two-thread architecture)");
        Ok(Self {
            command_tx,
            worker_handle: Some(worker_handle),
            ipc_thread_handle: Some(ipc_thread_handle),
            node_bridges: Arc::new(std::sync::RwLock::new(HashMap::new())),
            node_runtime_selector,
        })
    }

    /// Create an empty context for a plugin.
    pub async fn create_context(&self, plugin_id: &str) -> Result<()> {
        let (response_tx, response_rx) = oneshot::channel();

        self.command_tx
            .send(WorkerCommand::CreateContext {
                plugin_id: plugin_id.to_string(),
                response: response_tx,
            })
            .context("Failed to send create_context command to worker")?;

        response_rx
            .await
            .context("Worker thread died before responding")?
    }

    /// Invalidate all runtime state currently held for one plugin.
    ///
    /// Future calls for this ID will receive the normal `Context not found`
    /// error until the caller creates or loads it again. This is idempotent.
    /// Calls that already cloned a Node bridge or are currently executing on
    /// the worker are allowed to finish; callers coordinating an update should
    /// serialize this with new invocations and reloads.
    pub async fn invalidate_plugin(&self, plugin_id: &str) -> Result<()> {
        // Remove the Node adapter first so calls that start after this point
        // cannot bypass the worker's ordered invalidation command.
        self.node_bridges
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(plugin_id);

        let (response_tx, response_rx) = oneshot::channel();
        self.command_tx
            .send(WorkerCommand::InvalidatePlugin {
                plugin_id: plugin_id.to_string(),
                response: response_tx,
            })
            .context("Failed to send invalidate_plugin command to worker")?;

        response_rx
            .await
            .context("Worker thread died before responding")?
    }

    /// Emit a lifecycle event to a plugin.
    pub async fn emit_event(
        &self,
        plugin_id: &str,
        event: &str,
        payload: serde_json::Value,
    ) -> Result<()> {
        let (response_tx, response_rx) = oneshot::channel();
        let payload_str = serde_json::to_string(&payload)?;

        self.command_tx
            .send(WorkerCommand::EmitEvent {
                plugin_id: plugin_id.to_string(),
                event: event.to_string(),
                payload: payload_str,
                response: response_tx,
            })
            .context("Failed to send emit_event command to worker")?;

        response_rx
            .await
            .context("Worker thread died before responding")?
    }

    /// Check if the worker thread is still alive.
    pub fn is_alive(&self) -> bool {
        self.worker_handle
            .as_ref()
            .map(|h| !h.is_finished())
            .unwrap_or(false)
    }
}

impl Drop for JsRuntime {
    fn drop(&mut self) {
        debug!("Dropping JsRuntime, sending shutdown command");
        let _ = self.command_tx.try_send(WorkerCommand::Shutdown);

        if let Some(handle) = self.worker_handle.take() {
            debug!("Waiting for QuickJS worker thread to finish");
            let _ = handle.join();
        }
        if let Some(handle) = self.ipc_thread_handle.take() {
            debug!("Waiting for IPC dispatcher thread to finish");
            let _ = handle.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "runtime/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "runtime_invalidation_tests.rs"]
mod invalidation_tests;
