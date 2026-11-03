use super::{
    general_policies_clipboard_journey,
    general_policies_clipboard_runtime::ClipboardRetentionFixture,
    general_policies_probe as policy_probe, general_policies_schema as schema,
    general_policies_window_runtime as window_runtime, native, probe, state::Harness,
};
use atools_core::Database;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview, Wry};

const STRATEGIES: [&str; 4] = ["cursor", "primary", "lastActive", "remember"];
const UNRELATED_KEYS: [&str; 2] = ["windowPositionStrategy", "clipboardRetentionDays"];

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let mut observations = schema::empty_observations();
    let mut errors = Vec::new();
    let activity_before = runtime_activity(app);
    observations["windowSafety"]["focusEventsBefore"] = Value::from(harness.focus_gained_events());

    let outcome = run_flow(app, harness, &mut observations).await;
    if let Err(error) = outcome {
        push_error(&mut errors, error);
        if !restore_and_close(app, harness, &mut observations).await {
            push_error(&mut errors, schema::RESTORE_FAILED);
        }
    }

    let focus_after = harness.focus_gained_events();
    observations["windowSafety"]["focusEventsAfter"] = Value::from(focus_after);
    let activity_after = runtime_activity(app);
    observations["pluginUiOpened"] = observed_any(activity_before.0, activity_after.0)
        .map(Value::Bool)
        .unwrap_or(Value::Null);
    observations["preloadStarted"] = observed_any(activity_before.1, activity_after.1)
        .map(Value::Bool)
        .unwrap_or(Value::Null);
    if observations["pluginUiOpened"].as_bool() != Some(false)
        || observations["preloadStarted"].as_bool() != Some(false)
    {
        push_error(&mut errors, schema::SAFETY_INVALID);
    }
    if errors.is_empty() && !schema::observations_passed(&observations) {
        push_error(&mut errors, schema::READBACK_INVALID);
    }

    let report = schema::build(harness.profile(), observations, &errors);
    if !schema::valid_report(harness.profile(), &report)
        || super::local_app_search_report::write_owned_artifact(
            harness.profile(),
            schema::REPORT_NAME,
            &report,
        )
        .is_err()
    {
        return Err("settings-input-journey-failed");
    }
    if !errors.is_empty() || !schema::observations_passed(&report["observations"]) {
        return Err("settings-input-journey-failed");
    }
    Ok(())
}

