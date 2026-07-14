//! Wrapper to adapt ApiHandler to IpcHandler interface.

use crate::handler::ApiHandler;
use async_trait::async_trait;
use atools_plugin::ipc_handler::{IpcError, IpcHandler, IpcResult};
use serde_json::Value;

/// Wrapper that adapts `ApiHandler` to the `IpcHandler` trait.
pub struct ApiHandlerWrapper {
    handler: ApiHandler,
}

impl ApiHandlerWrapper {
    pub fn new(handler: ApiHandler) -> Self {
        Self { handler }
    }
}

#[async_trait]
impl IpcHandler for ApiHandlerWrapper {
    async fn handle(&self, plugin_id: &str, method: &str, params: Vec<Value>) -> IpcResult {
        // Call the actual handler with plugin_id
        let result = self.handler.handle(plugin_id, method, params).await;

        // Convert Result<Value, anyhow::Error> to IpcResult
        match result {
            Ok(value) => Ok(value),
            Err(err) => Err(IpcError::Internal(err.to_string())),
        }
    }
}
