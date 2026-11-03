use super::{
    probe::{child_call_with_timeout, js_string},
    state::Harness,
};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    child_call_with_timeout(
        app,
        harness,
        child,
        "childLaunchAtLoginInspect",
        "launchAtLoginInspect",
        &[],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn click(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    mode: &'static str,
) -> Result<Value, &'static str> {
    if !matches!(mode, "enable" | "conflict") {
        return Err("settings-input-probe-protocol-rejected");
    }
    let mode = js_string(mode);
    child_call_with_timeout(
        app,
        harness,
        child,
        "childLaunchAtLoginClick",
        "launchAtLoginClick",
        &[mode.as_str()],
        PROBE_TIMEOUT,
    )
    .await
}
