#![cfg(feature = "ztools-multiwebview")]

mod child;
mod focus_handoff;
mod focus_observation;
mod main_probe;
mod observations;
mod state;

use serde_json::{json, Value};
use std::time::Duration;
use tauri::{ipc::Invoke, AppHandle, Manager, State, Wry};
use tokio::sync::oneshot;

pub(super) use state::Harness;

const CHILD_REPORT_TIMEOUT: Duration = Duration::from_secs(10);
const CHILD_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) fn handles(command: &str) -> bool {
    command == "multiwebview_probe"
}

pub(super) fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![multiwebview_probe]
}

pub(super) async fn prepare_and_verify(app: &AppHandle<Wry>) -> Result<(), &'static str> {
    let harness = app
        .try_state::<Harness>()
        .map(|state| (*state).clone())
        .ok_or("multiwebview-harness-state-unavailable")?;
    if app.get_webview(child::CHILD_LABEL).is_some() {
        harness.record_error("multiwebview-child-label-already-owned");
        return Err("multiwebview-child-label-already-owned");
    }
    let result = prepare_inner(app, &harness).await;
    if let Err(error) = result {
        harness.record_error(error);
        if harness.snapshot()["child"]["created"] == Value::Bool(true)
            || app.get_webview(child::CHILD_LABEL).is_some()
        {
            if close_and_wait(app, &harness).await.is_err() {
                harness.record_error("multiwebview-prepare-failure-child-cleanup-failed");
            }
            harness.record(
                &["cleanup", "finalChildAbsent"],
                json!(app.get_webview(child::CHILD_LABEL).is_none()),
            );
            harness.record(&["cleanup", "liveChildren"], json!(live_child_count(app)));
        }
        return Err(error);
    }
    harness.record(&["prepareCompleted"], json!(true));
    Ok(())
}

async fn prepare_inner(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let resource_path = child::resource_probe_path()?;
    let resource = resource_path
        .to_str()
        .ok_or("multiwebview-resource-path-not-utf8")?;
    main_probe::prepare_child_viewport(app, harness, resource).await?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let receiver = harness.begin_child(nonce.clone(), 1, "proof")?;
    let child = match child::create(app, harness, &nonce, 1, &resource_path) {
        Ok(child) => child,
        Err(error) => {
            harness.cancel_child(1);
            return Err(error);
        }
    };
    harness.record(&["child", "created"], json!(true));
    harness.record(&["child", "parentLabel"], json!(child.window().label()));
    record_child_bounds(harness, &["child", "boundsPhysical"], &child)?;

    capture_identity(app, harness, &child)?;
    let persistent = observations::incognito_data_store_persistent(&child).await?;
    harness.record(&["child", "incognitoPersistent"], json!(persistent));

    let report = await_child_report(harness, receiver, 1).await?;
    if !child_report_passes(&report, 1) || persistent {
        return Err("multiwebview-initial-child-denial-or-incognito-check-failed");
    }
    focus_handoff::verify(app, harness, &child, &nonce, resource).await?;
    main_probe::verify_main_ipc(app, harness, resource).await?;
    main_probe::verify_window_journey(app, harness, resource, &child).await?;
    Ok(())
}

