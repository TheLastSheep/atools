use super::super::state::Harness;
use serde_json::Value;
use tauri::{AppHandle, Webview, Wry};

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_availability_baseline(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
) -> Result<Value, &'static str> {
    let name = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    super::child_call(
        app,
        harness,
        child,
        "childAvailabilityBaseline",
        "commandAvailabilityChildBaseline",
        &[name.as_str(), path.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_availability_disable(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
) -> Result<Value, &'static str> {
    child_toggle(app, harness, child, target, "disable").await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_availability_enable(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
) -> Result<Value, &'static str> {
    child_toggle(app, harness, child, target, "enable").await
}

async fn child_toggle(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
    action: &'static str,
) -> Result<Value, &'static str> {
    let operation = if action == "disable" {
        "childAvailabilityDisable"
    } else {
        "childAvailabilityEnable"
    };
    let action = super::js_string(action);
    let name = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    super::child_call(
        app,
        harness,
        child,
        operation,
        "commandAvailabilityToggleDisabled",
        &[action.as_str(), name.as_str(), path.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_availability_disabled_read_back(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    command_id: &str,
) -> Result<Value, &'static str> {
    child_read_back(app, harness, child, command_id, true).await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_availability_enabled_read_back(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    command_id: &str,
) -> Result<Value, &'static str> {
    child_read_back(app, harness, child, command_id, false).await
}

async fn child_read_back(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    command_id: &str,
    should_be_disabled: bool,
) -> Result<Value, &'static str> {
    let command_id = super::js_string(command_id);
    let operation = if should_be_disabled {
        "childAvailabilityDisabledReadBack"
    } else {
        "childAvailabilityEnabledReadBack"
    };
    super::child_call(
        app,
        harness,
        child,
        operation,
        "commandAvailabilityReadDisabled",
        &[
            command_id.as_str(),
            if should_be_disabled { "true" } else { "false" },
        ],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_command_availability(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
    should_be_present: bool,
) -> Result<Value, &'static str> {
    let query = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    super::main_call(
        app,
        harness,
        "mainCommandAvailability",
        "commandAvailabilityMainSearch",
        &[
            query.as_str(),
            path.as_str(),
            if should_be_present { "true" } else { "false" },
        ],
    )
    .await
}
