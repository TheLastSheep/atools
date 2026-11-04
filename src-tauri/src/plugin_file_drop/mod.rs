//! Authenticated native OS drop reads and one-shot binary delivery.
mod binary;
pub(crate) mod commands;
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
#[path = "desktop_smoke.rs"]
mod desktop_smoke;
mod lifecycle;
mod read;
pub(crate) mod registry;
mod selection;
mod store;
mod types;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
pub(super) type TimerHandle = tauri::async_runtime::JoinHandle<()>;
pub(crate) use store::Runtime;
pub(crate) const SOURCE: &str = "plugin_file_drop";
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub use desktop_smoke::run as run_desktop_smoke;
use types::{Owner, Request, Selection};

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Runtime::default()));
}
pub(crate) fn manager(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    app.try_state::<Arc<Runtime>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Native file-drop runtime unavailable".into())
}
pub(crate) fn on_native_drop(
    app: &AppHandle,
    window: &str,
    paths: Vec<std::path::PathBuf>,
    x: f64,
    y: f64,
    scale: f64,
) {
    selection::queue_drop(app, window, paths, x, y, scale);
}
pub(crate) fn supported() -> bool {
    selection::supported()
}
pub(crate) async fn close_window(app: &AppHandle, window: &str) {
    lifecycle::close(app, None, Some(window), None, None, false).await;
}
pub(crate) async fn close_document(app: &AppHandle, page_id: &str) {
    lifecycle::close(app, None, None, None, Some(page_id), false).await;
}
pub(crate) async fn invalidate(app: &AppHandle, plugin: Option<&str>) {
    lifecycle::close(app, plugin, None, None, None, false).await;
    let _ = app.emit(
        "atools://plugin-file-drop-invalidated",
        serde_json::json!({ "pluginId": plugin }),
    );
}
pub(crate) async fn stop(app: &AppHandle) {
    lifecycle::close(app, None, None, None, None, true).await;
}
pub(crate) fn stop_on_main_thread(app: &AppHandle) {
    if let Ok(rt) = manager(app) {
        let mut store = rt.store.lock();
        store.stopped = true;
        store.selections.clear();
        for (_, timer) in store.selection_timers.drain() {
            timer.abort();
        }
        for (_, timer) in store.request_timers.drain() {
            timer.abort();
        }
    }
}
pub(crate) fn discard(app: &AppHandle, window: &str, intent_id: &str) -> Result<bool, String> {
    selection::discard(app, window, intent_id)
}
pub(crate) fn close_owner(app: &AppHandle, owner: &Owner) {
    lifecycle::close_owner(app, owner);
}

fn claim_selection(
    runtime: &Runtime,
    id: &str,
    window: &str,
) -> Result<Selection, String> {
    let mut store = runtime.store.lock();
    let selection = store
        .selections
        .remove(id)
        .ok_or("Native drop intent expired or consumed")?;
    if let Some(timer) = store.selection_timers.remove(id) {
        timer.abort();
    }
    if selection.window != window
        || selection.created.elapsed() >= types::LEASE
        || !selection.valid
        || selection.paths.is_empty()
        || selection.paths.len() != selection.file_count
        || !selection.point_x.is_finite()
        || !selection.point_y.is_finite()
        || !selection.scale.is_finite()
        || selection.scale <= 0.0
    {
        return Err("Native drop selection is unavailable".into());
    }
    Ok(selection)
}
fn insert_request(runtime: &Runtime, request: Arc<Request>) -> Result<(), String> {
    let mut store = runtime.store.lock();
    if store.stopped
        || store.requests.len() >= types::MAX_REQUESTS
        || store.requests.len() + store.selections.len() >= types::MAX_INTENTS
        || store
            .requests
            .values()
            .any(|r| r.owner.window == request.owner.window)
    {
        return Err("Too many pending file-drop requests".into());
    }
    store.requests.insert(request.id.clone(), request);
    Ok(())
}
fn register_request_timer(runtime: &Runtime, id: &str, timer: TimerHandle) {
    let mut store = runtime.store.lock();
    if store.requests.contains_key(id) {
        if let Some(old) = store.request_timers.insert(id.into(), timer) {
            old.abort();
        }
    } else {
        timer.abort();
    }
}
fn register_selection_timer(runtime: &Runtime, id: &str, timer: TimerHandle) {
    let mut store = runtime.store.lock();
    if store.selections.contains_key(id) {
        if let Some(old) = store.selection_timers.insert(id.into(), timer) {
            old.abort();
        }
    } else {
        timer.abort();
    }
}
fn request(runtime: &Runtime, id: &str) -> Result<Arc<Request>, String> {
    runtime
        .store
        .lock()
        .requests
        .get(id)
        .cloned()
        .ok_or("File-drop request expired or consumed".into())
}
fn is_current(runtime: &Runtime, request: &Arc<Request>) -> bool {
    runtime
        .store
        .lock()
        .requests
        .get(&request.id)
        .is_some_and(|r| Arc::ptr_eq(r, request))
        && request.valid()
}
fn remove_request(runtime: &Runtime, id: &str) -> Option<Arc<Request>> {
    let mut store = runtime.store.lock();
    if let Some(timer) = store.request_timers.remove(id) {
        timer.abort();
    }
    store.requests.remove(id)
}
fn remove_selection(runtime: &Runtime, id: &str) -> Option<Selection> {
    let mut store = runtime.store.lock();
    if let Some(timer) = store.selection_timers.remove(id) {
        timer.abort();
    }
    store.selections.remove(id)
}
