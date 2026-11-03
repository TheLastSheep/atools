//! Returns the hidden original renderer through its existing lifecycle channel.
use serde_json::json;
use tauri::{AppHandle, Emitter, EventTarget};

/// Invoked only by the host window's claimed one-shot timer. This does not show
/// or focus any native window and does not expose a new frontend command.
pub(crate) async fn return_to_search_after_hide(app: &AppHandle) -> Result<(), String> {
    let runtime = super::runtime(app)?;
    if let Some(session) = runtime.current()? {
        // Reuse the complete out acknowledgement, write accounting, child
        // release and session-scoped closed/back phases of the existing exit.
        return super::cleanup::close_session(app, &session.id, "escape").await;
    }

    crate::window::main_webview(app)
        .map_err(|_| "Main renderer is unavailable for automatic return".to_owned())?;
    app.emit_to(
        EventTarget::webview("main"),
        super::SETTINGS_EVENT,
        json!({"version":1,"phase":"auto-back-to-search"}),
    )
    .map_err(|_| "Main renderer did not accept automatic return".to_owned())
}
