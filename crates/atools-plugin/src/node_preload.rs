//! Tier 2B Node.js CommonJS & Electron Preload Adapter (`NodePreloadBridge`).
//!
//! Many ZTools/uTools plugins (over 68% of `ZTools-plugins`) use CommonJS `preload.js` /
//! `preload.cjs` scripts that call `require('node:fs')`, `require('node:child_process')`,
//! `require('node:crypto')`, `require('electron')`, or relative `.cjs` modules.
//!
//! `NodePreloadBridge` executes these preloads inside a Node.js process with a
//! `window.ztools` / `window.utools` shim and a limited `require('electron')` stub. The
//! Electron stub only covers the methods explicitly present in the harness; it is not a
//! complete Electron implementation. The bridge can inspect preload exports, invoke
//! registered MCP/Agent tools (`ztools.registerTool`), and call `window.services` methods.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use crate::sidecar::NodeRuntimeSelector;

const NODE_PRELOAD_HARNESS_JS: &str = include_str!("node_preload_harness.js");

/// Metadata returned when inspecting a Node CommonJS preload script.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreloadInspection {
    pub ok: bool,
    pub services: Vec<String>,
    pub exports: Vec<String>,
    pub registered_tools: Vec<String>,
}

/// Bridge for executing Tier 2B Node.js CommonJS preloads with a limited Electron stub.
#[derive(Debug, Clone)]
pub struct NodePreloadBridge {
    plugin_dir: PathBuf,
    preload_rel: String,
    node_runtime_selector: NodeRuntimeSelector,
}

impl NodePreloadBridge {
    pub fn new(plugin_dir: PathBuf, preload_rel: String) -> Self {
        Self::new_with_node_runtime_selector(
            plugin_dir, preload_rel, NodeRuntimeSelector::default(),
        )
    }

    /// Create a bridge using a host-provided Node runtime selector.
    pub fn new_with_node_runtime_selector(
        plugin_dir: PathBuf,
        preload_rel: String,
        node_runtime_selector: NodeRuntimeSelector,
    ) -> Self {
        Self { plugin_dir, preload_rel, node_runtime_selector }
    }

    pub fn plugin_dir(&self) -> &Path {
        &self.plugin_dir
    }

    pub fn preload_rel(&self) -> &str {
        &self.preload_rel
    }

    /// Inspects the preload script and returns exported `window.services`, `module.exports`, and `ztools.registerTool` names.
    pub async fn inspect(&self) -> Result<PreloadInspection> {
        let val = self.run_node_action("inspect", "", &Value::Null).await?;
        serde_json::from_value(val).context("Failed to deserialize PreloadInspection")
    }

    /// Calls a tool registered via `ztools.registerTool(name, handler)` or exported on `bridge`.
    pub async fn call_tool(&self, tool_name: &str, arguments: Value) -> Result<Value> {
        let val = self
            .run_node_action("call_tool", tool_name, &arguments)
            .await?;
        Ok(val.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Calls a function exposed on `window.services` or `module.exports`.
    pub async fn call_service(&self, service_name: &str, args: Vec<Value>) -> Result<Value> {
        let val = self
            .run_node_action("call_service", service_name, &Value::Array(args))
            .await?;
        Ok(val.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn run_node_action(&self, action: &str, target: &str, args: &Value) -> Result<Value> {
        let operation_timeout = Duration::from_secs(15);
        let operation_deadline = tokio::time::Instant::now() + operation_timeout;
        let selection_cancelled = Arc::new(AtomicBool::new(false));
        let node_bin = tokio::time::timeout_at(
            operation_deadline,
            self.node_runtime_selector
                .resolve_node_binary_with_cancellation(Arc::clone(&selection_cancelled)),
        )
        .await
        .context("NodePreloadBridge timed out after 15s")?
        .context("Node runtime is unavailable for this plugin tool")?;
        let args_json = serde_json::to_string(args)?;
        if tokio::time::Instant::now() >= operation_deadline {
            return Err(anyhow!("NodePreloadBridge timed out after 15s"));
        }

        let mut command = Command::new(node_bin);
        command
            .arg("-e")
            .arg(NODE_PRELOAD_HARNESS_JS)
            .current_dir(&self.plugin_dir)
            .env("ATOOLS_PLUGIN_DIR", &self.plugin_dir)
            .env("ATOOLS_PRELOAD_REL", &self.preload_rel)
            .env("ATOOLS_ACTION", action)
            .env("ATOOLS_TARGET", target)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if tokio::time::Instant::now() >= operation_deadline {
            return Err(anyhow!("NodePreloadBridge timed out after 15s"));
        }
        let mut child = command
            .spawn()
            .context("Failed to spawn Node.js for NodePreloadBridge")?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("NodePreloadBridge stdin pipe is unavailable"))?;
        write_preload_input(stdin, args_json.as_bytes(), operation_deadline).await?;

        let output = tokio::time::timeout_at(operation_deadline, child.wait_with_output())
            .await
            .context("NodePreloadBridge timed out after 15s")?
            .context("Failed waiting on NodePreloadBridge process")?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        let begin_marker = "__ATOOLS_JSON_BEGIN__";
        let end_marker = "__ATOOLS_JSON_END__";
        if let (Some(start), Some(end)) = (stdout.rfind(begin_marker), stdout.rfind(end_marker)) {
            let json_start = start + begin_marker.len();
            if json_start < end {
                let slice = stdout[json_start..end].trim();
                let parsed: Value = serde_json::from_str(slice)
                    .with_context(|| format!("Invalid JSON from NodePreloadBridge: {slice}"))?;
                if parsed.get("ok").and_then(Value::as_bool) == Some(false) {
                    let err_msg = parsed
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown Node preload error");
                    return Err(anyhow!("NodePreloadBridge error: {}", err_msg));
                }
                return Ok(parsed);
            }
        }

        Err(anyhow!(
            "NodePreloadBridge did not return structured JSON (exit={:?}, stderr={})",
            output.status.code(),
            stderr.trim()
        ))
    }
}

async fn write_preload_input<W>(
    mut writer: W,
    input: &[u8],
    deadline: tokio::time::Instant,
) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    tokio::time::timeout_at(deadline, async move {
        writer
            .write_all(input)
            .await
            .context("Failed writing NodePreloadBridge request")?;
        writer
            .shutdown()
            .await
            .context("Failed closing NodePreloadBridge stdin")?;
        Ok(())
    })
    .await
    .context("NodePreloadBridge timed out after 15s while sending request")?
}

#[cfg(test)]
#[path = "node_preload_tests.rs"]
mod tests;
