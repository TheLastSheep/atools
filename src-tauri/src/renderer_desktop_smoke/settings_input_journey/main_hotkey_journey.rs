use super::{main_hotkey_schema as schema, native, probe, state::Harness};
use atools_core::Database;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Webview, Wry};

const APP_SHORTCUT_TARGET: &str = "__atools_r44_fixture_shortcut_no_launch__";

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let mut observations = schema::empty_observations();
    let mut errors = Vec::new();
    let mut app_shortcut_snapshot = None;
    let mut app_shortcut_attempted = false;
    let mut primary_started = false;
    let activity_before = runtime_activity(app);

    if let Err(error) = run_flow(
        app,
        harness,
        &mut observations,
        &mut app_shortcut_snapshot,
        &mut app_shortcut_attempted,
        &mut primary_started,
    )
    .await
    {
        push_error(&mut errors, error);
        let closed = close_owned_child(app, harness).await;
        set_bool(&mut observations, "childClosed", Some(closed));
        if !closed {
            push_error(&mut errors, schema::CLOSE_FAILED);
        }
    }

    if primary_started {
        let released = crate::hotkey::release_owned_main_hotkey(app).is_ok()
            && !is_registered(app, schema::HOTKEY_A)
            && !is_registered(app, schema::HOTKEY_B);
        set_bool(&mut observations, "ownedPrimaryReleased", Some(released));
        if !released {
            push_error(&mut errors, schema::CLEANUP_FAILED);
        }
    }
    let other_released = if let Some(snapshot) = app_shortcut_snapshot.take() {
        let cleared = crate::general_settings_runtime::replace_app_shortcuts(app, &[]).is_ok();
        let restored =
            crate::general_settings_runtime::restore_app_shortcuts(app, snapshot).is_ok();
        cleared && restored && !is_registered(app, schema::HOTKEY_C)
    } else if app_shortcut_attempted {
        false
    } else {
        return write_failure_sidecar(app, harness, observations, errors, activity_before).await;
    };
    if app_shortcut_attempted {
        set_bool(
            &mut observations,
            "otherShortcutReleased",
            Some(other_released),
        );
        if !other_released {
            push_error(&mut errors, schema::CLEANUP_FAILED);
        }
    }

    finish_report(app, harness, observations, errors, activity_before).await
}

