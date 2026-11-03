use super::{native, probe, state::Harness, tray_visibility_schema as schema};
use atools_core::Database;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Webview, Wry};

const NATIVE_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let mut observations = schema::empty_observations();
    let mut errors = Vec::new();
    let activity_before = runtime_activity(app);
    if let Err(error) = run_flow(app, harness, &mut observations).await {
        push_error(&mut errors, error);
        let closed = close_owned_child(app, harness).await;
        set_bool(&mut observations, "childClosed", Some(closed));
        if !closed {
            push_error(&mut errors, schema::CLOSE_FAILED);
        }
    }

    let released = release_owned_tray(app).await;
    set_bool(&mut observations, "trayReleased", Some(released));
    if !released {
        push_error(&mut errors, schema::CLEANUP_FAILED);
    }
    let activity_after = runtime_activity(app);
    set_bool(
        &mut observations,
        "pluginUiOpened",
        observed_any(activity_before.0, activity_after.0),
    );
    set_bool(
        &mut observations,
        "preloadStarted",
        observed_any(activity_before.1, activity_after.1),
    );
    if observations["pluginUiOpened"].as_bool() != Some(false)
        || observations["preloadStarted"].as_bool() != Some(false)
    {
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
        harness.add_error("settings-input-tray-visibility-failed");
        return Err("settings-input-tray-visibility-failed");
    }
    if !errors.is_empty() || !schema::observations_passed(&sidecar["observations"]) {
        harness.add_error("settings-input-tray-visibility-failed");
        return Err("settings-input-tray-visibility-failed");
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
        .map_err(|_| schema::BASELINE_INVALID)?;
    let original = read_general_settings(harness).await?;
    let has_saved_tray = original.get("showTrayIcon").is_some();
    let initial_native = read_native_visible(app)?;
    set_bool(
        observations,
        "startupDefaultVisible",
        Some(!has_saved_tray && initial_native),
    );
    if has_saved_tray || !initial_native {
        return Err(schema::BASELINE_INVALID);
    }

    let (child, first_id) = open_general(app, harness, schema::OPEN_FAILED).await?;
    let initial = probe::child_tray_visibility_inspect(app, harness, &child)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let initial_ok = child_fact_is_hidden(&initial)
        && initial["uiEnabled"].as_bool() == Some(true)
        && initial["storedEnabled"].as_bool() == Some(true);
    set_bool(observations, "initialUiEnabled", Some(initial_ok));
    if !initial_ok {
        return Err(schema::BASELINE_INVALID);
    }

    let disabled = probe::child_tray_visibility_set(app, harness, &child, false)
        .await
        .map_err(|_| schema::DISABLE_FAILED)?;
    let dispatched = child_fact_is_hidden(&disabled)
        && disabled["inputDispatched"].as_bool() == Some(true)
        && disabled["changeDispatched"].as_bool() == Some(true)
        && disabled["uiEnabled"].as_bool() == Some(false);
    set_bool(observations, "disableDispatched", Some(dispatched));
    let stored = read_general_settings(harness).await?;
    let disabled_stored =
        tray_value(&stored) == Some(false) && disabled["storedEnabled"].as_bool() == Some(false);
    set_bool(observations, "disabledStored", Some(disabled_stored));
    let disabled_native = wait_native_visible(app, false).await;
    set_bool(observations, "disabledNative", disabled_native);
    if !dispatched || !disabled_stored || disabled_native != Some(true) {
        return Err(schema::DISABLE_FAILED);
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
    let reopened = probe::child_tray_visibility_inspect(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    let reopen_ui =
        child_fact_is_hidden(&reopened) && reopened["uiEnabled"].as_bool() == Some(false);
    set_bool(observations, "reopenUiDisabled", Some(reopen_ui));
    let reopened_db = read_general_settings(harness).await?;
    let reopen_stored = tray_value(&reopened_db) == Some(false)
        && reopened["storedEnabled"].as_bool() == Some(false);
    set_bool(observations, "reopenStoredDisabled", Some(reopen_stored));
    let reopen_native = read_native_visible(app)?;
    set_bool(observations, "reopenNativeDisabled", Some(!reopen_native));
    if !reopen_ui || !reopen_stored || reopen_native {
        return Err(schema::REOPEN_FAILED);
    }

    let enabled = probe::child_tray_visibility_set(app, harness, &fresh_child, true)
        .await
        .map_err(|_| schema::ENABLE_FAILED)?;
    let enable_dispatched = child_fact_is_hidden(&enabled)
        && enabled["inputDispatched"].as_bool() == Some(true)
        && enabled["changeDispatched"].as_bool() == Some(true)
        && enabled["uiEnabled"].as_bool() == Some(true);
    set_bool(observations, "enableDispatched", Some(enable_dispatched));
    let enabled_db = read_general_settings(harness).await?;
    let enabled_stored =
        tray_value(&enabled_db) == Some(true) && enabled["storedEnabled"].as_bool() == Some(true);
    set_bool(observations, "enabledStored", Some(enabled_stored));
    let enabled_native = wait_native_visible(app, true).await;
    set_bool(observations, "enabledNative", enabled_native);
    if !enable_dispatched || !enabled_stored || enabled_native != Some(true) {
        return Err(schema::ENABLE_FAILED);
    }

    let final_db = read_general_settings(harness).await?;
    let preserved =
        tray_value(&final_db) == Some(true) && unrelated_fields_preserved(&original, &final_db);
    set_bool(observations, "unrelatedPreserved", Some(preserved));
    if !preserved {
        return Err(schema::UNRELATED_CHANGED);
    }
    close_child(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)?;
    set_bool(observations, "childClosed", Some(true));
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
    if opened["openCallAvailable"].as_bool() != Some(true)
        || opened["openCallDispatched"].as_bool() != Some(true)
    {
        return Err(error);
    }
    let (child, id) = super::diagnostics::active_child_after_open(app, harness, before)
        .await
        .map_err(|_| error)?;
    let route = probe::child_theme_navigate(app, harness, &child)
        .await
        .map_err(|_| error)?;
    if route["routeGeneral"].as_bool() != Some(true)
        || route["themeControlFound"].as_bool() != Some(true)
    {
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

async fn release_owned_tray(app: &AppHandle<Wry>) -> bool {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    if app
        .run_on_main_thread(move || {
            let tray = task_app.remove_tray_by_id("atools-tray");
            let removed = tray.is_some();
            drop(tray);
            let _ = sender.send(removed);
        })
        .is_err()
    {
        return false;
    }
    let removed = match tokio::time::timeout(Duration::from_secs(2), receiver).await {
        Ok(Ok(removed)) => removed,
        _ => false,
    };
    removed && wait_native_visible(app, false).await == Some(true)
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
        if !value.is_object() {
            return Err(schema::READBACK_INVALID);
        }
        Ok(value)
    })
    .await
    .map_err(|_| schema::READBACK_INVALID)?
}

fn read_native_visible(app: &AppHandle<Wry>) -> Result<bool, &'static str> {
    crate::native_tray_visibility::read_apply(app, None).map_err(|_| schema::READBACK_INVALID)
}

async fn wait_native_visible(app: &AppHandle<Wry>, expected: bool) -> Option<bool> {
    let deadline = tokio::time::Instant::now() + NATIVE_TIMEOUT;
    loop {
        let visible = read_native_visible(app).ok()?;
        if visible == expected {
            return Some(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Some(false);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn tray_value(settings: &Value) -> Option<bool> {
    settings.get("showTrayIcon").and_then(Value::as_bool)
}

fn child_fact_is_hidden(value: &Value) -> bool {
    value["routeGeneral"].as_bool() == Some(true)
        && value["controlUnique"].as_bool() == Some(true)
        && value["documentHidden"].as_bool() == Some(true)
        && value["documentHasFocus"].as_bool() == Some(false)
}

fn unrelated_fields_preserved(before: &Value, after: &Value) -> bool {
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return false;
    };
    before
        .iter()
        .filter(|(key, _)| key.as_str() != "showTrayIcon")
        .all(|(key, value)| after.get(key) == Some(value))
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

fn observed_any(before: Option<bool>, after: Option<bool>) -> Option<bool> {
    if before == Some(true) || after == Some(true) {
        Some(true)
    } else if before == Some(false) && after == Some(false) {
        Some(false)
    } else {
        None
    }
}

fn set_bool(observations: &mut Value, key: &str, value: Option<bool>) {
    observations[key] = value.map(Value::Bool).unwrap_or(Value::Null);
}

fn push_error(errors: &mut Vec<&'static str>, code: &'static str) {
    if !errors.contains(&code) {
        errors.push(code);
    }
}
