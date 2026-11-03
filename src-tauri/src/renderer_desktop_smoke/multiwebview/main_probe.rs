use super::{focus_observation::FocusObservation, Harness};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalSize, Window, Wry};
use tokio::sync::oneshot;

const REPORT_TIMEOUT: Duration = Duration::from_secs(5);
const WINDOW_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) async fn prepare_child_viewport(
    app: &AppHandle<Wry>,
    harness: &Harness,
    resource_path: &str,
) -> Result<(), &'static str> {
    let window =
        crate::window::main_window(app).map_err(|_| "multiwebview-main-window-unavailable")?;
    let scale = window
        .scale_factor()
        .map_err(|_| "multiwebview-main-window-scale-unavailable")?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err("multiwebview-main-window-scale-invalid");
    }
    let before = inner_height(&window).unwrap_or(0);
    let report = launch_main_probe(app, harness, "window-reset", resource_path).await;
    let issued = evidence_ok(report.as_ref().ok());
    let verified = issued && wait_for(|| logical_height_matches(&window, scale, 600)).await;
    let after = inner_height(&window).unwrap_or(0);
    harness.record(
        &["main", "windowJourney", "attachViewport"],
        json!({
            "beforeInnerHeightPhysical": before,
            "issued": issued,
            "verified": verified,
            "afterInnerHeightPhysical": after,
            "scaleFactor": scale,
        }),
    );
    if issued && verified {
        Ok(())
    } else {
        Err("multiwebview-child-viewport-reset-failed")
    }
}

pub(super) async fn prepare_reopen_viewport(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let window = match crate::window::main_window(app) {
        Ok(window) => window,
        Err(_) => {
            harness.record(
                &["cleanup", "reopenViewport"],
                json!({
                    "beforeInnerHeightPhysical": null,
                    "issued": false,
                    "verified": false,
                    "afterInnerHeightPhysical": null,
                    "scaleFactor": null,
                }),
            );
            return Err("multiwebview-reopen-main-window-unavailable");
        }
    };
    let scale = window
        .scale_factor()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0);
    let before = inner_height(&window);
    let issued = crate::window::reset_main_window(app).is_ok();
    let verified = if issued {
        if let Some(factor) = scale {
            wait_for(|| logical_height_matches(&window, factor, 600)).await
        } else {
            false
        }
    } else {
        false
    };
    let after = inner_height(&window);
    harness.record(
        &["cleanup", "reopenViewport"],
        json!({
            "beforeInnerHeightPhysical": before,
            "issued": issued,
            "verified": verified,
            "afterInnerHeightPhysical": after,
            "scaleFactor": scale,
        }),
    );
    if issued && verified {
        Ok(())
    } else {
        Err("multiwebview-reopen-viewport-reset-failed")
    }
}

pub(super) async fn verify_main_ipc(
    app: &AppHandle<Wry>,
    harness: &Harness,
    resource_path: &str,
) -> Result<(), &'static str> {
    let evidence = launch_main_probe(app, harness, "main-ipc", resource_path).await?;
    let settings = command_status(evidence.get("getGeneralSettings"), false);
    let visible = command_status(evidence.get("windowIsVisible"), true);
    let resource = command_status(evidence.get("resourceExists"), true);
    harness.record(&["main", "ipc", "getGeneralSettings"], json!(settings));
    harness.record(&["main", "ipc", "windowIsVisible"], json!(visible));
    harness.record(&["main", "ipc", "resourceExists"], json!(resource));
    if settings == "allowed" && visible == "allowed" && resource == "allowed" {
        Ok(())
    } else {
        Err("multiwebview-main-ipc-positive-proof-failed")
    }
}

