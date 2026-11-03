use super::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_window_opacity_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childWindowOpacityInspect",
        "windowOpacityInspect",
        &[],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_window_opacity_set(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    opacity: f64,
) -> Result<Value, &'static str> {
    if opacity != 0.65 && opacity != 1.0 {
        return Err("settings-input-probe-protocol-rejected");
    }
    let opacity = format!("{opacity:.2}");
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childWindowOpacitySet",
        "windowOpacitySet",
        &[opacity.as_str()],
        PROBE_TIMEOUT,
    )
    .await
}