async fn run_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: &mut Value,
    app_shortcut_snapshot: &mut Option<crate::general_settings_runtime::OwnedAppShortcutSnapshot>,
    app_shortcut_attempted: &mut bool,
    primary_started: &mut bool,
) -> Result<(), &'static str> {
    native::wait_for_closed(app)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let original = read_general_settings(harness).await?;
    if hotkey_value(&original) != Some(schema::HOTKEY_A) {
        return Err(schema::BASELINE_INVALID);
    }
    crate::hotkey::setup_owned_main_hotkey(app, schema::HOTKEY_A)
        .map_err(|_| schema::BASELINE_INVALID)?;
    *primary_started = true;
    let initial_owned = owned_matches(app, schema::HOTKEY_A);
    set_bool(observations, "initialOwnedRegistered", Some(initial_owned));
    if !initial_owned {
        return Err(schema::BASELINE_INVALID);
    }

    let main_raw = probe::main_hotkey_raw_mutation(app, harness)
        .await
        .map_err(|_| schema::CHANGE_FAILED)?;
    let main_acl_denied =
        main_raw["aclDenied"].as_bool() == Some(true) && owned_matches(app, schema::HOTKEY_A);
    set_bool(
        observations,
        "mainRawHotkeyMutationDenied",
        Some(main_acl_denied),
    );
    if !owned_matches(app, schema::HOTKEY_A) && !recover_owned_primary(app, schema::HOTKEY_A) {
        return Err(schema::CLEANUP_FAILED);
    }

    let (child, first_id) = open_general(app, harness, schema::OPEN_FAILED).await?;
    let initial = probe::child_main_hotkey_inspect(app, harness, &child)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let initial_ui = inspect_matches(&initial, schema::HOTKEY_A);
    set_bool(observations, "initialUiMatches", Some(initial_ui));
    if !initial_ui {
        return Err(schema::BASELINE_INVALID);
    }

    let child_raw = probe::child_main_hotkey_raw_mutation(app, harness, &child)
        .await
        .map_err(|_| schema::CHANGE_FAILED)?;
    let child_acl_denied =
        child_raw["aclDenied"].as_bool() == Some(true) && owned_matches(app, schema::HOTKEY_A);
    set_bool(
        observations,
        "childRawHotkeyMutationDenied",
        Some(child_acl_denied),
    );
    if !owned_matches(app, schema::HOTKEY_A) && !recover_owned_primary(app, schema::HOTKEY_A) {
        return Err(schema::CLEANUP_FAILED);
    }
    if !main_acl_denied || !child_acl_denied {
        return Err(schema::CHANGE_FAILED);
    }

    let changed = probe::child_main_hotkey_record(
        app,
        harness,
        &child,
        "F11",
        schema::HOTKEY_B,
        schema::HOTKEY_B,
    )
    .await
    .map_err(|_| schema::RECORD_FAILED)?;
    let record_dispatched = record_was_dispatched(&changed);
    set_bool(observations, "recordDispatched", Some(record_dispatched));
    if !record_dispatched {
        return Err(schema::RECORD_FAILED);
    }
    let stored = read_general_settings(harness).await?;
    let changed_stored = hotkey_value(&stored) == Some(schema::HOTKEY_B)
        && changed["storedValue"].as_str() == Some(schema::HOTKEY_B);
    set_bool(observations, "changedStored", Some(changed_stored));
    let changed_owned = owned_matches(app, schema::HOTKEY_B);
    set_bool(observations, "changedOwnedRegistered", Some(changed_owned));
    let previous_unregistered = !is_registered(app, schema::HOTKEY_A);
    set_bool(
        observations,
        "previousUnregistered",
        Some(previous_unregistered),
    );
    let changed_ui = probe::child_main_hotkey_inspect(app, harness, &child)
        .await
        .map(|value| inspect_matches(&value, schema::HOTKEY_B))
        .unwrap_or(false);
    set_bool(observations, "changedUiMatches", Some(changed_ui));
    if !changed_stored || !changed_owned || !previous_unregistered || !changed_ui {
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
    let reopened = probe::child_main_hotkey_inspect(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    let reopen_ui = inspect_matches(&reopened, schema::HOTKEY_B);
    set_bool(observations, "reopenUiMatches", Some(reopen_ui));
    let reopened_db = read_general_settings(harness).await?;
    let reopen_stored = hotkey_value(&reopened_db) == Some(schema::HOTKEY_B)
        && reopened["storedValue"].as_str() == Some(schema::HOTKEY_B);
    set_bool(observations, "reopenStored", Some(reopen_stored));
    let reopen_owned = owned_matches(app, schema::HOTKEY_B);
    set_bool(observations, "reopenOwnedRegistered", Some(reopen_owned));
    if !reopen_ui || !reopen_stored || !reopen_owned {
        return Err(schema::REOPEN_FAILED);
    }

    *app_shortcut_attempted = true;
    let baseline_shortcuts = crate::general_settings_runtime::replace_app_shortcuts(app, &[])
        .map_err(|_| schema::CONFLICT_FAILED)?;
    *app_shortcut_snapshot = Some(baseline_shortcuts.clone());
    crate::general_settings_runtime::restore_app_shortcuts(app, baseline_shortcuts)
        .map_err(|_| schema::CONFLICT_FAILED)?;
    crate::hotkey::register_app_shortcut(app, schema::HOTKEY_C, APP_SHORTCUT_TARGET)
        .map_err(|_| schema::CONFLICT_FAILED)?;
    if !is_registered(app, schema::HOTKEY_C) {
        return Err(schema::CONFLICT_FAILED);
    }

    let conflict = probe::child_main_hotkey_record(
        app,
        harness,
        &fresh_child,
        "F12",
        schema::HOTKEY_B,
        schema::HOTKEY_B,
    )
    .await
    .map_err(|_| schema::CONFLICT_FAILED)?;
    let conflict_dispatched =
        record_was_dispatched(&conflict) && conflict["rejectionObserved"].as_bool() == Some(true);
    set_bool(
        observations,
        "conflictDispatched",
        Some(conflict_dispatched),
    );
    if !conflict_dispatched {
        return Err(schema::CONFLICT_FAILED);
    }
    let conflict_ui = probe::child_main_hotkey_inspect(app, harness, &fresh_child)
        .await
        .map(|value| inspect_matches(&value, schema::HOTKEY_B))
        .unwrap_or(false);
    set_bool(observations, "conflictUiRestored", Some(conflict_ui));
    let conflict_db = read_general_settings(harness).await?;
    let conflict_stored = hotkey_value(&conflict_db) == Some(schema::HOTKEY_B)
        && conflict["storedValue"].as_str() == Some(schema::HOTKEY_B);
    set_bool(
        observations,
        "conflictStoredUnchanged",
        Some(conflict_stored),
    );
    let conflict_primary = owned_matches(app, schema::HOTKEY_B);
    set_bool(
        observations,
        "conflictPrimaryPreserved",
        Some(conflict_primary),
    );
    let conflict_other = is_registered(app, schema::HOTKEY_C);
    set_bool(observations, "conflictOtherPreserved", Some(conflict_other));
    if !conflict_ui || !conflict_stored || !conflict_primary || !conflict_other {
        return Err(schema::CONFLICT_FAILED);
    }

    let restored = probe::child_main_hotkey_record(
        app,
        harness,
        &fresh_child,
        "F10",
        schema::HOTKEY_A,
        schema::HOTKEY_A,
    )
    .await
    .map_err(|_| schema::RESTORE_FAILED)?;
    let restore_dispatched = record_was_dispatched(&restored);
    set_bool(observations, "restoreDispatched", Some(restore_dispatched));
    let final_settings = read_general_settings(harness).await?;
    let restored_stored = hotkey_value(&final_settings) == Some(schema::HOTKEY_A)
        && restored["storedValue"].as_str() == Some(schema::HOTKEY_A);
    set_bool(observations, "restoredStored", Some(restored_stored));
    let restored_owned = owned_matches(app, schema::HOTKEY_A);
    set_bool(
        observations,
        "restoredOwnedRegistered",
        Some(restored_owned),
    );
    let alternate_unregistered = !is_registered(app, schema::HOTKEY_B);
    set_bool(
        observations,
        "alternateUnregistered",
        Some(alternate_unregistered),
    );
    let preserved = unrelated_fields_preserved(&original, &final_settings);
    set_bool(observations, "unrelatedPreserved", Some(preserved));
    if !restore_dispatched || !restored_stored || !restored_owned || !alternate_unregistered {
        return Err(schema::RESTORE_FAILED);
    }
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

async fn finish_report(
    app: &AppHandle<Wry>,
    harness: &Harness,
    mut observations: Value,
    mut errors: Vec<&'static str>,
    activity_before: (Option<bool>, Option<bool>),
) -> Result<(), &'static str> {
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
    let sidecar = schema::build(harness.profile(), observations, &errors);
    if !schema::valid_report(harness.profile(), &sidecar)
        || super::local_app_search_report::write_owned_artifact(
            harness.profile(),
            schema::REPORT_NAME,
            &sidecar,
        )
        .is_err()
    {
        harness.add_error(schema::JOURNEY_FAILED);
        return Err(schema::JOURNEY_FAILED);
    }
    if !errors.is_empty() || !schema::observations_passed(&sidecar["observations"]) {
        harness.add_error(schema::JOURNEY_FAILED);
        return Err(schema::JOURNEY_FAILED);
    }
    Ok(())
}

async fn write_failure_sidecar(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: Value,
    errors: Vec<&'static str>,
    activity_before: (Option<bool>, Option<bool>),
) -> Result<(), &'static str> {
    finish_report(app, harness, observations, errors, activity_before).await
}

