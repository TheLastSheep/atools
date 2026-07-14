//! IPC dispatcher that routes calls from the plugin runtime to the API handler.

use std::sync::Arc;

use anyhow::Result;
use serde_json::Value;

use crate::handler::ApiHandler;

/// Dispatches IPC calls from the plugin runtime to the appropriate API handler.
///
/// This struct acts as a thin routing layer, receiving IPC invocations from the
/// JavaScript plugin runtime and forwarding them to an [`ApiHandler`] instance
/// for execution.
pub struct IpcDispatcher {
    handler: Arc<ApiHandler>,
}

impl IpcDispatcher {
    /// Creates a new IPC dispatcher.
    ///
    /// # Arguments
    ///
    /// * `handler` - Shared reference to the API handler that will process IPC calls.
    pub fn new(handler: Arc<ApiHandler>) -> Self {
        Self { handler }
    }

    /// Dispatches an IPC call to the API handler.
    ///
    /// # Arguments
    ///
    /// * `plugin_id` - The ID of the plugin making the call.
    /// * `method` - The IPC method name (e.g., "db.put", "storage.get").
    /// * `args` - JSON arguments passed to the method.
    ///
    /// # Returns
    ///
    /// A JSON value representing the result, or an error if the operation failed.
    pub async fn dispatch(&self, plugin_id: &str, method: &str, args: Vec<Value>) -> Result<Value> {
        self.handler.handle(plugin_id, method, args).await
    }
}