pub(super) async fn verify_window_journey(
    app: &AppHandle<Wry>,
    harness: &Harness,
    resource_path: &str,
    child: &tauri::Webview<Wry>,
) -> Result<(), &'static str> {
    let window =
        crate::window::main_window(app).map_err(|_| "multiwebview-main-window-unavailable")?;
    let scale = window
        .scale_factor()
        .map_err(|_| "multiwebview-main-window-scale-unavailable")?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err("multiwebview-main-window-scale-invalid");
    }
    let mut passed = true;

    let expand = launch_main_probe(app, harness, "window-expand", resource_path).await;
    let expand_issued = evidence_ok(expand.as_ref().ok());
    let expand_verified = wait_for(|| logical_height_matches(&window, scale, 420)).await;
    let child_expand_settled =
        expand_verified && wait_for(|| super::child_bounds_are_valid(child)).await;
    let child_expand_recorded =
        super::record_child_bounds(harness, &["child", "boundsAfterExpandPhysical"], child).is_ok();
    let expand_height = inner_height(&window).unwrap_or(0);
    harness.record(
        &["main", "windowJourney", "expand"],
        json!({
            "issued": expand_issued,
            "verified": expand_issued && expand_verified,
            "childBoundsVerified": expand_issued && child_expand_settled && child_expand_recorded,
            "innerHeightPhysical": expand_height,
        }),
    );
    passed &= expand_issued && expand_verified && child_expand_settled && child_expand_recorded;

    let reset = launch_main_probe(app, harness, "window-reset", resource_path).await;
    let reset_issued = evidence_ok(reset.as_ref().ok());
    let reset_verified = wait_for(|| logical_height_matches(&window, scale, 600)).await;
    let child_reset_settled =
        reset_verified && wait_for(|| super::child_bounds_are_valid(child)).await;
    let child_reset_recorded =
        super::record_child_bounds(harness, &["child", "boundsAfterResetPhysical"], child).is_ok();
    let reset_height = inner_height(&window).unwrap_or(0);
    harness.record(
        &["main", "windowJourney", "reset"],
        json!({
            "issued": reset_issued,
            "verified": reset_issued && reset_verified,
            "childBoundsVerified": reset_issued && child_reset_settled && child_reset_recorded,
            "innerHeightPhysical": reset_height,
        }),
    );
    passed &= reset_issued && reset_verified && child_reset_settled && child_reset_recorded;

    let hide = launch_main_probe(app, harness, "window-hide", resource_path).await;
    let hide_issued = evidence_ok(hide.as_ref().ok());
    let hidden = wait_for(|| window.is_visible().is_ok_and(|visible| !visible)).await;
    harness.record(
        &["main", "windowJourney", "hide"],
        json!({"issued": hide_issued, "verified": hide_issued && hidden, "visible": !hidden}),
    );
    passed &= hide_issued && hidden;

    let show_result = crate::window::show_main_window(app).is_ok();
    let visible = wait_for(|| window.is_visible().is_ok_and(|value| value)).await;
    let focused = wait_for(|| window.is_focused().is_ok_and(|value| value)).await;
    harness.record(
        &["main", "windowJourney", "restore"],
        json!({"issued": show_result, "visible": show_result && visible, "focused": show_result && focused}),
    );
    passed &= show_result && visible && focused;

    let alive = launch_main_probe(app, harness, "main-alive", resource_path).await;
    let dom_alive = alive.as_ref().is_ok_and(|value| {
        value.get("ok").and_then(Value::as_bool) == Some(true)
            && value.get("path").and_then(Value::as_str) == Some("/")
    });
    harness.record(&["main", "windowJourney", "domAlive"], json!(dom_alive));
    passed &= dom_alive;

    if passed {
        Ok(())
    } else {
        Err("multiwebview-production-window-journey-failed")
    }
}

pub(super) async fn observe_main_dom_focus(
    app: &AppHandle<Wry>,
    harness: &Harness,
    resource_path: &str,
) -> Result<FocusObservation, &'static str> {
    let evidence = launch_main_probe(app, harness, "main-focus", resource_path).await?;
    if evidence.get("path").and_then(Value::as_str) != Some("/") {
        return Err("multiwebview-main-focus-observation-not-main-route");
    }
    FocusObservation::from_renderer_report(&evidence)
        .ok_or("multiwebview-main-focus-observation-invalid")
}

