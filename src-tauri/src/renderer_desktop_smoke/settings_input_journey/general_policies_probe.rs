use super::{
    probe::{child_call_with_timeout, js_string},
    state::Harness,
};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_general_policies_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    child_call_with_timeout(
        app,
        harness,
        child,
        "childGeneralPoliciesInspect",
        "generalPoliciesInspect",
        &[],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_general_policies_select_strategy(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    strategy: &str,
) -> Result<Value, &'static str> {
    if !matches!(strategy, "remember" | "cursor" | "primary" | "lastActive") {
        return Err("settings-input-probe-protocol-rejected");
    }
    let strategy = js_string(strategy);
    child_call_with_timeout(
        app,
        harness,
        child,
        "childGeneralPoliciesSelectStrategy",
        "generalPoliciesSelectStrategy",
        &[strategy.as_str()],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_general_policies_set_retention(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    days: u64,
) -> Result<Value, &'static str> {
    if !(1..=3650).contains(&days) {
        return Err("settings-input-probe-protocol-rejected");
    }
    let days = days.to_string();
    child_call_with_timeout(
        app,
        harness,
        child,
        "childGeneralPoliciesSetRetention",
        "generalPoliciesSetRetention",
        &[days.as_str()],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_general_policies_reset_retention(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    child_call_with_timeout(
        app,
        harness,
        child,
        "childGeneralPoliciesResetRetention",
        "generalPoliciesResetRetention",
        &[],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_general_policies_auto_back_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    child_call_with_timeout(
        app,
        harness,
        child,
        "childGeneralPoliciesAutoBackInspect",
        "generalPoliciesAutoBackInspect",
        &[],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_general_policies_auto_back_select(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    value: &str,
) -> Result<Value, &'static str> {
    if !matches!(
        value,
        "immediately" | "30s" | "1m" | "3m" | "5m" | "10m" | "never"
    ) {
        return Err("settings-input-probe-protocol-rejected");
    }
    let value = js_string(value);
    child_call_with_timeout(
        app,
        harness,
        child,
        "childGeneralPoliciesAutoBackSelect",
        "generalPoliciesAutoBackSelect",
        &[value.as_str()],
        PROBE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_general_policies_auto_back_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    super::probe::main_call(
        app,
        harness,
        "mainGeneralPoliciesAutoBackInspect",
        "generalPoliciesAutoBackMainInspect",
        &[],
    )
    .await
}
