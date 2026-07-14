//! IPC handler trait for plugin API calls.
//!
//! This module defines the [`IpcHandler`] trait that decouples the plugin runtime
//! from the actual API implementation, allowing the atools-api-shim crate to
//! provide the handler logic without creating a circular dependency.

use async_trait::async_trait;
use serde_json::Value;

/// Result type for IPC handler operations.
pub type IpcResult = Result<Value, IpcError>;

/// Error type for IPC handler operations.
#[derive(Debug, thiserror::Error)]
pub enum IpcError {
    #[error("Invalid arguments: {0}")]
    InvalidArgs(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Method not supported: {0}")]
    MethodNotSupported(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Trait for handling IPC calls from plugin JavaScript.
///
/// Implementations of this trait provide the actual logic for API calls
/// like database operations, clipboard access, window management, etc.
#[async_trait]
pub trait IpcHandler: Send + Sync + 'static {
    /// Handle an IPC call from a plugin.
    ///
    /// # Arguments
    ///
    /// * `plugin_id` - The plugin's ID
    /// * `method` - The API method name (e.g., "db.put", "clipboard.readText")
    /// * `args` - The arguments passed to the method
    ///
    /// # Returns
    ///
    /// A JSON Value on success, or an IpcError on failure.
    async fn handle(&self, plugin_id: &str, method: &str, args: Vec<Value>) -> IpcResult;
}
