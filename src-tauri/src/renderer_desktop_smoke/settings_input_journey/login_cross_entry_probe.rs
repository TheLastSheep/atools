use crate::renderer_desktop_smoke::settings_input_journey::state::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const TIMEOUT: Duration = Duration::from_secs(8);

pub(super) async fn fallback(
    app: &AppHandle<Wry>,
    harness: &Harness,
    webview: &Webview<Wry>,
    operation: &'static str,
) -> Result<Value, &'static str> {
    super::probe::settings_window_call_with_timeout(app, harness, webview, operation, TIMEOUT).await
}

pub(super) async fn vue_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::launch_at_login_probe::inspect(app, harness, child).await
}

pub(super) async fn vue_enable(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::launch_at_login_probe::click(app, harness, child, "enable").await
}

pub(super) async fn wait_fallback_loaded(
    app: &AppHandle<Wry>,
    harness: &Harness,
    webview: &Webview<Wry>,
) -> Result<Value, &'static str> {
    let evidence = fallback(app, harness, webview, "fallbackLoginInspect").await?;
    if evidence["ready"].as_bool() == Some(true)
        && evidence["controlUnique"].as_bool() == Some(true)
    {
        Ok(evidence)
    } else {
        Err(super::login_cross_entry_schema::FALLBACK_PROBE_INVALID)
    }
}

pub(super) fn vue_stage(value: &Value, action: bool) -> Value {
    let mut stage = super::login_cross_entry_schema::empty_stage("vue");
    stage["ready"] = value["routeGeneral"].clone();
    stage["controlUnique"] = value["controlUnique"].clone();
    stage["enabled"] = value["uiEnabled"].clone();
    stage["routeGeneral"] = value["routeGeneral"].clone();
    stage["getterEnabled"] = value["getterEnabled"].clone();
    if action {
        let dispatched = value["clickDispatched"].as_bool();
        stage["actionDispatched"] = dispatched.map(Value::Bool).unwrap_or(Value::Null);
        stage["actionSucceeded"] = Value::Bool(
            dispatched == Some(true)
                && value["routeGeneral"].as_bool() == Some(true)
                && value["controlUnique"].as_bool() == Some(true)
                && value["uiEnabled"].as_bool() == Some(true)
                && value["getterEnabled"].as_bool() == Some(true)
                && value["errorCode"].is_null(),
        );
    }
    stage
}