pub(super) async fn cleanup(app: &AppHandle<Wry>) -> Result<(), &'static str> {
    let harness = app
        .try_state::<Harness>()
        .map(|state| (*state).clone())
        .ok_or("multiwebview-harness-state-unavailable")?;
    let prepared = harness.snapshot()["prepareCompleted"] == Value::Bool(true);
    let initial_child_present = app.get_webview(child::CHILD_LABEL).is_some();
    let first_close = initial_child_present && close_and_wait(app, &harness).await.is_ok();
    harness.record(
        &["cleanup", "initialCloseObservedAbsent"],
        json!(first_close),
    );
    if !first_close {
        harness.record_error("multiwebview-initial-child-close-not-observed");
    }

    let mut reopen_passed = false;
    if prepared && first_close {
        let result = reopen_probe_and_close(app, &harness).await;
        reopen_passed = result.is_ok();
        if let Err(error) = result {
            harness.record_error(error);
            if harness.snapshot()["cleanup"]["reopenCreated"] == Value::Bool(true) {
                let closed = close_and_wait(app, &harness).await.is_ok();
                harness.record(&["cleanup", "reopenedChildClosed"], json!(closed));
            }
        }
    } else {
        harness.record_error("multiwebview-cleanup-before-prepare-complete");
    }

    let final_absent = app.get_webview(child::CHILD_LABEL).is_none();
    let live = live_child_count(app);
    let layout_lease_cleared = !harness.has_layout_lease();
    harness.record(
        &["cleanup", "layoutLeaseCleared"],
        json!(layout_lease_cleared),
    );
    let live_layout_registrations = crate::window::main_child_layout_active_count(app);
    let layout_registrations = match live_layout_registrations {
        Ok(count) => {
            harness.record(&["cleanup", "liveLayoutRegistrations"], json!(count));
            Some(count)
        }
        Err(_) => {
            harness.record_error("multiwebview-layout-registration-count-unavailable");
            None
        }
    };
    harness.record(&["cleanup", "finalChildAbsent"], json!(final_absent));
    harness.record(&["cleanup", "liveChildren"], json!(live));
    let cleanup_passed = prepared
        && first_close
        && reopen_passed
        && final_absent
        && live == 0
        && layout_lease_cleared
        && layout_registrations == Some(0);
    if !final_absent || live != 0 {
        harness.record_error("multiwebview-final-child-remains");
    }
    if !layout_lease_cleared || layout_registrations.is_some_and(|count| count != 0) {
        harness.record_error("multiwebview-layout-registration-remains");
    }
    let errors_empty = harness.snapshot()["errors"]
        .as_array()
        .is_some_and(Vec::is_empty);
    harness.set_passed(cleanup_passed && errors_empty);
    if cleanup_passed && errors_empty {
        Ok(())
    } else {
        Err("multiwebview-cleanup-or-acceptance-failed")
    }
}

async fn reopen_probe_and_close(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let resource_path = child::resource_probe_path()?;
    main_probe::prepare_reopen_viewport(app, harness).await?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let receiver = harness.begin_child(nonce.clone(), 2, "proof")?;
    let webview = match child::create(app, harness, &nonce, 2, &resource_path) {
        Ok(webview) => webview,
        Err(error) => {
            harness.cancel_child(2);
            return Err(error);
        }
    };
    harness.record(&["cleanup", "reopenCreated"], json!(true));
    record_child_bounds(harness, &["cleanup", "reopenBoundsPhysical"], &webview)?;
    let child_identity_matches =
        webview.window().label() == "main" && webview.label() == child::CHILD_LABEL;
    let report = await_child_report(harness, receiver, 2).await?;
    let fresh = report.get("freshDocument").and_then(Value::as_bool) == Some(true);
    harness.record(
        &["cleanup", "documentIdentityFreshOnReopen"],
        json!(fresh && child_identity_matches),
    );
    if !child_identity_matches || !fresh || !child_report_passes(&report, 2) {
        let _ = close_and_wait(app, harness).await;
        harness.record(
            &["cleanup", "reopenedChildClosed"],
            json!(app.get_webview(child::CHILD_LABEL).is_none()),
        );
        return Err("multiwebview-reopened-child-proof-failed");
    }
    let closed = close_and_wait(app, harness).await.is_ok();
    harness.record(&["cleanup", "reopenedChildClosed"], json!(closed));
    if closed {
        Ok(())
    } else {
        Err("multiwebview-reopened-child-close-failed")
    }
}

pub(super) async fn await_child_report(
    harness: &Harness,
    receiver: oneshot::Receiver<Value>,
    generation: u8,
) -> Result<Value, &'static str> {
    match tokio::time::timeout(CHILD_REPORT_TIMEOUT, receiver).await {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(_)) => Err("multiwebview-child-report-interrupted"),
        Err(_) => {
            harness.cancel_child(generation);
            Err("multiwebview-child-report-timeout")
        }
    }
}

