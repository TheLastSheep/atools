//! Private, owner-bound AI ingress for installed plugin frames.
mod channel_sink;
pub(crate) mod commands;
pub(crate) mod executor;
mod lifecycle;
pub(crate) mod privacy;
pub(crate) mod registry;
mod store;
pub(crate) mod types;
pub(crate) use types::SOURCE;

use std::sync::Arc;
pub(crate) use store::Runtime;
use tauri::{AppHandle, Listener, Manager};
use types::{FrameBinding, Owner, Request};

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Runtime::default()));
    let listener = app.clone();
    let handle = app.clone();
    listener.listen("task-run-updated", move |event| {
        let payload = event.payload();
        if payload.len() > 128 {
            return;
        }
        let run_id = serde_json::from_str::<String>(payload).unwrap_or_else(|_| payload.to_owned());
        let Ok(runtime) = manager(&handle) else {
            return;
        };
        if !runtime.tracks_run(&run_id) {
            return;
        }
        let Some(state) = handle.try_state::<crate::state::AppState>() else {
            return;
        };
        if let Ok(Some(run)) = state.db.get_task_run(&run_id) {
            if run.status.is_terminal() {
                lifecycle::finalize_task_run(&handle, &run);
            }
        }
    });
}
pub(crate) fn manager(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    app.try_state::<Arc<Runtime>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Plugin AI runtime unavailable".into())
}
pub(crate) async fn close_document(app: &AppHandle, id: &str) {
    lifecycle::close(app, None, None, Some(id), false).await
}
pub(crate) async fn close_window(app: &AppHandle, window: &str) {
    lifecycle::close(app, None, Some(window), None, false).await
}
pub(crate) async fn invalidate(app: &AppHandle, plugin: Option<&str>) {
    lifecycle::close(app, plugin, None, None, false).await
}
pub(crate) async fn stop(app: &AppHandle) {
    lifecycle::close(app, None, None, None, true).await
}
pub(crate) fn finalize_task_run(app: &AppHandle, run: &atools_core::task_run::TaskRun) {
    lifecycle::finalize_task_run(app, run)
}
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn runtime_state(app: &AppHandle) -> serde_json::Value {
    manager(app).map(|r|{let(requests,by_client,timers,acks,tombstones)=r.counts();serde_json::json!({
        "requests":requests,"byClient":by_client,"timers":timers,"pendingAcks":acks,"tombstones":tombstones
    })}).unwrap_or_else(|_|serde_json::json!({"requests":0,"byClient":0,"timers":0,"pendingAcks":0,"tombstones":0}))
}

fn owner_frame(
    window: &str,
    plugin: &str,
    instance: &str,
    generation: u64,
    nonce: String,
    doc: Option<String>,
) -> Result<(Owner, FrameBinding), String> {
    Ok((
        Owner::new(window, plugin, instance)?,
        FrameBinding::validate(generation, nonce, doc)?,
    ))
}
fn validate_identity(request: &Request, owner: &Owner, frame: &FrameBinding) -> Result<(), String> {
    if &request.owner != owner || &request.frame != frame || !request.valid() {
        return Err("AI request owner or document changed".into());
    }
    if request.document.as_ref().map(|d| d.id()) != frame.page_document_id.as_deref() {
        return Err("AI document identity changed".into());
    }
    Ok(())
}
