//! Bounded wait and state extraction for async Agent-tool results.

use super::{IpcCallback, WorkerCommand};
use crate::bridge::IpcCall;
use anyhow::Context as AnyhowContext;
use anyhow::Result;
use crossbeam_channel as cbc;
use rquickjs::{Context, Function, Runtime, Value as JsValue};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::error;

pub(super) fn async_agent_tool_result_id(result_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(result_json).ok()?;
    let id = value.get("__atoolsAsyncAgentToolResultId")?;
    if let Some(id) = id.as_str() {
        return Some(id.to_string());
    }
    id.as_u64().map(|id| id.to_string())
}

pub(super) fn wait_for_async_agent_tool_result(
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
                    Ok(callback) => super::worker::drain_one_callback(contexts, callback),
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
                        let result = super::context_ops::create_context_impl(runtime, contexts, &plugin_id, ipc_tx);
                        let _ = response.send(result);
                    }
                    Ok(WorkerCommand::InvalidatePlugin { plugin_id, response }) => {
                        contexts.remove(&plugin_id);
                        let _ = response.send(Ok(()));
                    }
                    Ok(WorkerCommand::ExecutePreload { plugin_id, preload_code, response }) => {
                        let result = super::context_ops::execute_preload_impl(runtime, contexts, &plugin_id, &preload_code, ipc_tx);
                        let _ = response.send(result);
                    }
                    Ok(WorkerCommand::EmitEvent { plugin_id, event, payload, response }) => {
                        let result = super::context_ops::emit_event_impl(contexts, &plugin_id, &event, &payload);
                        let _ = response.send(result);
                    }
                    Ok(WorkerCommand::CallFunction { plugin_id, fn_name, args, response }) => {
                        let result = super::context_ops::call_function_impl(
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
