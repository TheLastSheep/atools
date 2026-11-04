//! QuickJS context creation and synchronous plugin operations.

use super::{IpcCallback, WorkerCommand};
use crate::bridge::{IpcCall, SHIM_JS};
use anyhow::Context as AnyhowContext;
use anyhow::Result;
use crossbeam_channel as cbc;
use rquickjs::{Context, Function, Runtime, Value as JsValue};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::{debug, error, info, warn};

/// Request IDs outlive individual contexts to avoid collisions with pending calls.
static NEXT_IPC_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------
// Context operations (run on the worker thread)
// ---------------------------------------------------------------------------

/// Create a new JS context for a plugin and inject the IPC bridge + shim.
pub(super) fn create_context_impl(
    runtime: &Runtime,
    contexts: &mut HashMap<String, Context>,
    plugin_id: &str,
    ipc_tx: &cbc::Sender<IpcCall>,
) -> Result<()> {
    if contexts.contains_key(plugin_id) {
        warn!("Context already exists for plugin {}", plugin_id);
        return Ok(());
    }

    debug!("Creating context for plugin {}", plugin_id);

    let ctx = Context::full(runtime).context("Failed to create QuickJS context")?;

    ctx.with(|ctx| -> Result<()> {
        let globals = ctx.globals();

        // Store plugin ID in global scope.
        globals
            .set("____pluginId____", plugin_id)
            .context("Failed to set ____pluginId____")?;

        // Build the native ____IPC____ function.
        //
        // Non-blocking: enqueues an IpcCall to the dispatcher via crossbeam
        // and returns the req_id as a string. The JS shim wraps the call in
        // a Promise that will be resolved asynchronously by the worker's
        // callback-drain loop.
        let ipc_tx_clone: cbc::Sender<IpcCall> = ipc_tx.clone();
        let plugin_id_owned = plugin_id.to_string();
        let ipc_fn = Function::new(
            ctx.clone(),
            move |_ctx: rquickjs::Ctx,
                  method: String,
                  args_json: String|
                  -> rquickjs::Result<String> {
                debug!(
                    "IPC call from JS: method={}, args={}",
                    method,
                    if args_json.len() > 100 {
                        format!("{}...", &args_json[..100])
                    } else {
                        args_json.clone()
                    }
                );

                // Parse args; fall back to wrapping original string on failure.
                let args: Vec<serde_json::Value> = serde_json::from_str(&args_json)
                    .unwrap_or_else(|_| vec![serde_json::Value::String(args_json.clone())]);

                // Generate unique request ID.
                let req_id = NEXT_IPC_REQUEST_ID
                    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                        current.checked_add(1)
                    })
                    .map_err(|_| {
                        rquickjs::Error::new_from_js_message(
                            "string",
                            "object",
                            "IPC request ID space exhausted",
                        )
                    })?;

                let call = IpcCall {
                    plugin_id: plugin_id_owned.clone(),
                    method,
                    args,
                    req_id,
                };

                // Non-blocking send into unbounded crossbeam channel.
                ipc_tx_clone.send(call).map_err(|_| {
                    rquickjs::Error::new_from_js_message(
                        "string",
                        "object",
                        "IPC dispatcher channel closed",
                    )
                })?;

                // Return req_id as string immediately -- never blocks on result.
                Ok(req_id.to_string())
            },
        )
        .context("Failed to create IPC function")?;

        globals
            .set("____IPC____", ipc_fn)
            .context("Failed to set ____IPC____")?;

        // Inject the utools shim (Promise-based IPC infrastructure).
        ctx.eval::<(), _>(SHIM_JS).map_err(|e| {
            let msg = format!("Failed to inject shim: {:?}", e);
            error!("{}", msg);
            anyhow::anyhow!(msg)
        })?;

        Ok(())
    })?;

    contexts.insert(plugin_id.to_string(), ctx);
    info!("Created context for plugin {}", plugin_id);
    Ok(())
}

