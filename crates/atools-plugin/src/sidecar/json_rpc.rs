use super::{SidecarError, SidecarProcess};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarContent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarToolResult {
    #[serde(default)]
    pub content: Vec<SidecarContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub raw: Value,
}

impl SidecarToolResult {
    pub fn from_value(value: Value) -> Self {
        let has_tool_result_shape = value.get("content").is_some()
            || value.get("structuredContent").is_some()
            || value.get("structured_content").is_some()
            || value.get("isError").is_some()
            || value.get("is_error").is_some();
        if has_tool_result_shape {
            if let Ok(mut result) = serde_json::from_value::<Self>(value.clone()) {
                result.raw = value;
                return result;
            }
        }
        if let Some(text) = value.as_str() {
            return Self {
                content: vec![SidecarContent {
                    kind: "text".to_string(),
                    text: Some(text.to_string()),
                    data: None,
                    mime_type: None,
                    extra: Default::default(),
                }],
                structured_content: None,
                is_error: false,
                raw: value,
            };
        }
        Self {
            content: Vec::new(),
            structured_content: Some(value.clone()),
            is_error: false,
            raw: value,
        }
    }
}

#[derive(Clone)]
pub struct JsonRpcSidecar {
    process: Arc<SidecarProcess>,
}

impl JsonRpcSidecar {
    pub fn new(process: Arc<SidecarProcess>) -> Result<Self, SidecarError> {
        if process.transport() != atools_core::PluginRuntimeTransport::JsonRpcStdio {
            return Err(SidecarError::Protocol(
                "JSON-RPC adapter requires json_rpc_stdio transport".to_string(),
            ));
        }
        Ok(Self { process })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<SidecarToolResult, SidecarError> {
        self.process
            .request(method, params)
            .await
            .map(SidecarToolResult::from_value)
    }

    pub fn process(&self) -> &Arc<SidecarProcess> {
        &self.process
    }
}