fn owned_matches(app: &AppHandle<Wry>, expected: &str) -> bool {
    crate::hotkey::read_owned_main_hotkey(app)
        .map(|snapshot| snapshot.label() == expected)
        .unwrap_or(false)
        && is_registered(app, expected)
}

fn recover_owned_primary(app: &AppHandle<Wry>, expected: &str) -> bool {
    crate::hotkey::release_owned_main_hotkey(app).is_ok()
        && crate::hotkey::setup_owned_main_hotkey(app, expected).is_ok()
        && owned_matches(app, expected)
}

fn is_registered(app: &AppHandle<Wry>, shortcut: &str) -> bool {
    crate::hotkey::is_shortcut_registered(app, shortcut)
}

fn inspect_matches(value: &Value, expected: &str) -> bool {
    value["routeGeneral"].as_bool() == Some(true)
        && value["controlUnique"].as_bool() == Some(true)
        && value["displayValue"].as_str() == Some(expected)
        && value["storedValue"].as_str() == Some(expected)
        && value["documentHidden"].as_bool() == Some(true)
        && value["documentHasFocus"].as_bool() == Some(false)
}

fn record_was_dispatched(value: &Value) -> bool {
    value["routeGeneral"].as_bool() == Some(true)
        && value["controlUnique"].as_bool() == Some(true)
        && value["documentHidden"].as_bool() == Some(true)
        && value["documentHasFocus"].as_bool() == Some(false)
        && value["clickDispatched"].as_bool() == Some(true)
        && value["keyDownDispatched"].as_bool() == Some(true)
        && value["keyUpDispatched"].as_bool() == Some(true)
}

fn hotkey_value(settings: &Value) -> Option<&str> {
    settings.get("hotkey").and_then(Value::as_str)
}

fn unrelated_fields_preserved(before: &Value, after: &Value) -> bool {
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return false;
    };
    before
        .iter()
        .filter(|(key, _)| key.as_str() != "hotkey")
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