/// Execute a plugin's preload script in its context.
pub(super) fn execute_preload_impl(
    runtime: &Runtime,
    contexts: &mut HashMap<String, Context>,
    plugin_id: &str,
    preload_code: &str,
    ipc_tx: &cbc::Sender<IpcCall>,
) -> Result<()> {
    // Ensure context exists.
    if !contexts.contains_key(plugin_id) {
        create_context_impl(runtime, contexts, plugin_id, ipc_tx)?;
    }

    debug!("Executing preload for plugin {}", plugin_id);

    let ctx = contexts.get(plugin_id).context("Context not found")?;

    ctx.with(|ctx| -> Result<()> {
        ctx.eval::<(), _>(preload_code).map_err(|e| {
            let msg = format!("Failed to execute preload script: {:?}", e);
            error!("{}", msg);
            anyhow::anyhow!(msg)
        })?;
        Ok(())
    })?;

    info!("Executed preload for plugin {}", plugin_id);
    Ok(())
}

/// Emit a lifecycle event to a plugin by calling `____emit____(event, payload)`.
pub(super) fn emit_event_impl(
    contexts: &mut HashMap<String, Context>,
    plugin_id: &str,
    event: &str,
    payload: &str,
) -> Result<()> {
    debug!(
        "Emitting event {} to plugin {} with payload {}",
        event,
        plugin_id,
        if payload.len() > 100 {
            format!("{}...", &payload[..100])
        } else {
            payload.to_string()
        }
    );

    let ctx = contexts.get(plugin_id).context("Context not found")?;

    ctx.with(|ctx| -> Result<()> {
        let emit_func: Function = ctx
            .globals()
            .get("____emit____")
            .context("____emit____ function not found")?;

        let payload_value: JsValue = ctx
            .json_parse(payload)
            .unwrap_or(JsValue::new_undefined(ctx.clone()));

        emit_func
            .call::<_, ()>((event, payload_value))
            .map_err(|e| {
                let msg = format!("Failed to emit event: {:?}", e);
                error!("{}", msg);
                anyhow::anyhow!(msg)
            })?;

        Ok(())
    })?;

    Ok(())
}

/// Call a function in a plugin's context and return its result as a JSON string.
pub(super) fn call_function_impl(
    runtime: &Runtime,
    contexts: &mut HashMap<String, Context>,
    plugin_id: &str,
    fn_name: &str,
    args: &str,
    command_rx: &cbc::Receiver<WorkerCommand>,
    ipc_tx: &cbc::Sender<IpcCall>,
    callback_rx: &cbc::Receiver<IpcCallback>,
    shutdown_requested: &mut bool,
) -> Result<String> {
    debug!(
        "Calling function {} in plugin {} with args {}",
        fn_name,
        plugin_id,
        if args.len() > 100 {
            format!("{}...", &args[..100])
        } else {
            args.to_string()
        }
    );

    let ctx = contexts.get(plugin_id).context("Context not found")?;

    let result_json = ctx.with(|ctx| -> Result<String> {
        let func: Function = ctx
            .globals()
            .get(fn_name)
            .context(format!("Function {} not found", fn_name))?;

        let args_value: JsValue = ctx
            .json_parse(args)
            .unwrap_or_else(|_| JsValue::new_undefined(ctx.clone()));

        let result: JsValue = func.call((args_value,)).map_err(|e| {
            let msg = format!("Failed to call function: {:?}", e);
            error!("{}", msg);
            anyhow::anyhow!(msg)
        })?;

        let result_json = ctx
            .json_stringify(&result)?
            .map(|v| v.to_string().unwrap_or_else(|_| "null".to_string()))
            .unwrap_or_else(|| "null".to_string());

        Ok(result_json)
    })?;

    if let Some(result_id) =
        super::async_agent_tool_results::async_agent_tool_result_id(&result_json)
    {
        super::async_agent_tool_results::wait_for_async_agent_tool_result(
            runtime,
            contexts,
            plugin_id,
            &result_id,
            command_rx,
            ipc_tx,
            callback_rx,
            shutdown_requested,
        )
    } else {
        Ok(result_json)
    }
}