async fn close_and_wait(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    if let Some(child) = app.get_webview(child::CHILD_LABEL) {
        child
            .close()
            .map_err(|_| "multiwebview-child-close-request-failed")?;
    }
    tokio::time::timeout(CHILD_CLOSE_TIMEOUT, async {
        while app.get_webview(child::CHILD_LABEL).is_some() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "multiwebview-child-close-not-observed")?;
    let lease = harness.take_layout_lease();
    drop(lease);
    if harness.has_layout_lease() {
        return Err("multiwebview-child-layout-lease-not-cleared");
    }
    harness.record(&["cleanup", "layoutLeaseCleared"], json!(true));
    Ok(())
}

fn live_child_count(app: &AppHandle<Wry>) -> usize {
    crate::window::main_window(app)
        .map(|window| {
            window
                .webviews()
                .iter()
                .filter(|webview| webview.label() == child::CHILD_LABEL)
                .count()
        })
        .unwrap_or(usize::MAX)
}

pub(super) fn child_bounds_are_valid(child: &tauri::Webview<Wry>) -> bool {
    inspect_child_bounds(child).is_ok_and(|(_, valid)| valid)
}

pub(super) fn record_child_bounds(
    harness: &Harness,
    path: &[&str],
    child: &tauri::Webview<Wry>,
) -> Result<(), &'static str> {
    let (bounds, valid) = inspect_child_bounds(child)?;
    harness.record(path, bounds);
    if valid {
        Ok(())
    } else {
        Err("multiwebview-child-bounds-verification-failed")
    }
}

fn inspect_child_bounds(child: &tauri::Webview<Wry>) -> Result<(Value, bool), &'static str> {
    let position = child
        .position()
        .map_err(|_| "multiwebview-child-position-unavailable")?;
    let size = child
        .size()
        .map_err(|_| "multiwebview-child-size-unavailable")?;
    let parent = child.window();
    let parent_size = parent
        .inner_size()
        .map_err(|_| "multiwebview-parent-size-unavailable")?;
    let scale = parent
        .scale_factor()
        .map_err(|_| "multiwebview-parent-scale-unavailable")?;
    if !scale.is_finite() || scale <= 0.0 || parent_size.width == 0 || parent_size.height == 0 {
        return Err("multiwebview-parent-bounds-invalid");
    }
    let parent_height_logical = f64::from(parent_size.height) / scale;
    if parent_height_logical <= 65.0 {
        return Err("multiwebview-parent-viewport-insufficient");
    }
    let reserved_top_logical = 64.0;
    let min_child_height_logical = (parent_height_logical - reserved_top_logical).min(120.0);
    let right = i64::from(position.x) + i64::from(size.width);
    let bottom = i64::from(position.y) + i64::from(size.height);
    let fits_parent = position.x >= 0
        && position.y >= 0
        && right <= i64::from(parent_size.width) + 2
        && bottom <= i64::from(parent_size.height) + 2;
    let width_fills_parent =
        (i64::from(size.width) - i64::from(parent_size.width)).abs() <= (scale * 3.0) as i64;
    let top_reserved = (f64::from(position.y) / scale - reserved_top_logical).abs() <= 3.0;
    let logical_child_height = f64::from(size.height) / scale;
    let minimum_height_satisfied = size.height > 0
        && logical_child_height > 0.0
        && logical_child_height + 3.0 >= min_child_height_logical;
    let content_height_fills_parent =
        (bottom - i64::from(parent_size.height)).abs() as f64 <= 3.0 * scale;
    let bounds = json!({
        "x":position.x,
        "y":position.y,
        "width":size.width,
        "height":size.height,
        "parentWidth":parent_size.width,
        "parentHeight":parent_size.height,
        "scaleFactor":scale,
        "fitsParent":fits_parent,
        "widthFillsParent":width_fills_parent,
        "topReservedLogical":f64::from(position.y) / scale,
        "headerReservationVerified":top_reserved,
        "minimumHeightSatisfied":minimum_height_satisfied,
        "contentHeightFillsParent":content_height_fills_parent,
    });
    Ok((
        bounds,
        fits_parent
            && width_fills_parent
            && top_reserved
            && minimum_height_satisfied
            && content_height_fills_parent,
    ))
}

