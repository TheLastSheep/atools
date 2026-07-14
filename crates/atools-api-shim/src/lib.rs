//! API handler dispatch layer for ATools.
//!
//! This crate receives IPC calls from plugin JavaScript contexts (forwarded by the
//! plugin runtime) and executes the actual operations on the Rust side, including
//! database reads/writes, file-system access, notifications, and system introspection.
//!
//! # Architecture
//!
//! - [`handler::ApiHandler`] — owns a reference to the [`atools_core::db::Database`] and
//!   implements every IPC method (db, storage, features, system paths, etc.).
//! - [`handler_wrapper::ApiHandlerWrapper`] — adapts [`handler::ApiHandler`] to the
//!   `IpcHandler` trait for use with the plugin runtime.
//! - [`dispatch::IpcDispatcher`] — thin routing layer that connects the plugin runtime's
//!   IPC bridge to an [`handler::ApiHandler`] instance.
//!
//! Methods that manipulate the native window, clipboard, or dialogs return
//! `Ok(json!(null))` here; the Tauri front-end intercepts those calls and handles them
//! in the UI process.

pub mod dispatch;
pub mod handler;
pub mod handler_wrapper;