async fn run_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: &mut Value,
) -> Result<(), &'static str> {
    let fixture = ClipboardRetentionFixture::new(harness.profile(), harness.database())?;
    native::wait_for_closed(app)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let original = read_general_settings(harness).await?;
    let initial_strategy = read_strategy(&original)?;
    let initial_days = read_days(&original)?;
    let (child, first_id) = open_general(app, harness, schema::OPEN_FAILED).await?;
    let baseline = policy_probe::child_general_policies_inspect(app, harness, &child)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let initial_ui_strategy = baseline["uiStrategy"].as_str().map(str::to_owned);
    let initial_ui_days = baseline["uiDays"].as_u64();
    observations["windowUi"]["initialStoredStrategy"] = strategy_value(initial_strategy.as_deref());
    observations["windowUi"]["initialUiStrategy"] = strategy_value(initial_ui_strategy.as_deref());
    observations["clipboard"]["initialStoredDays"] = days_value(initial_days);
    observations["clipboard"]["initialUiDays"] = days_value(initial_ui_days);
    // The child reads the public projection, which includes defaults. Keep the
    // separately read raw SQLite absence in the report rather than comparing
    // it with the projected remember/180 values.
    let initial_valid = baseline["routeGeneral"].as_bool() == Some(true)
        && baseline["strategyControlUnique"].as_bool() == Some(true)
        && baseline["retentionControlUnique"].as_bool() == Some(true)
        && baseline["uiStrategy"].as_str()
            == Some(initial_strategy.as_deref().unwrap_or("remember"))
        && baseline["storedStrategy"].as_str()
            == Some(initial_strategy.as_deref().unwrap_or("remember"))
        && initial_ui_days == Some(initial_days.unwrap_or(180))
        && baseline["storedDays"].as_u64() == Some(initial_days.unwrap_or(180));
    if !initial_valid {
        return Err(schema::BASELINE_INVALID);
    }
    checkpoint(app, harness, observations, "baseline")?;

    for strategy in STRATEGIES {
        let selected =
            policy_probe::child_general_policies_select_strategy(app, harness, &child, strategy)
                .await
                .map_err(|_| schema::WINDOW_POLICY_FAILED)?;
        let stored = read_general_settings(harness).await?;
        let selection_ok = selected["routeGeneral"].as_bool() == Some(true)
            && selected["strategyControlUnique"].as_bool() == Some(true)
            && selected["selectionDispatched"].as_bool() == Some(true)
            && selected["uiStrategy"].as_str() == Some(strategy)
            && selected["storedStrategy"].as_str() == Some(strategy)
            && read_strategy(&stored)?.as_deref() == Some(strategy);
        observations["windowUi"][strategy] = json!({
            "uiSelected": selection_ok,
            "storedStrategy": selected["storedStrategy"],
        });
        if !selection_ok {
            return Err(schema::WINDOW_POLICY_FAILED);
        }

        match strategy {
            "cursor" => {
                observations["geometry"]["cursor"] =
                    window_runtime::apply_production_policy(app).await?;
                checkpoint(app, harness, observations, "afterCursor")?;
            }
            "primary" => {
                observations["geometry"]["primary"] =
                    window_runtime::apply_production_policy(app).await?;
                checkpoint(app, harness, observations, "afterPrimary")?;
            }
            "lastActive" => {
                let position = window_runtime::apply_production_policy(app).await?;
                // Hidden positioning intentionally does not collect external-window context.
                observations["geometry"]["lastActiveFallback"] = json!({
                    "externalWindowAvailable": false,
                    "position": position,
                });
                checkpoint(app, harness, observations, "afterLastActive")?;
            }
            "remember" => {
                window_runtime::move_window_away(app).await?;
                let saved = window_runtime::remember_current_position(app)?;
                checkpoint(app, harness, observations, "afterRememberSave")?;
                let (saved_again, moved) = window_runtime::move_window_away(app).await?;
                checkpoint(app, harness, observations, "afterRememberMove")?;
                let restored_sample = window_runtime::apply_production_policy(app).await?;
                observations["geometry"]["remember"] = json!({
                    "monitor": saved["monitor"],
                    "windowSize": {"width": saved["window"]["width"], "height": saved["window"]["height"]},
                    "saved": {"x": saved_again["window"]["x"], "y": saved_again["window"]["y"]},
                    "moved": moved,
                    "restored": {"x": restored_sample["window"]["x"], "y": restored_sample["window"]["y"]},
                });
                checkpoint(app, harness, observations, "afterRememberRestore")?;
            }
            _ => return Err(schema::WINDOW_POLICY_FAILED),
        }
    }

    close_child(app, harness, &child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)?;
    let (fresh_child, fresh_id) = open_general(app, harness, schema::REOPEN_FAILED).await?;
    let reopened = policy_probe::child_general_policies_inspect(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    let fresh = first_id != fresh_id;
    let reopened_ok = fresh
        && reopened["routeGeneral"].as_bool() == Some(true)
        && reopened["uiStrategy"].as_str() == Some("remember")
        && reopened["storedStrategy"].as_str() == Some("remember")
        && read_strategy(&read_general_settings(harness).await?)?.as_deref() == Some("remember");
    observations["windowUi"]["reopened"] = json!({
        "freshSession": fresh,
        "uiStrategy": reopened["uiStrategy"],
        "storedStrategy": reopened["storedStrategy"],
    });
    if !reopened_ok {
        return Err(schema::REOPEN_FAILED);
    }
    checkpoint(app, harness, observations, "afterFreshReopen")?;

    general_policies_clipboard_journey::run(app, harness, &fresh_child, &fixture, observations)
        .await?;

    let restored_strategy = initial_strategy.as_deref().unwrap_or("remember");
    let current = policy_probe::child_general_policies_inspect(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::RESTORE_FAILED)?;
    let restored_ui = if current["uiStrategy"].as_str() == Some(restored_strategy) {
        current
    } else {
        policy_probe::child_general_policies_select_strategy(
            app,
            harness,
            &fresh_child,
            restored_strategy,
        )
        .await
        .map_err(|_| schema::RESTORE_FAILED)?
    };
    if restored_ui["uiStrategy"].as_str() != Some(restored_strategy) {
        return Err(schema::RESTORE_FAILED);
    }
    window_runtime::apply_production_policy(app).await?;
    let restored_days = initial_days.unwrap_or(180);
    let current = policy_probe::child_general_policies_inspect(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::RESTORE_FAILED)?;
    let restored_days_ui = if current["uiDays"].as_u64() == Some(restored_days) {
        current
    } else {
        policy_probe::child_general_policies_set_retention(
            app,
            harness,
            &fresh_child,
            restored_days,
        )
        .await
        .map_err(|_| schema::RESTORE_FAILED)?
    };
    let final_settings = read_general_settings(harness).await?;
    let final_strategy = read_strategy(&final_settings)?;
    let final_days = read_days(&final_settings)?;
    let restore_ok = restored_days_ui["uiStrategy"].as_str() == Some(restored_strategy)
        && final_strategy.as_deref() == Some(restored_strategy)
        && restored_days_ui["uiDays"].as_u64() == Some(restored_days)
        && final_days == Some(restored_days);
    let unrelated_ok = unrelated_preserved(&original, &final_settings);
    observations["windowUi"]["restored"] = json!({
        "uiStrategy": restored_days_ui["uiStrategy"],
        "storedStrategy": final_strategy,
    });
    observations["windowUi"]["unrelatedSettingsPreserved"] = Value::Bool(unrelated_ok);
    observations["clipboard"]["finalUiDays"] = days_value(restored_days_ui["uiDays"].as_u64());
    observations["clipboard"]["finalStoredDays"] = days_value(final_days);
    if !restore_ok {
        return Err(schema::RESTORE_FAILED);
    }
    if !unrelated_ok {
        return Err(schema::UNRELATED_CHANGED);
    }
    checkpoint(app, harness, observations, "afterRestore")?;

    close_child(app, harness, &fresh_child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)?;
    observations["childClosed"] = Value::Bool(true);
    checkpoint(app, harness, observations, "afterClose")?;
    Ok(())
}

