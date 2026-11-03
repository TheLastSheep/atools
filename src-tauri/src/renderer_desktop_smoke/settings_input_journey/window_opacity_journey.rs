use super::{native, probe, state::Harness, window_opacity_schema as schema};
use atools_core::Database;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview, Wry};

const TARGET_OPACITY: f64 = 0.65;

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let mut observations = schema::empty_observations();
    let mut errors = Vec::new();
    let activity_before = runtime_activity(app);
    let outcome = run_flow(app, harness, &mut observations).await;
    if let Err(error) = outcome {
        push_error(&mut errors, error);
        let closed = close_owned_child(app, harness).await;
        set_bool(&mut observations, "closed", Some(closed));
        if !closed {
            push_error(&mut errors, schema::CLOSE_FAILED);
        }
    }

    let activity_after = runtime_activity(app);
    let plugin_ui_opened = observed_any(activity_before.0, activity_after.0);
    let preload_started = observed_any(activity_before.1, activity_after.1);
    set_bool(&mut observations, "pluginUiOpened", plugin_ui_opened);
    set_bool(&mut observations, "preloadStarted", preload_started);
    if plugin_ui_opened != Some(false) || preload_started != Some(false) {
        push_error(&mut errors, schema::READBACK_INVALID);
    }

    let sidecar = schema::build(harness.profile(), observations, &errors);
    if !schema::valid_report(harness.profile(), &sidecar)
        || super::local_app_search_report::write_owned_artifact(
            harness.profile(),
            schema::REPORT_NAME,
            &sidecar,
        )
        .is_err()
    {
        push_error(&mut errors, schema::REPORT_WRITE_FAILED);
        harness.add_error("settings-input-window-opacity-failed");
        return Err("settings-input-window-opacity-failed");
    }
    if !errors.is_empty() || !schema::observations_passed(&sidecar["observations"]) {
        harness.add_error("settings-input-window-opacity-failed");
        return Err("settings-input-window-opacity-failed");
    }
    Ok(())
}

