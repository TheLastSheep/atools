use super::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_hotkey_raw_mutation(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    let operation = super::js_string("mainRawHotkeyMutation");
    super::main_call(
        app,
        harness,
        "mainRawHotkeyMutation",
        "mainHotkeyRawMutation",
        &[operation.as_str()],
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_main_hotkey_raw_mutation(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    let operation = super::js_string("childRawHotkeyMutation");
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childRawHotkeyMutation",
        "mainHotkeyRawMutation",
        &[operation.as_str()],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_main_hotkey_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childMainHotkeyInspect",
        "mainHotkeyInspect",
        &[],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_main_hotkey_record(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    code: &str,
    expected_display: &str,
    expected_stored: &str,
) -> Result<Value, &'static str> {
    let valid = matches!(
        (code, expected_display, expected_stored),
        (
            "F10",
            super::super::main_hotkey_schema::HOTKEY_A,
            super::super::main_hotkey_schema::HOTKEY_A
        ) | (
            "F11",
            super::super::main_hotkey_schema::HOTKEY_B,
            super::super::main_hotkey_schema::HOTKEY_B
        ) | (
            "F12",
            super::super::main_hotkey_schema::HOTKEY_B,
            super::super::main_hotkey_schema::HOTKEY_B
        )
    );
    if !valid {
        return Err("settings-input-probe-protocol-rejected");
    }
    let code = super::js_string(code);
    let expected_display = super::js_string(expected_display);
    let expected_stored = super::js_string(expected_stored);
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childMainHotkeyRecord",
        "mainHotkeyRecord",
        &[
            code.as_str(),
            expected_display.as_str(),
            expected_stored.as_str(),
        ],
        PROBE_TIMEOUT,
    )
    .await
}
