//! Validated native BrowserWindow actions. Validation is completed before any
//! native mutation; each action and its resulting snapshot share one UI-thread turn.

mod capabilities;
mod geometry;
mod geometry_execution;
mod lifecycle;

#[cfg(test)]
mod geometry_execution_tests;

use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::plugin_browser_window_native::snapshot::{
    next_native_sequence, run_on_main_thread, snapshot_now,
};

enum NativeAction {
    Geometry(geometry::GeometryAction),
    Lifecycle(lifecycle::LifecycleAction),
    Capability(capabilities::CapabilityAction),
}

/// Apply one host BrowserWindow action and return its historical action value
/// together with the native state read after the operation.
pub async fn apply_action(
    app: &AppHandle,
    label: &str,
    action: &str,
    args: &[Value],
) -> Result<Value, String> {
    super::options::validate_label(label)?;
    let parsed = parse_action(action, args)?;
    let scheduler = app.clone();
    let worker = app.clone();
    let label = label.to_string();
    run_on_main_thread(&scheduler, move || {
        let window = worker
            .get_webview_window(&label)
            .ok_or_else(|| format!("ERR_ATOOLS_NATIVE_WINDOW_NOT_FOUND: {label}"))?;
        apply_now(&window, &parsed)
    })
    .await
}

/// Start a host-authorized macOS window move from a previously captured real
/// mouse-down. This stays outside the generic action parser and is only called
/// by the audited BrowserWindow TaskRun dispatcher.
pub(crate) async fn start_dragging<F>(
    app: &AppHandle,
    label: &str,
    started_at_ms: u64,
    prepared_at: Instant,
    prepared_at_ms: u64,
    preflight: F,
) -> Result<Value, String>
where
    F: FnOnce(&WebviewWindow) -> Result<super::dragging::StartAuthorization, String>
        + Send
        + 'static,
{
    super::options::validate_label(label)?;
    super::dragging::start_dragging(
        app,
        label,
        started_at_ms,
        prepared_at,
        prepared_at_ms,
        preflight,
    )
    .await
}

fn parse_action(action: &str, args: &[Value]) -> Result<NativeAction, String> {
    if let Some(parsed) = geometry::parse(action, args)? {
        return Ok(NativeAction::Geometry(parsed));
    }
    if let Some(parsed) = lifecycle::parse(action, args)? {
        return Ok(NativeAction::Lifecycle(parsed));
    }
    if let Some(parsed) = capabilities::parse(action, args)? {
        return Ok(NativeAction::Capability(parsed));
    }
    Err(format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: action {action:?} is not implemented by the native host"))
}

fn apply_now(window: &WebviewWindow, action: &NativeAction) -> Result<Value, String> {
    if let NativeAction::Geometry(action) = action {
        return geometry_execution::execute_window(window, action);
    }

    let closing = matches!(action, NativeAction::Lifecycle(action) if action.is_close());
    let mutation_result = match action {
        NativeAction::Geometry(_) => unreachable!("geometry returns from the executor above"),
        NativeAction::Lifecycle(action) => lifecycle::apply(window, action)?,
        NativeAction::Capability(action) => capabilities::apply(window, action)?,
    };

    if closing {
        return Ok(json!({
            "value": mutation_result.unwrap_or_else(|| json!({"closed": true, "visible": false, "focused": false})),
            "snapshot": { "closed": true, "nativeSequence": next_native_sequence() }
        }));
    }

    let snapshot = snapshot_now(window)?;
    let value = match mutation_result {
        Some(value) => value,
        None => read_action(window, &snapshot, action)?.ok_or_else(|| {
            "ERR_ATOOLS_NATIVE_WINDOW_ACTION_RESULT: missing result for a validated action"
                .to_string()
        })?,
    };
    let snapshot = snapshot.to_value()?;
    Ok(json!({ "value": value, "snapshot": snapshot }))
}

fn read_action(
    window: &WebviewWindow,
    snapshot: &crate::plugin_browser_window_native::snapshot::NativeSnapshot,
    action: &NativeAction,
) -> Result<Option<Value>, String> {
    match action {
        NativeAction::Geometry(action) => {
            Ok(geometry::read(snapshot, action)
                .or_else(|| geometry::centered_value(snapshot, action)))
        }
        NativeAction::Lifecycle(action) => Ok(lifecycle::read(snapshot, action)),
        NativeAction::Capability(action) => capabilities::read(window, snapshot, action),
    }
}