async fn run_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: &mut Value,
) -> Result<(), &'static str> {
    native::wait_for_closed(app)
        .await
        .map_err(|_| schema::OPEN_FAILED)?;
    let original = read_general_settings(harness)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let original_opacity = opacity_value(&original);
    let (child, first_id) = open_general(app, harness, schema::OPEN_FAILED).await?;
    let initial_ui = probe::child_window_opacity_inspect(app, harness, &child)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let initial_native = read_native_opacity(app).await?;
    let initial_ok = near(original_opacity, 1.0)
        && probe_control_ready(&initial_ui)
        && near(initial_ui["uiOpacity"].as_f64(), 1.0)
        && near(initial_ui["storedOpacity"].as_f64(), 1.0)
        && near(Some(initial_native), 1.0);
    set_bool(observations, "initialStateValid", Some(initial_ok));
    if !initial_ok {
        return Err(schema::BASELINE_INVALID);
    }

    let changed = probe::child_window_opacity_set(app, harness, &child, TARGET_OPACITY)
        .await
        .map_err(|_| schema::CHANGE_FAILED)?;
    let dispatched =
        bool_field(&changed, "inputDispatched") && bool_field(&changed, "changeDispatched");
    let changed_ui_ok =
        probe_control_ready(&changed) && near(changed["uiOpacity"].as_f64(), TARGET_OPACITY);
    set_bool(observations, "changeDispatched", Some(dispatched));
    set_bool(observations, "changedUiMatches", Some(changed_ui_ok));
    let changed_db = read_general_settings(harness).await?;
    let changed_stored_ok = near(opacity_value(&changed_db), TARGET_OPACITY)
        && near(changed["storedOpacity"].as_f64(), TARGET_OPACITY);
    set_bool(observations, "changedStored", Some(changed_stored_ok));
    let changed_native = read_native_opacity(app).await?;
    set_number(observations, "changedNativeOpacity", Some(changed_native));
    let changed_native_ok = near(Some(changed_native), TARGET_OPACITY);
    set_bool(
        observations,
        "changedNativeMatches",
        Some(changed_native_ok),
    );
    if !dispatched || !changed_ui_ok || !changed_stored_ok || !changed_native_ok {
        return Err(schema::CHANGE_FAILED);
    }

    close_child(app, harness, &child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)?;
    let (fresh_child, fresh_id) = open_general(app, harness, schema::REOPEN_FAILED).await?;
    let fresh = first_id != fresh_id;
    set_bool(observations, "freshChildOnReopen", Some(fresh));
    if !fresh {
        return Err(schema::REOPEN_FAILED);
    }
    let reopened_ui = probe::child_window_opacity_inspect(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    let reopened_ui_ok = probe_control_ready(&reopened_ui)
        && near(reopened_ui["uiOpacity"].as_f64(), TARGET_OPACITY);
    set_bool(observations, "reopenUiMatches", Some(reopened_ui_ok));
    let reopened_db = read_general_settings(harness).await?;
    let reopened_db_ok = near(opacity_value(&reopened_db), TARGET_OPACITY)
        && near(reopened_ui["storedOpacity"].as_f64(), TARGET_OPACITY);
    set_bool(observations, "reopenStored", Some(reopened_db_ok));
    let reopened_native = read_native_opacity(app).await?;
    let reopened_native_ok = near(Some(reopened_native), TARGET_OPACITY);
    set_number(observations, "reopenedNativeOpacity", Some(reopened_native));
    set_bool(
        observations,
        "reopenNativeMatches",
        Some(reopened_native_ok),
    );
    if !reopened_ui_ok || !reopened_db_ok || !reopened_native_ok {
        return Err(schema::REOPEN_FAILED);
    }

    let restored = probe::child_window_opacity_set(app, harness, &fresh_child, 1.0)
        .await
        .map_err(|_| schema::RESTORE_FAILED)?;
    let restore_dispatched =
        bool_field(&restored, "inputDispatched") && bool_field(&restored, "changeDispatched");
    set_bool(observations, "restoreDispatched", Some(restore_dispatched));
    let restored_db = read_general_settings(harness).await?;
    let restored_ui_and_db = probe_control_ready(&restored)
        && near(restored["uiOpacity"].as_f64(), 1.0)
        && near(restored["storedOpacity"].as_f64(), 1.0)
        && near(opacity_value(&restored_db), 1.0);
    set_bool(observations, "restoredStored", Some(restored_ui_and_db));
    if !restore_dispatched || !restored_ui_and_db {
        return Err(schema::RESTORE_FAILED);
    }

    close_child(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)?;
    let final_db = read_general_settings(harness).await?;
    let restored_stored_ok = restored_ui_and_db && near(opacity_value(&final_db), 1.0);
    set_bool(observations, "restoredStored", Some(restored_stored_ok));
    let restored_native = read_native_opacity(app).await?;
    let restored_native_ok = near(Some(restored_native), 1.0);
    set_number(observations, "restoredNativeOpacity", Some(restored_native));
    set_bool(
        observations,
        "restoredNativeMatches",
        Some(restored_native_ok),
    );
    if !restored_stored_ok || !restored_native_ok {
        return Err(schema::RESTORE_FAILED);
    }
    let preserved = unrelated_fields_preserved(&original, &final_db);
    set_bool(observations, "unrelatedPreserved", Some(preserved));
    if !preserved {
        return Err(schema::UNRELATED_CHANGED);
    }
    set_bool(observations, "closed", Some(true));
    Ok(())
}

async fn open_general(
    app: &AppHandle<Wry>,
    harness: &Harness,
    error: &'static str,
) -> Result<(Webview<Wry>, String), &'static str> {
    let before = probe::main_open_state(app, harness).await.ok();
    let opened = probe::main_open_settings(app, harness)
        .await
        .map_err(|_| error)?;
    if !bool_field(&opened, "openCallAvailable") || !bool_field(&opened, "openCallDispatched") {
        return Err(error);
    }
    let (child, id) = super::diagnostics::active_child_after_open(app, harness, before)
        .await
        .map_err(|_| error)?;
    let general = probe::child_theme_navigate(app, harness, &child)
        .await
        .map_err(|_| error)?;
    if !bool_field(&general, "routeGeneral") || !bool_field(&general, "themeControlFound") {
        return Err(error);
    }
    Ok((child, id))
}

