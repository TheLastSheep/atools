//! Async IPC handler dispatch loop owned by the dedicated runtime thread.

use super::IpcCallback;
use crate::bridge::{IpcCall, IpcResult};
use crate::ipc_handler::IpcHandler;
use crossbeam_channel as cbc;
use std::sync::Arc;
use tracing::{debug, error};

// ---------------------------------------------------------------------------
// IPC dispatcher thread
// ---------------------------------------------------------------------------

/// Main loop for the IPC dispatcher thread.
///
/// Owns a tokio runtime and the `dyn IpcHandler`. Receives `IpcCall`s from the
/// worker, calls the handler concurrently, and sends `IpcResult`s back via the
/// callback channel.
pub(super) fn ipc_dispatcher_main(
    ipc_rx: cbc::Receiver<IpcCall>,
    cb_tx: cbc::Sender<IpcCallback>,
    handler: Arc<dyn IpcHandler>,
) {
    debug!("IPC dispatcher thread started");

    // Build a tokio runtime for this thread to drive async handler calls.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            error!("Failed to build tokio runtime for IPC dispatcher: {:?}", e);
            return;
        }
    };

    // Process IPC calls sequentially on the dispatcher thread. The QuickJS
    // worker remains non-blocking because callbacks return over `cb_tx`.
    for call in ipc_rx.iter() {
        let handler = handler.clone();
        let cb_tx = cb_tx.clone();

        let plugin_id = call.plugin_id.clone();
        let req_id = call.req_id;
        let method = call.method;
        let args = call.args;

        rt.block_on(async move {
            let result = handler.handle(&plugin_id, &method, args).await;

            // Convert handler result to bridge IpcResult.
            let ipc_result = match result {
                Ok(value) => IpcResult::success(value),
                Err(e) => IpcResult::error(e.to_string()),
            };

            // Send callback back to worker (non-blocking, unbounded channel).
            let _ = cb_tx.send((plugin_id, req_id, ipc_result));
        });
    }

    debug!("IPC dispatcher thread shutting down");
}
