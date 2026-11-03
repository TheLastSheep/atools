use super::*;
use serde_json::Value;
use tauri::{
    ipc::Invoke,
    webview::{PageLoadEvent, PageLoadPayload},
    Webview, Window, WindowEvent, Wry,
};
pub(in crate::renderer_desktop_smoke::updater_journey) fn handles(command: &str) -> bool {
    command == "updater_about_observe"
}
pub(in crate::renderer_desktop_smoke::updater_journey) fn dispatch(invoke: Invoke<Wry>) -> bool {
    let dispatch: fn(Invoke<Wry>) -> bool = tauri::generate_handler![updater_about_observe];
    dispatch(invoke)
}
#[tauri::command]
async fn updater_about_observe(
    app: AppHandle,
    webview: Webview,
    window: Window,
    token: String,
    stage: String,
    receipt: Value,
) -> Result<(), String> {
    let h = app.try_state::<Harness>().ok_or("about-harness-missing")?;
    let result = (|| {
        if token.len() != 32 || token != h.token.as_str() || !super::super::about_authorized(&app) {
            return Err("about-token-rejected".into());
        }
        let (kind, id) = auth::source(&app, &h, &webview, &window, &stage)?;
        state(&h)?.expect_stage(&stage)?;
        let (dom, receipt) = protocol::parse(receipt)?;
        if kind == "child"
            && dom["bundleRevision"] != crate::renderer_settings_view::bundle::compiled_revision()?
        {
            return Err("about-child-bundle-rejected".into());
        }
        let row = facts::row(
            &app,
            &h,
            &stage,
            kind,
            Some(webview.label()),
            id.as_deref(),
            dom,
            receipt,
        )?;
        state(&h)?.accept(row, &h)
    })();
    if result.is_err() {
        h.rejected.fetch_add(1, Ordering::AcqRel);
    }
    result
}
pub(in crate::renderer_desktop_smoke::updater_journey) fn on_page_load(
    view: &Webview,
    payload: &PageLoadPayload<'_>,
) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = view.app_handle();
    let Some(h) = app.try_state::<Harness>() else {
        return;
    };
    if !super::super::about_authorized(app) {
        return;
    }
    let Ok(s) = state(&h) else { return };
    let main = view.label() == "main" && view.window().label() == "main";
    let popup =
        view.label().starts_with("renderer-updater-") && view.window().label() == view.label();
    if main || popup {
        let Some(window) = app.get_webview_window(view.label()) else {
            return;
        };
        if crate::renderer_updater::fixture_observation::source(&window, popup).is_err() {
            return;
        }
        if popup {
            *s.popup_label.lock() = Some(view.label().into());
        }
    } else {
        if auth::child(app, view, &view.window(), false).is_err() || s.bind(view).is_err() {
            return;
        }
    }
    if !s.injections.lock().insert(view.label().into()) {
        return;
    }
    let script = if main {
        format!(
            "{};{}",
            probe::install(h.token.as_str()),
            probe::run("main-ready")
        )
    } else {
        probe::install(h.token.as_str())
    };
    if view.eval(script).is_err() {
        eprintln!("about-probe-install-failed");
    }
    h.changed.notify_waiters();
}
pub(in crate::renderer_desktop_smoke::updater_journey) fn on_window_event(
    window: &Window,
    event: &WindowEvent,
) {
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    let Some(h) = app.try_state::<Harness>() else {
        return;
    };
    if !super::super::about_authorized(app) {
        return;
    }
    if state(&h).is_ok_and(|s| s.popup_label.lock().as_deref() == Some(window.label())) {
        h.destroyed.fetch_add(1, Ordering::AcqRel);
        h.changed.notify_waiters();
    }
}
