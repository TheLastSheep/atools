use super::super::state::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const TIMEOUT: Duration = Duration::from_secs(8);

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::super::probe::child_call_with_timeout(
        app,
        harness,
        child,
        "childHotkeyStartupInspect",
        "hotkeyStartupInspect",
        &[],
        TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn edit_placeholder(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    before: &str,
    after: &str,
) -> Result<Value, &'static str> {
    let before = super::super::probe::js_string(before);
    let after = super::super::probe::js_string(after);
    super::super::probe::child_call_with_timeout(
        app,
        harness,
        child,
        "childHotkeyStartupPlaceholder",
        "hotkeyStartupEditPlaceholder",
        &[before.as_str(), after.as_str()],
        TIMEOUT,
    )
    .await
}
