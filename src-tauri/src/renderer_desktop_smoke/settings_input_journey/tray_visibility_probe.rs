use super::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_tray_visibility_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childTrayVisibilityInspect",
        "trayVisibilityInspect",
        &[],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_tray_visibility_set(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    enabled: bool,
) -> Result<Value, &'static str> {
    let enabled = if enabled { "true" } else { "false" };
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childTrayVisibilitySet",
        "trayVisibilitySet",
        &[enabled],
        PROBE_TIMEOUT,
    )
    .await
}
