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

#![allow(
    dead_code,
    clippy::assertions_on_constants,
    clippy::bool_assert_comparison,
    clippy::cloned_ref_to_slice_refs,
    clippy::collapsible_else_if,
    clippy::collapsible_if,
    clippy::doc_lazy_continuation,
    clippy::field_reassign_with_default,
    clippy::format_in_format_args,
    clippy::io_other_error,
    clippy::items_after_test_module,
    clippy::large_enum_variant,
    clippy::manual_div_ceil,
    clippy::manual_is_multiple_of,
    clippy::manual_range_contains,
    clippy::manual_unwrap_or_default,
    clippy::needless_borrow,
    clippy::needless_borrows_for_generic_args,
    clippy::needless_lifetimes,
    clippy::needless_range_loop,
    clippy::needless_return,
    clippy::nonminimal_bool,
    clippy::ptr_arg,
    clippy::question_mark,
    clippy::redundant_closure,
    clippy::result_large_err,
    clippy::result_unit_err,
    clippy::search_is_some,
    clippy::single_match,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::unnecessary_cast,
    clippy::unnecessary_lazy_evaluations,
    clippy::unnecessary_map_or,
    clippy::unused_enumerate_index,
    clippy::useless_conversion,
    clippy::useless_format
)]

pub mod bridge;
pub mod context;
pub mod ipc_handler;
pub mod legacy_node;
pub mod loader;
pub mod node_preload;
pub mod package_resolution;
pub mod runtime;
pub mod sidecar;
pub mod source_build;

// Re-export the most commonly used types at crate root for convenience.
pub use context::PluginContext;
pub use ipc_handler::{IpcError, IpcHandler, IpcResult};
pub use legacy_node::LegacyNodeSession;
pub use node_preload::{NodePreloadBridge, PreloadInspection};
pub use runtime::JsRuntime;
pub use sidecar::{
    JsonRpcSidecar, McpSidecar, SidecarError, SidecarLaunchSpec, SidecarSupervisor,
    SidecarToolResult,
};