async fn restore_and_close(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: &mut Value,
) -> bool {
    let strategy = observations["windowUi"]["initialUiStrategy"]
        .as_str()
        .filter(|strategy| matches!(*strategy, "remember" | "cursor" | "primary" | "lastActive"))
        .unwrap_or("remember");
    let days = observations["clipboard"]["initialUiDays"]
        .as_u64()
        .filter(|days| (1..=3650).contains(days))
        .unwrap_or(180);
    let active = native::active_child(app, Duration::from_secs(1)).await.ok();
    let opened = if let Some((child, _)) = active {
        Ok(child)
    } else if native::wait_for_closed(app).await.is_ok() {
        open_general(app, harness, schema::RESTORE_FAILED)
            .await
            .map(|(child, _)| child)
    } else {
        Err(schema::RESTORE_FAILED)
    };
    let Ok(child) = opened else {
        observations["childClosed"] = Value::Bool(native::wait_for_closed(app).await.is_ok());
        return false;
    };
    let strategy_facts =
        policy_probe::child_general_policies_select_strategy(app, harness, &child, strategy).await;
    let days_facts =
        policy_probe::child_general_policies_set_retention(app, harness, &child, days).await;
    let position = window_runtime::apply_production_policy(app).await;
    let final_settings = read_general_settings(harness).await;
    let restored = strategy_facts.is_ok()
        && days_facts.is_ok()
        && position.is_ok()
        && final_settings.ok().is_some_and(|settings| {
            read_strategy(&settings).ok().flatten().as_deref() == Some(strategy)
                && read_days(&settings).ok().flatten() == Some(days)
        });
    if let Ok(settings) = read_general_settings(harness).await {
        observations["windowUi"]["restored"] = json!({
            "uiStrategy": strategy_facts.ok().and_then(|facts| facts["uiStrategy"].as_str().map(str::to_owned)),
            "storedStrategy": read_strategy(&settings).ok().flatten(),
        });
        observations["clipboard"]["finalUiDays"] = days_facts
            .ok()
            .and_then(|facts| facts["uiDays"].as_u64())
            .map(Value::from)
            .unwrap_or(Value::Null);
        observations["clipboard"]["finalStoredDays"] = read_days(&settings)
            .ok()
            .flatten()
            .map(Value::from)
            .unwrap_or(Value::Null);
    }
    let closed = close_child(app, harness, &child).await.is_ok();
    observations["childClosed"] = Value::Bool(closed);
    let safety = checkpoint(app, harness, observations, "afterClose").is_ok();
    restored && closed && safety
}

