use super::{native, probe, schema, state::Harness};
use serde_json::Value;
use std::fs;
use tauri::{AppHandle, Manager, Webview, Wry};

pub(super) async fn active_child_after_open(
    app: &AppHandle<Wry>,
    harness: &Harness,
    before: Option<Value>,
) -> Result<(Webview<Wry>, String), &'static str> {
    match native::active_child(app, schema::CHILD_TIMEOUT).await {
        Ok(child) => Ok(child),
        Err(child_error) => {
            let after = probe::main_open_state(app, harness).await.ok();
            record_open_state_errors(harness, before.as_ref(), after.as_ref());
            record_runtime_errors(app, harness);
            record_viewport_error(app, harness);
            record_resource_root_error(app, harness);
            Err(child_error)
        }
    }
}

fn record_open_state_errors(harness: &Harness, before: Option<&Value>, after: Option<&Value>) {
    if after.is_none() {
        harness.add_error("settings-input-open-diagnostics-unavailable");
    };

    const FIELDS: &[&str] = &[
        "openCalls",
        "pendingOpen",
        "openFailures",
        "listenerState",
        "registrationErrors",
        "invalidPayloads",
    ];
    if after.is_some_and(|value| FIELDS.iter().any(|field| value[*field].is_null())) {
        harness.add_error("settings-input-open-diagnostics-incomplete");
    }

    if after.and_then(|value| value["openCalls"].as_u64()) == Some(0) {
        harness.add_error("settings-input-open-not-invoked");
    }
    if counter_nonzero(before, after, "openFailures") {
        harness.add_error("settings-input-open-native-rejected");
    }
    if after.and_then(|value| value["pendingOpen"].as_bool()) == Some(true) {
        harness.add_error("settings-input-open-pending");
    }

    if listener_failed(before)
        || after.and_then(|value| value["listenerState"].as_str()) == Some("failed")
    {
        harness.add_error("settings-input-listener-failed");
    }
    if counter_nonzero(before, after, "registrationErrors") {
        harness.add_error("settings-input-listener-registration-error");
    }
    match after.and_then(|value| value["listenerState"].as_str()) {
        Some("idle" | "disposed") => harness.add_error("settings-input-listener-inactive"),
        Some("registering") => harness.add_error("settings-input-listener-pending"),
        _ => {}
    }
    if counter_nonzero(before, after, "invalidPayloads") {
        harness.add_error("settings-input-event-invalid");
    }
}

fn listener_failed(before: Option<&Value>) -> bool {
    before.is_some_and(|value| value["listenerState"].as_str() == Some("failed"))
}

fn counter_nonzero(before: Option<&Value>, after: Option<&Value>, key: &str) -> bool {
    after
        .and_then(|value| value[key].as_u64())
        .is_some_and(|value| value > 0)
        || before
            .and_then(|value| value[key].as_u64())
            .is_some_and(|value| value > 0)
}

fn record_runtime_errors(app: &AppHandle<Wry>, harness: &Harness) {
    let snapshot = crate::renderer_settings_view::snapshot(app);
    match snapshot["stateAvailable"].as_bool() {
        Some(false) => {
            harness.add_error("settings-input-runtime-state-unavailable");
            return;
        }
        None => {
            harness.add_error("settings-input-runtime-observation-incomplete");
            return;
        }
        Some(true) => {}
    }

    if snapshot["runtimeInitialized"].as_bool() == Some(false) {
        harness.add_error("settings-input-runtime-not-initialized");
    }
    if snapshot["bundleCached"].as_bool() == Some(false) {
        harness.add_error("settings-input-bundle-not-cached");
    }
    if snapshot["bundleLoadActive"].as_bool() == Some(true) {
        harness.add_error("settings-input-bundle-load-active");
    }
    if snapshot["ready"].as_bool() == Some(false) {
        harness.add_error("settings-input-session-not-ready");
    }

    match snapshot.get("phase") {
        Some(Value::Null) => harness.add_error("settings-input-session-absent"),
        Some(Value::String(phase)) if phase == "opening" => {
            harness.add_error("settings-input-session-opening")
        }
        Some(Value::String(phase)) if phase == "closing" => {
            harness.add_error("settings-input-session-closing")
        }
        Some(Value::String(phase)) if phase == "open" => {}
        _ => harness.add_error("settings-input-runtime-observation-incomplete"),
    }

    if [
        "runtimeInitialized",
        "bundleCached",
        "bundleLoadActive",
        "ready",
    ]
    .iter()
    .any(|field| snapshot[*field].as_bool().is_none())
    {
        harness.add_error("settings-input-runtime-observation-incomplete");
    }
}

fn record_viewport_error(app: &AppHandle<Wry>, harness: &Harness) {
    let Ok(window) = crate::window::main_window(app) else {
        harness.add_error("settings-input-viewport-unavailable");
        return;
    };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        harness.add_error("settings-input-viewport-unavailable");
        return;
    };
    if !scale.is_finite() || scale <= 0.0 {
        harness.add_error("settings-input-viewport-invalid");
        return;
    }
    let width = f64::from(size.width) / scale;
    let height = f64::from(size.height) / scale;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height < 184.0 {
        harness.add_error("settings-input-viewport-invalid");
    }
}

fn record_resource_root_error(app: &AppHandle<Wry>, harness: &Harness) {
    let Ok(resource_dir) = app.path().resource_dir() else {
        harness.add_error("settings-input-resource-root-unavailable");
        return;
    };
    let root = resource_dir.join("ztools-settings");
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            harness.add_error("settings-input-resource-root-missing");
            return;
        }
        Err(_) => {
            harness.add_error("settings-input-resource-root-unavailable");
            return;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        harness.add_error("settings-input-resource-root-invalid");
        return;
    }
    match root.canonicalize() {
        Ok(canonical) if root.is_absolute() && canonical == root => {}
        Ok(_) => harness.add_error("settings-input-resource-root-noncanonical"),
        Err(_) => harness.add_error("settings-input-resource-root-invalid"),
    }
}
