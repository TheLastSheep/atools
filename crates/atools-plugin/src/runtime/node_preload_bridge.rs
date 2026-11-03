//! Disk preload routing and the Node bridge command adapter for `JsRuntime`.

use super::{JsRuntime, WorkerCommand};
use anyhow::Context as AnyhowContext;
use anyhow::Result;
use tokio::sync::oneshot;

impl JsRuntime {
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

        let result = response_rx
            .await
            .context("Worker thread died before responding")?;
        if result.is_ok() {
            if let Ok(mut bridges) = self.node_bridges.write() {
                bridges.remove(plugin_id);
            }
        }
        result
    }

    /// Execute a plugin's preload script from disk, automatically routing Tier 2B
    /// Node.js CommonJS / Electron preloads to `NodePreloadBridge` when needed.
    pub async fn execute_preload_from_dir(
        &self,
        plugin_id: &str,
        plugin_dir: &std::path::Path,
        preload_rel: &str,
    ) -> Result<()> {
        let selected_package_root = if crate::package_resolution::has_manifest_candidate(plugin_dir)
        {
            crate::package_resolution::resolve_plugin_package(plugin_dir)?.package_root
        } else {
            plugin_dir.to_path_buf()
        };
        let preload_code = crate::loader::read_preload_js(&selected_package_root, preload_rel)?;
        let requires_node = preload_rel.ends_with(".cjs")
            || preload_code.contains("require(")
            || preload_code.contains("__dirname")
            || preload_code.contains("__filename");

        if !requires_node {
            if let Ok(()) = self.execute_preload(plugin_id, &preload_code).await {
                return Ok(());
            }
        }

        let bridge = crate::node_preload::NodePreloadBridge::new_with_node_runtime_selector(
            selected_package_root,
            preload_rel.to_string(),
            self.node_runtime_selector.clone(),
        );
        bridge.inspect().await?;
        if let Ok(mut guard) = self.node_bridges.write() {
            guard.insert(plugin_id.to_string(), bridge);
        }
        Ok(())
    }

    /// Call a function in a plugin's context.
    pub async fn call_function(
        &self,
        plugin_id: &str,
        fn_name: &str,
        args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let maybe_bridge = self
            .node_bridges
            .read()
            .ok()
            .and_then(|guard| guard.get(plugin_id).cloned());

        if let Some(bridge) = maybe_bridge {
            if fn_name == "____callAgentTool____" {
                let payload = args.first().cloned().unwrap_or(serde_json::Value::Null);
                let tool_name = payload
                    .get("tool")
                    .or_else(|| payload.get("name"))
                    .or_else(|| payload.get("normalizedTool"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let arguments = payload
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                return bridge.call_tool(tool_name, arguments).await;
            }
            if fn_name == "____callService____" {
                let payload = args.first().cloned().unwrap_or(serde_json::Value::Null);
                let service_name = payload
                    .get("service")
                    .or_else(|| payload.get("method"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let call_args = payload
                    .get("args")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                return bridge.call_service(service_name, call_args).await;
            }
        }

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

}