async fn close_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<(), &'static str> {
    super::cleanup::close_child_via_plugin(app, harness, child).await?;
    native::wait_for_closed(app).await
}

async fn close_owned_child(app: &AppHandle<Wry>, harness: &Harness) -> bool {
    if let Ok((child, _)) = native::active_child(app, Duration::from_millis(500)).await {
        if close_child(app, harness, &child).await.is_err() {
            return false;
        }
    }
    native::wait_for_closed(app).await.is_ok()
}

async fn read_general_settings(harness: &Harness) -> Result<Value, &'static str> {
    let path = harness.profile().root.join("app-data/data.db");
    tauri::async_runtime::spawn_blocking(move || {
        let db = Database::open(&path).map_err(|_| schema::READBACK_INVALID)?;
        let raw = db
            .get_setting("settings-general")
            .map_err(|_| schema::READBACK_INVALID)?
            .ok_or(schema::READBACK_INVALID)?;
        if raw.len() > 64 * 1024 {
            return Err(schema::READBACK_INVALID);
        }
        let value: Value = serde_json::from_str(&raw).map_err(|_| schema::READBACK_INVALID)?;
        if !value.is_object() || opacity_value(&value).is_none() {
            return Err(schema::READBACK_INVALID);
        }
        Ok(value)
    })
    .await
    .map_err(|_| schema::READBACK_INVALID)?
}

async fn read_native_opacity(app: &AppHandle<Wry>) -> Result<f64, &'static str> {
    let window = crate::window::main_window(app).map_err(|_| schema::READBACK_INVALID)?;
    let opacity = crate::native_window_opacity::read_apply(window, None)
        .await
        .map_err(|_| schema::READBACK_INVALID)?;
    if opacity.is_finite() && (0.0..=1.0).contains(&opacity) {
        Ok(opacity)
    } else {
        Err(schema::READBACK_INVALID)
    }
}

fn runtime_activity(app: &AppHandle<Wry>) -> (Option<bool>, Option<bool>) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return (None, None);
    };
    let plugin_ui = Some(state.active_plugin.lock().is_some());
    let preload = crate::legacy_runtime::inventory_snapshot(app)
        .ok()
        .filter(|(_, truncated)| !truncated)
        .map(|(sessions, _)| !sessions.is_empty());
    (plugin_ui, preload)
}

fn probe_control_ready(value: &Value) -> bool {
    bool_field(value, "routeGeneral")
        && bool_field(value, "controlUnique")
        && bool_field(value, "rangeValid")
}

fn opacity_value(value: &Value) -> Option<f64> {
    value["opacity"]
        .as_f64()
        .filter(|opacity| opacity.is_finite() && (0.3..=1.0).contains(opacity))
}

fn unrelated_fields_preserved(before: &Value, after: &Value) -> bool {
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return false;
    };
    before
        .iter()
        .filter(|(key, _)| key.as_str() != "opacity")
        .all(|(key, value)| after.get(key) == Some(value))
}

fn near(value: Option<f64>, expected: f64) -> bool {
    value.is_some_and(|actual| actual.is_finite() && (actual - expected).abs() <= 0.005000001)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value[key].as_bool() == Some(true)
}

fn set_bool(observations: &mut Value, key: &str, value: Option<bool>) {
    observations[key] = value.map(Value::Bool).unwrap_or(Value::Null);
}

fn set_number(observations: &mut Value, key: &str, value: Option<f64>) {
    observations[key] = value
        .filter(|opacity| opacity.is_finite() && (0.0..=1.0).contains(opacity))
        .and_then(serde_json::Number::from_f64)
        .map(Value::Number)
        .unwrap_or(Value::Null);
}

fn observed_any(before: Option<bool>, after: Option<bool>) -> Option<bool> {
    if before == Some(true) || after == Some(true) {
        Some(true)
    } else if before == Some(false) && after == Some(false) {
        Some(false)
    } else {
        None
    }
}

fn push_error(errors: &mut Vec<&'static str>, code: &'static str) {
    if !errors.contains(&code) {
        errors.push(code);
    }
}
