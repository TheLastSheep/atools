//! Audited native BrowserWindow lifecycle for opaque plugin frames.
pub(crate) mod commands;
mod dragging;
mod event_queue;
mod executor;
mod identity;
mod intents;
mod inventory;
mod lifecycle;
mod manager;
mod privacy;
pub(crate) mod registry;
mod source_frames;

pub(crate) const SOURCE: &str = "plugin-browser-window";
const EVENT: &str = "plugin-native-browser-window-event";

pub(crate) use inventory::inventory_snapshot;
pub(crate) use lifecycle::{close_sources, native_build_failed, native_created};
pub(crate) use privacy::{bind_run, validate_private_request};
pub(crate) use source_frames::validate_source_frame;
use tauri::Manager;

pub(crate) fn install_manager(app: &tauri::AppHandle) {
    app.manage(std::sync::Arc::new(manager::Runtime::default()));
}

pub(crate) fn close_window(app: &tauri::AppHandle, label: &str) {
    lifecycle::close_parent(app, label);
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    lifecycle::stop(app);
}

fn manager(app: &tauri::AppHandle) -> Result<std::sync::Arc<manager::Runtime>, String> {
    app.try_state::<std::sync::Arc<manager::Runtime>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "Native BrowserWindow runtime is unavailable".into())
}

pub(crate) async fn execute(
    app: &tauri::AppHandle,
    db: &atools_core::Database,
    tool: &atools_core::agent::ToolDefinition,
    args: serde_json::Value,
    client: &str,
    run_id: &str,
    execution: Option<std::sync::Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
) -> Result<serde_json::Value, String> {
    executor::execute(app, db, tool, args, client, run_id, execution).await
}

pub(crate) fn consume_popup(
    app: &tauri::AppHandle,
    parent: &tauri::WebviewWindow,
    url: &tauri::Url,
) -> Result<Option<crate::plugin_browser_window_native::WindowSpec>, String> {
    lifecycle::consume_popup(app, parent, url)
}

pub(crate) fn native_loaded(app: &tauri::AppHandle, label: &str) {
    lifecycle::native_loaded(app, label);
}

pub(crate) fn native_event(app: &tauri::AppHandle, label: &str, kind: &str) {
    lifecycle::native_event(app, label, kind);
}

pub(crate) fn native_destroyed(app: &tauri::AppHandle, label: &str) {
    lifecycle::native_destroyed(app, label);
}

pub(crate) fn cancel_run(app: &tauri::AppHandle, run_id: &str) {
    lifecycle::cancel_run(app, run_id);
}