async fn open_general(
    app: &AppHandle<Wry>,
    harness: &Harness,
    failure: &'static str,
) -> Result<(Webview<Wry>, String), &'static str> {
    let before = probe::main_open_state(app, harness).await.ok();
    let opened = probe::main_open_settings(app, harness)
        .await
        .map_err(|_| failure)?;
    if opened["openCallAvailable"].as_bool() != Some(true)
        || opened["openCallDispatched"].as_bool() != Some(true)
    {
        return Err(failure);
    }
    let (child, id) = super::diagnostics::active_child_after_open(app, harness, before)
        .await
        .map_err(|_| failure)?;
    let route = probe::child_theme_navigate(app, harness, &child)
        .await
        .map_err(|_| failure)?;
    if route["routeGeneral"].as_bool() != Some(true)
        || route["themeControlFound"].as_bool() != Some(true)
    {
        return Err(failure);
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

pub(super) fn checkpoint(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: &mut Value,
    phase: &str,
) -> Result<(), &'static str> {
    let (visible, focused) = window_runtime::observe_hidden_window(app);
    observations["windowSafety"]["phases"][phase] = json!({"visible": visible, "focused": focused});
    if visible == Some(false) && focused == Some(false) && harness.focus_gained_events() == 0 {
        Ok(())
    } else {
        Err(schema::SAFETY_INVALID)
    }
}

pub(super) async fn read_general_settings(harness: &Harness) -> Result<Value, &'static str> {
    let db = harness.database();
    tauri::async_runtime::spawn_blocking(move || read_settings_from_db(&db))
        .await
        .map_err(|_| schema::READBACK_INVALID)?
}

fn read_settings_from_db(db: &Database) -> Result<Value, &'static str> {
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| schema::READBACK_INVALID)?
        .ok_or(schema::READBACK_INVALID)?;
    if raw.len() > 64 * 1024 {
        return Err(schema::READBACK_INVALID);
    }
    let value: Value = serde_json::from_str(&raw).map_err(|_| schema::READBACK_INVALID)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(schema::READBACK_INVALID)
    }
}

fn read_strategy(settings: &Value) -> Result<Option<String>, &'static str> {
    match settings.get("windowPositionStrategy") {
        None => Ok(None),
        Some(Value::String(value))
            if matches!(
                value.as_str(),
                "remember" | "cursor" | "primary" | "lastActive"
            ) =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err(schema::READBACK_INVALID),
    }
}

pub(super) fn read_days(settings: &Value) -> Result<Option<u64>, &'static str> {
    match settings.get("clipboardRetentionDays") {
        None => Ok(None),
        Some(value)
            if value
                .as_u64()
                .is_some_and(|days| (1..=3650).contains(&days)) =>
        {
            Ok(value.as_u64())
        }
        _ => Err(schema::READBACK_INVALID),
    }
}

fn strategy_value(value: Option<&str>) -> Value {
    value
        .map(|value| Value::String(value.to_owned()))
        .unwrap_or(Value::Null)
}

fn days_value(value: Option<u64>) -> Value {
    value.map(Value::from).unwrap_or(Value::Null)
}

fn unrelated_preserved(before: &Value, after: &Value) -> bool {
    let Some(before) = before.as_object() else {
        return false;
    };
    let Some(after) = after.as_object() else {
        return false;
    };
    let without_policy = |value: &serde_json::Map<String, Value>| {
        value
            .iter()
            .filter(|(key, _)| !UNRELATED_KEYS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>()
    };
    without_policy(before) == without_policy(after)
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

fn push_error(errors: &mut Vec<&'static str>, error: &'static str) {
    if !errors.contains(&error) {
        errors.push(error);
    }
}
