use super::super::super::observations::{self, NativeObservation, Stage, FOCUS_TARGET_LABEL};
use super::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{
    ipc::Invoke,
    webview::{PageLoadEvent, PageLoadPayload},
    AppHandle, Manager, State, Webview, Window, WindowEvent, Wry,
};
use tokio::sync::oneshot;

const MAIN_LABEL: &str = "main";
pub(in crate::renderer_desktop_smoke) fn handler(
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![renderer_probe_ready, renderer_probe_observe]
}

pub(in crate::renderer_desktop_smoke) fn handles(command: &str) -> bool {
    matches!(command, "renderer_probe_ready" | "renderer_probe_observe")
}

pub(in crate::renderer_desktop_smoke) fn on_page_load(
    webview: &Webview<Wry>,
    payload: &PageLoadPayload<'_>,
) {
    if payload.event() != PageLoadEvent::Finished
        || webview.label() != MAIN_LABEL
        || webview.window().label() != MAIN_LABEL
        || !is_local_root_url(payload.url())
    {
        return;
    }
    let app = webview.app_handle();
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    let primary = match validate_main_webview(&app, webview) {
        Ok(primary) => primary,
        Err(_) => {
            harness.note_error("main-webview-unavailable-on-root-load");
            return;
        }
    };
    if !harness.mark_probe_injected() {
        return;
    }

    if observations::incognito_data_store_persistent(webview).is_err() {
        harness.record_incognito(None);
    }

    let token = serde_json::to_string(&harness.0.token).unwrap_or_else(|_| "null".into());
    let auto_clear = serde_json::to_string(harness.auto_clear()).unwrap_or_else(|_| "null".into());
    let script = include_str!("probe.js")
        .replace("\"__ATOOLS_RENDERER_SMOKE_TOKEN__\"", &token)
        .replace("\"__ATOOLS_RENDERER_SMOKE_AUTO_CLEAR__\"", &auto_clear);
    if primary.eval(script).is_err() {
        harness.note_error("renderer-probe-injection-failed");
    }

    #[cfg(feature = "legacy-node-smoke")]
    if harness.profile().launcher_journey {
        let Some(launcher_harness) =
            app.try_state::<super::super::super::launcher_journey::Harness>()
        else {
            harness.note_error("launcher-renderer-probe-not-ready");
            return;
        };
        if super::super::super::launcher_journey::inject(&primary, &launcher_harness).is_err() {
            harness.note_error("launcher-renderer-probe-not-ready");
        }
    }
}

pub(in crate::renderer_desktop_smoke) fn is_local_root_url(url: &tauri::Url) -> bool {
    let host = url.host_str();
    let local_app_origin = match url.scheme() {
        "tauri" => host == Some("localhost"),
        "http" | "https" => host == Some("tauri.localhost"),
        _ => false,
    };
    local_app_origin && url.path() == "/" && url.query().is_none() && url.fragment().is_none()
}

pub(in crate::renderer_desktop_smoke) fn record_window_event(
    window: &Window<Wry>,
    event: &WindowEvent,
) {
    let label = match window.label() {
        MAIN_LABEL => MAIN_LABEL,
        FOCUS_TARGET_LABEL => FOCUS_TARGET_LABEL,
        _ => return,
    };
    let event = match event {
        WindowEvent::Focused(true) => "focus-gained",
        WindowEvent::Focused(false) => "focus-lost",
        WindowEvent::CloseRequested { .. } => "close-requested",
        WindowEvent::Destroyed => "destroyed",
        _ => return,
    };
    if let Some(state) = window.app_handle().try_state::<Harness>() {
        state.record_window_event(label, event);
    }
}

fn validate_main_webview(
    app: &AppHandle,
    webview: &Webview<Wry>,
) -> Result<Webview<Wry>, &'static str> {
    if webview.label() != MAIN_LABEL {
        return Err("renderer-command-source-is-not-main-webview");
    }
    if webview.window().label() != MAIN_LABEL {
        return Err("renderer-command-source-parent-is-not-main-window");
    }
    if !is_local_root_url(
        &webview
            .url()
            .map_err(|_| "renderer-webview-url-unavailable")?,
    ) {
        return Err("renderer-command-source-is-not-local-root-route");
    }
    let primary = crate::window::main_webview(app)
        .map_err(|_| "renderer-command-main-webview-unavailable")?;
    if primary.label() != webview.label() || primary.window().label() != MAIN_LABEL {
        return Err("renderer-command-main-window-identity-mismatch");
    }
    Ok(primary)
}

#[tauri::command]
fn renderer_probe_ready(
    app: AppHandle,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    evidence: Value,
) -> Result<(), String> {
    validate_main_webview(&app, &webview).map_err(str::to_string)?;
    (*harness)
        .accept_readiness(&token, evidence)
        .map_err(str::to_string)
}

#[tauri::command]
async fn renderer_probe_observe(
    app: AppHandle,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    stage: String,
    dom: Value,
) -> Result<(), String> {
    validate_main_webview(&app, &webview).map_err(str::to_string)?;
    let harness = (*harness).clone();
    if !harness.token_matches(&token) {
        return Err("renderer-probe-token-rejected".into());
    }
    let stage = Stage::parse(&stage).ok_or("renderer-stage-name-rejected")?;
    let native = match capture_native(&app, &harness).await {
        Ok(native) => native,
        Err(error) => {
            harness.reject_capture(stage, error);
            return Err(error.into());
        }
    };
    harness
        .accept_observation(stage, dom, native)
        .map_err(str::to_string)
}

async fn capture_native(
    app: &AppHandle,
    harness: &Harness,
) -> Result<NativeObservation, &'static str> {
    let (sender, receiver) = oneshot::channel();
    let observed_app = app.clone();
    let incognito = harness.incognito_persistent();
    app.run_on_main_thread(move || {
        let result = crate::window::main_window(&observed_app)
            .map_err(|_| "main-window-native-snapshot-unavailable")
            .map(|window| NativeObservation::capture(&window, incognito));
        let _ = sender.send(result);
    })
    .map_err(|_| "main-thread-native-snapshot-dispatch-failed")?;
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "main-thread-native-snapshot-timeout")?
        .map_err(|_| "main-thread-native-snapshot-interrupted")?
}

impl Harness {
    pub(in crate::renderer_desktop_smoke) fn incognito_persistent(&self) -> Option<bool> {
        let state = self.0.state.lock();
        state
            .incognito_observed
            .then_some(state.incognito_persistent)
            .flatten()
    }
}
