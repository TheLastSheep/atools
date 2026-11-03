//! Passive, exact-owned-fixture observation. No new renderer permissions or arbitrary labels.
use super::*;
use tauri::WebviewWindow;

pub(crate) fn source(window: &WebviewWindow, popup: bool) -> Result<(), String> {
    let app = window.app_handle();
    if !crate::renderer_desktop_smoke::updater_journey::authorized(app) {
        return Err("updater-fixture-not-authorized".into());
    }
    if popup {
        let id = runtime(app)
            .map_err(|_| "updater-fixture-runtime-missing")?
            .session
            .lock()
            .as_ref()
            .map(|s| s.id.clone())
            .ok_or("updater-fixture-session-missing")?;
        identity::popup(window, &id, false).map_err(|_| "updater-fixture-popup-source-invalid")?;
    } else {
        identity::main(window).map_err(|_| "updater-fixture-main-source-invalid")?;
    }
    Ok(())
}
pub(crate) fn snapshot(app: &AppHandle) -> Result<serde_json::Value, String> {
    if !crate::renderer_desktop_smoke::updater_journey::authorized(app) {
        return Err("updater-fixture-not-authorized".into());
    }
    let runtime = runtime(app).map_err(|_| "updater-fixture-runtime-missing")?;
    let session = runtime.session.lock().clone();
    let window = session
        .as_ref()
        .and_then(|s| app.get_webview_window(&s.label));
    let actual=window.as_ref().map(|w|serde_json::json!({"exists":true,"visible":w.is_visible().ok(),"focused":w.is_focused().ok(),"url":w.url().ok().map(|u|u.to_string())}));
    let session=session.map(|s|serde_json::json!({"windowId":s.id,"label":s.label,"ready":s.ready,
        "alive":s.alive.load(Ordering::Acquire),"closing":s.closing.load(Ordering::Acquire),"candidateId":s.candidate,"lastSequence":s.last_sequence}));
    let main = app
        .get_webview_window("main")
        .map(|w| serde_json::json!({"visible":w.is_visible().ok(),"focused":w.is_focused().ok()}));
    let count = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("renderer-updater-"))
        .count();
    let coordinator = coordinator(app).map_err(|_| "updater-fixture-coordinator-missing")?;
    let busy = coordinator.operation_busy();
    let state = coordinator
        .view()
        .map_err(|_| "updater-fixture-state-invalid")?;
    Ok(
        serde_json::json!({"session":session,"window":actual,"main":main,"opening":runtime.opening.load(Ordering::Acquire),"windowCount":count,
        "busy":busy,"phase":state.phase,"operationId":state.operation_id,"candidateId":state.candidate.map(|c|c.candidate_id),"sequence":state.sequence,"errorCode":state.error.map(|e|e.code)}),
    )
}