fn capture_identity(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &tauri::Webview<Wry>,
) -> Result<(), &'static str> {
    let parent =
        crate::window::main_window(app).map_err(|_| "multiwebview-main-window-unavailable")?;
    let main =
        crate::window::main_webview(app).map_err(|_| "multiwebview-main-webview-unavailable")?;
    let mut labels = parent
        .webviews()
        .iter()
        .map(|webview| webview.label().to_string())
        .collect::<Vec<_>>();
    labels.sort();
    let get_main_webview_window_absent = app.get_webview_window("main").is_none();
    let main_window_present = app.get_window("main").is_some() && parent.label() == "main";
    let main_role_present = app.get_webview("main").is_some()
        && main.label() == "main"
        && main.window().label() == "main";
    let child_role_present = app.get_webview(child::CHILD_LABEL).is_some()
        && child.label() == child::CHILD_LABEL
        && child.window().label() == "main";
    let labels_match = labels == vec!["main".to_string(), child::CHILD_LABEL.to_string()];
    harness.record(
        &["identity"],
        json!({
            "mainWindowLabel": "main",
            "parentLabel": parent.label(),
            "parentWebviews": labels,
            "mainWindowLookup": if main_window_present { "present" } else { "absent" },
            "getWebviewWindowMain": if get_main_webview_window_absent { "absent" } else { "present" },
            "mainWebviewRole": if main_role_present { "present" } else { "absent" },
            "mainWebviewParent": main.window().label(),
            "childWebviewRole": if child_role_present { "present" } else { "absent" },
            "parentIsWebviewWindow": {
                "value": !get_main_webview_window_absent,
                "basis": "public-webview-window-lookup-absent"
            }
        }),
    );
    harness.record(&["child", "label"], json!(child.label()));
    if !get_main_webview_window_absent
        || !main_window_present
        || !main_role_present
        || !child_role_present
        || !labels_match
    {
        return Err("multiwebview-parent-window-identity-proof-failed");
    }
    Ok(())
}

fn child_report_passes(report: &Value, generation: u8) -> bool {
    report.get("generation").and_then(Value::as_u64) == Some(u64::from(generation))
        && report.get("ipc").is_some_and(child_ipc_passes)
        && (generation != 2 || report.get("freshDocument").and_then(Value::as_bool) == Some(true))
}

fn child_ipc_passes(ipc: &Value) -> bool {
    ipc.get("getGeneralSettings").is_some_and(|status| {
        status.get("outcome").and_then(Value::as_str) == Some("denied")
            && status.get("code").and_then(Value::as_str)
                == Some("CHILD_WEBVIEW_APP_COMMAND_DENIED")
            && status.get("permissionDenied").and_then(Value::as_bool) == Some(true)
    }) && ipc.get("windowIsVisible").is_some_and(plugin_denied)
        && ipc.get("resourceExists").is_some_and(plugin_denied)
}

fn plugin_denied(status: &Value) -> bool {
    status.get("outcome").and_then(Value::as_str) == Some("denied")
        && status.get("code").and_then(Value::as_str) == Some("REJECTED")
        && status.get("permissionDenied").and_then(Value::as_bool) == Some(true)
}

#[tauri::command]
fn multiwebview_probe(
    app: AppHandle<Wry>,
    webview: tauri::Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    operation: String,
    evidence: Value,
) -> Result<(), String> {
    main_probe::validate_main_webview(&app, &webview).map_err(str::to_string)?;
    (*harness)
        .accept_main(&token, &operation, evidence)
        .map_err(str::to_string)
}

pub(super) fn snapshot(app: &AppHandle<Wry>) -> Value {
    app.try_state::<Harness>()
        .map(|state| (*state).snapshot())
        .unwrap_or_else(|| {
            json!({
                "schemaVersion": 1,
                "enabled": true,
                "passed": false,
                "errors": ["multiwebview-harness-state-unavailable"]
            })
        })
}
