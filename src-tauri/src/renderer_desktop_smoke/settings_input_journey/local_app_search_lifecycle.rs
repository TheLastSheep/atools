use super::{
    local_app_search as criteria, local_app_search_facts as facts,
    local_app_search_schema as schema, probe, state::Harness,
};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const CHILD_OPEN_TIMEOUT: Duration = Duration::from_secs(18);

pub(super) async fn open_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(Webview<Wry>, String), &'static str> {
    let before = probe::main_open_state(app, harness).await.ok();
    let evidence = probe::main_open_settings(app, harness).await?;
    if !criteria::bool_field(&evidence, "openCallAvailable")
        || !criteria::bool_field(&evidence, "openCallDispatched")
    {
        return Err(schema::REOPEN_FAILED);
    }
    super::diagnostics::active_child_after_open(app, harness, before).await
}

pub(super) async fn close_and_confirm(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    errors: &mut Vec<&'static str>,
) -> bool {
    if super::cleanup::close_child_via_plugin(app, harness, child)
        .await
        .is_ok()
    {
        return true;
    }
    push_error(errors, harness, schema::CHILD_CLOSE_FAILED);
    super::native::wait_for_closed(app).await.is_ok()
}

pub(super) async fn restore_through_ui(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: Option<&(String, String)>,
    timestamp_path: Option<&str>,
    original_settings: Option<&Value>,
    checks: &mut schema::Checks,
    errors: &mut Vec<&'static str>,
) {
    let active = super::native::active_child(app, Duration::from_secs(2))
        .await
        .ok();
    let child = match active {
        Some((child, _)) => Some(child),
        None => {
            let database_disabled = facts::read_general(harness)
                .await
                .ok()
                .and_then(|value| facts::local_app_search(&value))
                != Some(true);
            let closed = super::native::wait_for_closed(app).await.is_ok();
            if !closed {
                super::native::active_child(app, CHILD_OPEN_TIMEOUT)
                    .await
                    .ok()
                    .map(|(child, _)| child)
            } else if !database_disabled {
                None
            } else {
                match open_child(app, harness).await {
                    Ok((child, _)) => Some(child),
                    Err(_) => super::native::active_child(app, CHILD_OPEN_TIMEOUT)
                        .await
                        .ok()
                        .map(|(child, _)| child),
                }
            }
        }
    };
    let Some(child) = child else {
        push_error(errors, harness, schema::CLEANUP_FAILED);
        return;
    };

    let _ = probe::child_theme_navigate(app, harness, &child).await;
    let before = probe::child_local_app_search_inspect(app, harness, &child)
        .await
        .ok();
    if let Some(before) = before.as_ref() {
        let route_ready = criteria::bool_field(before, "routeGeneral")
            && criteria::bool_field(before, "controlUnique");
        let database_enabled = facts::read_general(harness)
            .await
            .ok()
            .and_then(|value| facts::local_app_search(&value));
        if route_ready
            && before["checked"].as_bool() == Some(true)
            && database_enabled != Some(true)
        {
            match probe::child_local_app_search_toggle(app, harness, &child, true).await {
                Ok(value) if criteria::child_toggle_valid(&value, true, false) => {
                    let disabled = facts::wait_general(harness, false).await;
                    if disabled
                        .as_ref()
                        .is_some_and(|value| facts::local_app_search(value) == Some(false))
                    {
                        let reset = probe::child_local_app_search_inspect(app, harness, &child)
                            .await
                            .ok();
                        if reset
                            .as_ref()
                            .is_some_and(|value| criteria::child_inspect_valid(value, false))
                        {
                            match probe::child_local_app_search_toggle(app, harness, &child, false)
                                .await
                            {
                                Ok(value) if criteria::child_toggle_valid(&value, false, true) => {
                                    checks.enable_ui_click = true;
                                }
                                _ => push_error(errors, harness, schema::CLEANUP_FAILED),
                            }
                        }
                    }
                }
                _ => push_error(errors, harness, schema::CLEANUP_FAILED),
            }
        } else if route_ready && before["checked"].as_bool() == Some(false) {
            match probe::child_local_app_search_toggle(app, harness, &child, false).await {
                Ok(value) if criteria::child_toggle_valid(&value, false, true) => {
                    checks.enable_ui_click = true;
                }
                _ => push_error(errors, harness, schema::CLEANUP_FAILED),
            }
        }
    } else {
        push_error(errors, harness, schema::PROBE_FAILED);
    }

    let enabled = facts::wait_general(harness, true).await;
    checks.enabled_database_stored = original_settings
        .zip(enabled.as_ref())
        .is_some_and(|(before, after)| facts::general_write_matches(before, after, true));
    let final_ui = probe::child_local_app_search_inspect(app, harness, &child)
        .await
        .ok();
    checks.final_ui_enabled = final_ui
        .as_ref()
        .is_some_and(|value| criteria::child_inspect_valid(value, true));
    if !checks.enabled_database_stored || !checks.final_ui_enabled {
        push_error(errors, harness, schema::CLEANUP_FAILED);
    }
    if let (Some(target), Some(timestamp_path)) = (target, timestamp_path) {
        if let Ok(value) =
            probe::main_local_app_search(app, harness, target, true, Some(timestamp_path)).await
        {
            checks.main_app_restored =
                criteria::main_search_valid(&value) && criteria::app_target_count_valid(&value, 1);
            checks.main_non_app_preserved_enabled = criteria::main_search_valid(&value)
                && criteria::timestamp_control_valid(&value, Some(timestamp_path));
        }
    }
}

fn push_error(errors: &mut Vec<&'static str>, harness: &Harness, code: &'static str) {
    if !errors.contains(&code) {
        errors.push(code);
        harness.add_error(code);
    }
}
