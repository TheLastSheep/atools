use super::super::state::Harness;
use serde_json::Value;
use tauri::{AppHandle, Webview, Wry};

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_local_app_search_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::child_call(
        app,
        harness,
        child,
        "childLocalAppSearchInspect",
        "localAppSearchInspect",
        &[],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_local_app_search_toggle(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    expected_enabled: bool,
) -> Result<Value, &'static str> {
    super::child_call(
        app,
        harness,
        child,
        "childLocalAppSearchToggle",
        "localAppSearchToggle",
        &[if expected_enabled { "true" } else { "false" }],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_local_app_search(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
    should_be_present: bool,
    expected_timestamp_path: Option<&str>,
) -> Result<Value, &'static str> {
    let name = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    let expected = if should_be_present { "true" } else { "false" };
    let timestamp_path = super::js_string(expected_timestamp_path.unwrap_or(""));
    super::main_call(
        app,
        harness,
        "mainLocalAppSearchSearch",
        "localAppSearchMainSearch",
        &[
            name.as_str(),
            path.as_str(),
            expected,
            timestamp_path.as_str(),
        ],
    )
    .await
}
