//! QuickJS-based JavaScript runtime for executing uTools plugin `preload.js` scripts.
//!
//! This crate provides:
//!
//! - **[`runtime::JsRuntime`]** — Manages a dedicated worker thread hosting an
//!   `rquickjs::Runtime`. Plugins get isolated `rquickjs::Context` instances
//!   and can be interacted with asynchronously from any Tokio task.
//! - **[`context::PluginContext`]** — Metadata handle returned to callers after
//!   a plugin's `preload.js` has been evaluated. The actual JS context lives
//!   exclusively on the worker thread.
//! - **[`bridge`]** — Defines the JavaScript shim (`SHIM_JS`) that installs the
//!   `utools` global object inside every plugin context, and hosts the IPC
//!   registry used to route calls from JS back to Rust.
//! - **[`loader::PluginLoader`]** — Reads `plugin.json` manifests and
//!   `preload.js` scripts from disk.

pub mod bridge;
pub mod context;
pub mod ipc_handler;
pub mod loader;
pub mod runtime;

// Re-export the most commonly used types at crate root for convenience.
pub use context::PluginContext;
pub use ipc_handler::{IpcError, IpcHandler, IpcResult};
pub use runtime::JsRuntime;
