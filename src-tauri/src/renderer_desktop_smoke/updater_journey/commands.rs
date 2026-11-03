use super::{
    probe,
    state::{Dom, STAGES},
    Harness,
};
use crate::renderer_updater::fixture_observation;
use std::sync::atomic::Ordering;
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    AppHandle, Manager, Webview, WebviewWindow, Window, WindowEvent, Wry,
};

pub(in crate::renderer_desktop_smoke) fn handler(
) -> impl Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static {
    let original: fn(tauri::ipc::Invoke<Wry>) -> bool =
        tauri::generate_handler![updater_journey_observe];
    move |invoke: tauri::ipc::Invoke<Wry>| {
        #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
        if super::about::handles(invoke.message.command()) {
            return super::about::dispatch(invoke);
        }
        original(invoke)
    }
}
pub(in crate::renderer_desktop_smoke) fn handles(command: &str) -> bool {
    command == "updater_journey_observe" || command == "updater_about_observe"
}

#[tauri::command]
async fn updater_journey_observe(
    window: WebviewWindow,
    app: AppHandle,
    token: String,
    stage: String,
    dom: serde_json::Value,
) -> Result<(), String> {
    let harness = app
        .try_state::<Harness>()
        .ok_or("updater-fixture-not-enabled")?;
    let outcome = (|| {
        if harness.profile.updater_about {
            return Err("updater-popup-mode-required".into());
        }
        if token.len() != 32 || token != harness.token.as_str() || !super::authorized(&app) {
            return Err("updater-probe-token-rejected".into());
        }
        if !STAGES.contains(&stage.as_str()) {
            return Err("updater-probe-stage-rejected".into());
        }
        let popup = stage.starts_with("popup-");
        fixture_observation::source(&window, popup)?;
        let dom = Dom::parse(dom)?;
        let native = fixture_observation::snapshot(&app)?;
        harness.accept(&stage, dom, native, window.label())
    })();
    if outcome.is_err() {
        harness.rejected.fetch_add(1, Ordering::AcqRel);
    }
    outcome
}

pub(in crate::renderer_desktop_smoke) fn on_page_load(
    webview: &Webview<Wry>,
    payload: &PageLoadPayload<'_>,
) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = webview.app_handle();
    #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
    if super::about_authorized(app) {
        super::about::on_page_load(webview, payload);
        return;
    }

    let Some(h) = app.try_state::<Harness>() else {
        return;
    };
    if !super::authorized(app) {
        return;
    }
    let main = webview.label() == "main" && webview.window().label() == "main";
    let popup = webview.label().starts_with("renderer-updater-")
        && webview.window().label() == webview.label();
    if !main && !popup {
        return;
    }
    let Some(window) = app.get_webview_window(webview.label()) else {
        return;
    };
    if fixture_observation::source(&window, popup).is_err() {
        return;
    }
    let injected = if main {
        &h.main_injected
    } else {
        &h.popup_injected
    };
    if injected.swap(true, Ordering::AcqRel) {
        return;
    }
    let stage = if main { "main-ready" } else { "popup-ready" };
    let script = format!("{};{}", probe::install(h.token.as_str()), probe::run(stage));
    if webview.eval(script).is_err() {
        eprintln!("updater-native-probe-install-failed");
    }
}
pub(in crate::renderer_desktop_smoke) fn on_window_event(
    window: &Window<Wry>,
    event: &WindowEvent,
) {
    #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
    if super::about_authorized(window.app_handle()) {
        super::about::on_window_event(window, event);
        return;
    }
    if matches!(event, WindowEvent::Destroyed) {
        if let Some(h) = window.app_handle().try_state::<Harness>() {
            h.note_destroyed(window.label());
        }
    }
}