async fn launch_main_probe(
    app: &AppHandle<Wry>,
    harness: &Harness,
    operation: &str,
    resource_path: &str,
) -> Result<Value, &'static str> {
    let receiver = harness.begin_main(operation)?;
    let token = serde_json::to_string(&harness.token())
        .map_err(|_| "multiwebview-main-token-serialize-failed")?;
    let operation_literal = serde_json::to_string(operation)
        .map_err(|_| "multiwebview-main-operation-serialize-failed")?;
    let resource = serde_json::to_string(resource_path)
        .map_err(|_| "multiwebview-resource-path-serialize-failed")?;
    let script = include_str!("main-probe.js")
        .replace("__ATOOLS_MULTIWEBVIEW_TOKEN__", &token)
        .replace("__ATOOLS_MULTIWEBVIEW_OPERATION__", &operation_literal)
        .replace("__ATOOLS_MULTIWEBVIEW_RESOURCE__", &resource);
    let webview = match crate::window::main_webview(app) {
        Ok(webview) => webview,
        Err(_) => {
            harness.cancel_main(operation);
            return Err("multiwebview-main-webview-unavailable");
        }
    };
    if webview.eval(script).is_err() {
        harness.cancel_main(operation);
        return Err("multiwebview-main-probe-eval-failed");
    }
    tokio::time::timeout(REPORT_TIMEOUT, receiver)
        .await
        .map_err(|_| {
            harness.cancel_main(operation);
            "multiwebview-main-probe-timeout"
        })?
        .map_err(|_| "multiwebview-main-probe-interrupted")
}

pub(super) fn validate_main_webview(
    app: &AppHandle<Wry>,
    webview: &tauri::Webview<Wry>,
) -> Result<(), &'static str> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("multiwebview-probe-source-not-main-webview");
    }
    let url = webview
        .url()
        .map_err(|_| "multiwebview-probe-source-url-unavailable")?;
    let local_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    if !local_origin || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("multiwebview-probe-source-not-local-main-route");
    }
    let main =
        crate::window::main_webview(app).map_err(|_| "multiwebview-main-role-unavailable")?;
    let parent =
        crate::window::main_window(app).map_err(|_| "multiwebview-parent-role-unavailable")?;
    if main.label() != webview.label()
        || main.window().label() != "main"
        || parent.label() != "main"
        || !parent.webviews().iter().any(|item| item.label() == "main")
    {
        return Err("multiwebview-probe-source-main-identity-mismatch");
    }
    Ok(())
}

fn command_status(evidence: Option<&Value>, require_true: bool) -> &'static str {
    let Some(evidence) = evidence else {
        return "denied";
    };
    if evidence.get("ok").and_then(Value::as_bool) != Some(true) {
        return if evidence.get("code").and_then(Value::as_str) == Some("UNKNOWN_COMMAND") {
            "UNKNOWN_COMMAND"
        } else {
            "denied"
        };
    }
    if require_true && evidence.get("value").and_then(Value::as_bool) != Some(true) {
        return "allowed-false";
    }
    "allowed"
}

fn evidence_ok(evidence: Option<&Value>) -> bool {
    evidence
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        == Some(true)
}

async fn wait_for(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + WINDOW_TIMEOUT;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    condition()
}

fn logical_height_matches(window: &Window<Wry>, scale: f64, target: u32) -> bool {
    let Some(height) = inner_height(window) else {
        return false;
    };
    (f64::from(height) - f64::from(target) * scale).abs() <= scale * 3.0
}

fn inner_height(window: &Window<Wry>) -> Option<u32> {
    window
        .inner_size()
        .ok()
        .map(|size: PhysicalSize<u32>| size.height)
}
