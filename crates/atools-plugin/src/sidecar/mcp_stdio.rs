use super::{SidecarError, SidecarProcess, SidecarToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeResult {
    pub protocol_version: String,
    #[serde(default)]
    pub capabilities: Value,
    #[serde(default)]
    pub server_info: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

#[derive(Clone)]
pub struct McpSidecar {
    process: Arc<SidecarProcess>,
}

impl McpSidecar {
    pub fn new(process: Arc<SidecarProcess>) -> Result<Self, SidecarError> {
        if process.transport() != atools_core::PluginRuntimeTransport::McpStdio {
            return Err(SidecarError::Protocol(
                "MCP adapter requires mcp_stdio transport".to_string(),
            ));
        }
        Ok(Self { process })
    }

    pub async fn initialize(&self) -> Result<McpInitializeResult, SidecarError> {
        let value = self
            .process
            .initialize_mcp(json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name":"ATools", "version":env!("CARGO_PKG_VERSION")}
                }))
            .await?;
        let initialized = serde_json::from_value(value)
            .map_err(|error| SidecarError::Protocol(error.to_string()))?;
        Ok(initialized)
    }

    pub async fn list_tools(&self) -> Result<Vec<McpTool>, SidecarError> {
        let value = self.process.request("tools/list", json!({})).await?;
        serde_json::from_value(
            value
                .get("tools")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        )
        .map_err(|error| SidecarError::Protocol(error.to_string()))
    }

    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
    ) -> Result<SidecarToolResult, SidecarError> {
        self.process
            .request("tools/call", json!({"name":name, "arguments":arguments}))
            .await
            .map(SidecarToolResult::from_value)
    }

    pub fn process(&self) -> &Arc<SidecarProcess> {
        &self.process
    }
}
