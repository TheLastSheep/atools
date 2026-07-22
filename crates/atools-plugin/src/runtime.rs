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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Context as AnyhowContext;
use anyhow::Result;
use crossbeam_channel as cbc;
use rquickjs::{Context, Function, Runtime, Value as JsValue};
use tokio::sync::oneshot;
use tracing::{debug, error, info, warn};

use crate::bridge::{IpcCall, IpcResult, SHIM_JS};
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
}

impl Clone for JsRuntime {
    fn clone(&self) -> Self {
        Self {
            command_tx: self.command_tx.clone(),
            worker_handle: None,
            ipc_thread_handle: None,
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
        let (command_tx, command_rx) = cbc::unbounded::<WorkerCommand>();

        // Crossbeam channels for the IPC pipeline.
        let (ipc_tx, ipc_rx): (cbc::Sender<IpcCall>, cbc::Receiver<IpcCall>) = cbc::unbounded();
        let (cb_tx, cb_rx): (cbc::Sender<IpcCallback>, cbc::Receiver<IpcCallback>) =
            cbc::unbounded();

        // Spawn the IPC dispatcher thread.
        let ipc_thread_handle = thread::Builder::new()
            .name("ipc-dispatcher".into())
            .spawn(move || {
                ipc_dispatcher_main(ipc_rx, cb_tx, handler);
            })
            .context("Failed to spawn IPC dispatcher thread")?;

        // Spawn the QuickJS worker thread.
        let worker_handle = thread::Builder::new()
            .name("quickjs-worker".into())
            .spawn(move || {
                if let Err(e) = worker_main(command_rx, ipc_tx, cb_rx) {
                    error!("QuickJS worker thread failed: {:?}", e);
                }
            })
            .context("Failed to spawn QuickJS worker thread")?;

        info!("QuickJS runtime initialized (two-thread architecture)");
        Ok(Self {
            command_tx,
            worker_handle: Some(worker_handle),
            ipc_thread_handle: Some(ipc_thread_handle),
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

    /// Execute a plugin's preload script in its context.
    pub async fn execute_preload(&self, plugin_id: &str, preload_code: &str) -> Result<()> {
        let (response_tx, response_rx) = oneshot::channel();

        self.command_tx
            .send(WorkerCommand::ExecutePreload {
                plugin_id: plugin_id.to_string(),
                preload_code: preload_code.to_string(),
                response: response_tx,
            })
            .context("Failed to send execute_preload command to worker")?;

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

    /// Call a function in a plugin's context.
    pub async fn call_function(
        &self,
        plugin_id: &str,
        fn_name: &str,
        args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let (response_tx, response_rx) = oneshot::channel();
        let args_str = serde_json::to_string(&args)?;

        self.command_tx
            .send(WorkerCommand::CallFunction {
                plugin_id: plugin_id.to_string(),
                fn_name: fn_name.to_string(),
                args: args_str,
                response: response_tx,
            })
            .context("Failed to send call_function command to worker")?;

        let result_str = response_rx
            .await
            .context("Worker thread died before responding")??;

        serde_json::from_str(&result_str).context("Failed to parse function result as JSON")
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
// IPC dispatcher thread
// ---------------------------------------------------------------------------

/// Main loop for the IPC dispatcher thread.
///
/// Owns a tokio runtime and the `dyn IpcHandler`. Receives `IpcCall`s from the
/// worker, calls the handler concurrently, and sends `IpcResult`s back via the
/// callback channel.
fn ipc_dispatcher_main(
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

// ---------------------------------------------------------------------------
// Worker thread
// ---------------------------------------------------------------------------

/// Main loop for the QuickJS worker thread.
///
/// Owns the `rquickjs::Runtime` and per-plugin `Context`s. Uses
/// `crossbeam_channel::select!` to process both incoming commands from the
/// async API and returning IPC callbacks from the dispatcher -- without ever
/// blocking on handler results.
fn worker_main(
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
                        let r = create_context_impl(&runtime, &mut contexts, &plugin_id, &ipc_tx);
                        let _ = response.send(r);
                    }
                    Ok(WorkerCommand::ExecutePreload { plugin_id, preload_code, response }) => {
                        let r = execute_preload_impl(&runtime, &mut contexts, &plugin_id, &preload_code, &ipc_tx);
                        let _ = response.send(r);
                    }
                    Ok(WorkerCommand::EmitEvent { plugin_id, event, payload, response }) => {
                        let r = emit_event_impl(&mut contexts, &plugin_id, &event, &payload);
                        let _ = response.send(r);
                    }
                    Ok(WorkerCommand::CallFunction { plugin_id, fn_name, args, response }) => {
                        let r = call_function_impl(
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
fn drain_one_callback(contexts: &mut HashMap<String, Context>, cb: IpcCallback) {
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

// ---------------------------------------------------------------------------
// Context operations (run on the worker thread)
// ---------------------------------------------------------------------------

/// Create a new JS context for a plugin and inject the IPC bridge + shim.
fn create_context_impl(
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
        let req_counter: Arc<AtomicU64> = Arc::new(AtomicU64::new(1));

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
                let req_id = req_counter.fetch_add(1, Ordering::Relaxed);

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
fn execute_preload_impl(
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
fn emit_event_impl(
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
fn call_function_impl(
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

    if let Some(result_id) = async_agent_tool_result_id(&result_json) {
        wait_for_async_agent_tool_result(
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

fn async_agent_tool_result_id(result_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(result_json).ok()?;
    let id = value.get("__atoolsAsyncAgentToolResultId")?;
    if let Some(id) = id.as_str() {
        return Some(id.to_string());
    }
    id.as_u64().map(|id| id.to_string())
}

fn wait_for_async_agent_tool_result(
    runtime: &Runtime,
    contexts: &mut HashMap<String, Context>,
    plugin_id: &str,
    result_id: &str,
    command_rx: &cbc::Receiver<WorkerCommand>,
    ipc_tx: &cbc::Sender<IpcCall>,
    callback_rx: &cbc::Receiver<IpcCallback>,
    shutdown_requested: &mut bool,
) -> Result<String> {
    let deadline = Instant::now() + Duration::from_secs(10);

    loop {
        let state_json = read_async_agent_tool_result_state(contexts, plugin_id, result_id)?;
        let state: serde_json::Value = serde_json::from_str(&state_json)
            .context("Failed to parse async plugin Agent tool result state")?;
        match state.get("status").and_then(|value| value.as_str()) {
            Some("resolved") => {
                let value = state
                    .get("value")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                return serde_json::to_string(&value)
                    .context("Failed to serialize async plugin Agent tool result");
            }
            Some("rejected") => {
                let error = state
                    .get("error")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Async plugin Agent tool rejected");
                return Err(anyhow::anyhow!(
                    "Async plugin Agent tool rejected: {}",
                    error
                ));
            }
            Some("missing") => {
                let error = state
                    .get("error")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Async plugin Agent tool result missing");
                return Err(anyhow::anyhow!("{}", error));
            }
            Some("pending") => {}
            other => {
                return Err(anyhow::anyhow!(
                    "Unexpected async plugin Agent tool state: {:?}",
                    other
                ));
            }
        }

        if Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "Timed out waiting for async plugin Agent tool result"
            ));
        }

        crossbeam_channel::select! {
            recv(callback_rx) -> callback => {
                match callback {
                    Ok(callback) => drain_one_callback(contexts, callback),
                    Err(_) => {
                        return Err(anyhow::anyhow!(
                            "IPC callback channel disconnected while waiting for async plugin result"
                        ));
                    }
                }
            }
            recv(command_rx) -> command => {
                match command {
                    Ok(WorkerCommand::CreateContext { plugin_id, response }) => {
                        let result = create_context_impl(runtime, contexts, &plugin_id, ipc_tx);
                        let _ = response.send(result);
                    }
                    Ok(WorkerCommand::ExecutePreload { plugin_id, preload_code, response }) => {
                        let result = execute_preload_impl(runtime, contexts, &plugin_id, &preload_code, ipc_tx);
                        let _ = response.send(result);
                    }
                    Ok(WorkerCommand::EmitEvent { plugin_id, event, payload, response }) => {
                        let result = emit_event_impl(contexts, &plugin_id, &event, &payload);
                        let _ = response.send(result);
                    }
                    Ok(WorkerCommand::CallFunction { plugin_id, fn_name, args, response }) => {
                        let result = call_function_impl(
                            runtime,
                            contexts,
                            &plugin_id,
                            &fn_name,
                            &args,
                            command_rx,
                            ipc_tx,
                            callback_rx,
                            shutdown_requested,
                        );
                        let _ = response.send(result);
                    }
                    Ok(WorkerCommand::Shutdown) => {
                        *shutdown_requested = true;
                        return Err(anyhow::anyhow!("Plugin runtime shut down while waiting for async plugin result"));
                    }
                    Err(_) => {
                        return Err(anyhow::anyhow!("Plugin runtime command channel disconnected"));
                    }
                }
            }
            default(Duration::from_millis(10)) => {}
        }
    }
}

fn read_async_agent_tool_result_state(
    contexts: &mut HashMap<String, Context>,
    plugin_id: &str,
    result_id: &str,
) -> Result<String> {
    let ctx = contexts.get(plugin_id).context("Context not found")?;

    ctx.with(|ctx| -> Result<String> {
        while ctx.execute_pending_job() {}

        let take_func: Function = ctx
            .globals()
            .get("____takeAsyncAgentToolResult____")
            .context("____takeAsyncAgentToolResult____ function not found")?;
        let state: JsValue = take_func.call((result_id,)).map_err(|e| {
            let msg = format!("Failed to read async plugin Agent tool result: {:?}", e);
            error!("{}", msg);
            anyhow::anyhow!(msg)
        })?;
        let state_json = ctx
            .json_stringify(&state)?
            .map(|value| value.to_string().unwrap_or_else(|_| "null".to_string()))
            .unwrap_or_else(|| "null".to_string());

        Ok(state_json)
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_handler::{IpcError, IpcHandler};
    use async_trait::async_trait;
    use serde_json::json;

    /// A no-op IPC handler for tests.
    struct NoopHandler;

    #[async_trait]
    impl IpcHandler for NoopHandler {
        async fn handle(
            &self,
            _plugin_id: &str,
            _method: &str,
            _args: Vec<serde_json::Value>,
        ) -> Result<serde_json::Value, IpcError> {
            Ok(json!(null))
        }
    }

    fn make_runtime() -> JsRuntime {
        JsRuntime::new(Arc::new(NoopHandler)).expect("Failed to create runtime")
    }

    #[tokio::test]
    async fn test_runtime_creation() {
        let runtime = make_runtime();
        assert!(runtime.is_alive());
    }

    #[tokio::test]
    async fn test_create_context() {
        let runtime = make_runtime();
        let result = runtime.create_context("test-plugin").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_execute_preload() {
        let runtime = make_runtime();
        let preload_code = r#"
            globalThis.testValue = 42;
        "#;
        let result = runtime.execute_preload("test-plugin", preload_code).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn call_agent_tool_invokes_registered_sync_handler() {
        let runtime = make_runtime();
        let preload_code = r#"
            utools.registerTool('echo', { description: 'Echo text' }, function(args) {
                return { echoed: args.text, count: args.count + 1 };
            });
        "#;
        runtime
            .execute_preload("test-plugin", preload_code)
            .await
            .unwrap();

        let result = runtime
            .call_function(
                "test-plugin",
                "____callAgentTool____",
                vec![json!({
                    "tool": "echo",
                    "normalizedTool": "plugin_test_plugin_echo",
                    "arguments": { "text": "hello", "count": 2 }
                })],
            )
            .await
            .unwrap();

        assert_eq!(result, json!({ "echoed": "hello", "count": 3 }));
    }

    #[tokio::test]
    async fn call_agent_tool_awaits_async_handler_promise() {
        let runtime = make_runtime();
        let preload_code = r#"
            utools.registerTool('echo_async', { description: 'Echo text asynchronously' }, async function(args) {
                var upper = await Promise.resolve(String(args.text).toUpperCase());
                return { echoed: upper, count: args.count + 1 };
            });
        "#;
        runtime
            .execute_preload("test-plugin", preload_code)
            .await
            .unwrap();

        let result = runtime
            .call_function(
                "test-plugin",
                "____callAgentTool____",
                vec![json!({
                    "tool": "echo_async",
                    "normalizedTool": "plugin_test_plugin_echo_async",
                    "arguments": { "text": "hello", "count": 2 }
                })],
            )
            .await
            .unwrap();

        assert_eq!(result, json!({ "echoed": "HELLO", "count": 3 }));
    }

    #[tokio::test]
    async fn call_agent_tool_awaits_async_handler_ipc_promise() {
        let runtime = make_runtime();
        let preload_code = r#"
            utools.registerTool('echo_ipc', { description: 'Echo after IPC' }, async function(args) {
                await utools.dbStorage.setItem('lastText', args.text);
                return { echoed: args.text, ipcCompleted: true };
            });
        "#;
        runtime
            .execute_preload("test-plugin", preload_code)
            .await
            .unwrap();

        let result = runtime
            .call_function(
                "test-plugin",
                "____callAgentTool____",
                vec![json!({
                    "tool": "echo_ipc",
                    "normalizedTool": "plugin_test_plugin_echo_ipc",
                    "arguments": { "text": "hello" }
                })],
            )
            .await
            .unwrap();

        assert_eq!(result, json!({ "echoed": "hello", "ipcCompleted": true }));
    }
}
