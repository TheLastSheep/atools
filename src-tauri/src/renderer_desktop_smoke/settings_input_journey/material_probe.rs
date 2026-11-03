use super::Harness;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const MATERIAL_INSPECT_TIMEOUT: Duration = Duration::from_millis(250);
const MATERIAL_NAVIGATE_TIMEOUT: Duration = Duration::from_secs(3);
const MATERIAL_SELECT_TIMEOUT: Duration = Duration::from_millis(1500);
const MATERIAL_SNAPSHOT_TIMEOUT: Duration = Duration::from_millis(1500);

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_theme_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    super::main_call_with_timeout(
        app,
        harness,
        "mainThemeInspect",
        "inspectMainTheme",
        &[],
        MATERIAL_INSPECT_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_theme_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childThemeInspect",
        "inspectCurrentTheme",
        &[],
        MATERIAL_INSPECT_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_theme_navigate(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childThemeNavigate",
        "navigateGeneral",
        &[],
        MATERIAL_NAVIGATE_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_theme_select(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    theme: &str,
) -> Result<Value, &'static str> {
    let theme = super::js_string(theme);
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childThemeSelect",
        "selectGeneralTheme",
        &[theme.as_str()],
        MATERIAL_SELECT_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_snapshot_ready(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    theme: &str,
) -> Result<Value, &'static str> {
    if !matches!(theme, "light" | "dark") {
        return Err("settings-input-probe-protocol-rejected");
    }
    let theme = super::js_string(theme);
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childSnapshotReady",
        "childSnapshotReady",
        &[theme.as_str()],
        MATERIAL_SNAPSHOT_TIMEOUT,
    )
    .await
}

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn child_paint_diagnostic(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    theme: &str,
) -> Result<Value, &'static str> {
    if !matches!(theme, "light" | "dark") {
        return Err("settings-input-probe-protocol-rejected");
    }
    let theme = super::js_string(theme);
    super::child_call_with_timeout(
        app,
        harness,
        child,
        "childPaintDiagnostic",
        "childPaintDiagnostic",
        &[theme.as_str()],
        MATERIAL_SNAPSHOT_TIMEOUT,
    )
    .await
}
