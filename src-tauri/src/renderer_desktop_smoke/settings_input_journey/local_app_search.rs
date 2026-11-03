use super::{
    local_app_search_facts as facts, local_app_search_lifecycle as lifecycle,
    local_app_search_observations::MainSearchObservations, local_app_search_schema as schema,
    probe, state::Harness,
};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};

const CHILD_OPEN_TIMEOUT: Duration = Duration::from_secs(18);

pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<(), &'static str> {
    let mut checks = schema::Checks::default();
    let mut errors = Vec::new();
    let mut observations = MainSearchObservations::default();
    let target = harness.target();
    let second_session = session_id(child);
    let original_settings = facts::read_general(harness).await.ok();
    let initial_catalog = facts::catalog_snapshot(app).await.ok();
    if original_settings.is_none() || initial_catalog.is_none() || second_session.is_none() {
        push_error(&mut errors, harness, schema::PROBE_FAILED);
    }

    checks.target_canonical_path_resolved = target
        .as_ref()
        .zip(initial_catalog.as_ref())
        .is_some_and(|(target, catalog)| facts::target_path_resolved_and_listed(catalog, target));
    if !checks.target_canonical_path_resolved {
        push_error(&mut errors, harness, schema::PATH_RESOLVE_INVALID);
    }
    checks.initial_database_enabled =
        original_settings.as_ref().and_then(facts::local_app_search) == Some(true);

    let initial_ui = probe::child_local_app_search_inspect(app, harness, child)
        .await
        .ok();
    checks.initial_ui_enabled = initial_ui
        .as_ref()
        .is_some_and(|value| child_inspect_valid(value, true));
    if !checks.initial_database_enabled
        || !checks.initial_ui_enabled
        || !checks.target_canonical_path_resolved
    {
        push_error(&mut errors, harness, schema::BASELINE_INVALID);
    }
    if initial_ui.is_none() {
        push_error(&mut errors, harness, schema::PROBE_FAILED);
    }

    let baseline_main = if let Some(target) = target.as_ref() {
        probe::main_local_app_search(app, harness, target, true, None)
            .await
            .ok()
    } else {
        None
    };
    observations.record_baseline(baseline_main.as_ref());
    if baseline_main.is_none() {
        push_error(&mut errors, harness, schema::PROBE_FAILED);
    }
    let timestamp_path = baseline_main
        .as_ref()
        .and_then(|value| value["timestampPath"].as_str())
        .map(str::to_owned);
    let baseline_main_valid = baseline_main.as_ref().is_some_and(|value| {
        main_search_valid(value)
            && app_target_count_valid(value, 1)
            && timestamp_control_valid(value, None)
    });
    if !baseline_main_valid {
        push_error(&mut errors, harness, schema::BASELINE_INVALID);
    }
    if baseline_main
        .as_ref()
        .is_none_or(|value| !timestamp_control_valid(value, None))
    {
        push_error(&mut errors, harness, schema::NON_APP_CONTROL_MISSING);
    }
    let baseline_ready = checks.initial_ui_enabled
        && checks.initial_database_enabled
        && checks.target_canonical_path_resolved
        && baseline_main_valid;

    let mut mutation_may_have_happened = false;
    let mut after_disable_catalog = None;
    if baseline_ready {
        let toggle = probe::child_local_app_search_toggle(app, harness, child, true).await;
        match toggle {
            Ok(value) => {
                checks.disable_ui_click = child_toggle_valid(&value, true, false);
                mutation_may_have_happened = bool_field(&value, "clickDispatched");
            }
            Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
        }
        if !checks.disable_ui_click {
            push_error(&mut errors, harness, schema::CHECKBOX_TOGGLE_FAILED);
        }

        let disabled = facts::wait_general(harness, false).await;
        mutation_may_have_happened |=
            disabled.as_ref().and_then(facts::local_app_search) == Some(false);
        checks.disabled_database_stored = original_settings
            .as_ref()
            .zip(disabled.as_ref())
            .is_some_and(|(before, after)| facts::general_write_matches(before, after, false));
        if !checks.disabled_database_stored {
            push_error(&mut errors, harness, schema::DISABLED_NOT_STORED);
        }

        if let (Some(target), Some(timestamp_path)) = (target.as_ref(), timestamp_path.as_deref()) {
            let filtered =
                probe::main_local_app_search(app, harness, target, false, Some(timestamp_path))
                    .await;
            match filtered {
                Ok(value) => {
                    observations.record_disabled(Some(&value));
                    checks.main_app_excluded =
                        main_search_valid(&value) && app_target_count_valid(&value, 0);
                    checks.main_non_app_preserved_disabled = main_search_valid(&value)
                        && timestamp_control_valid(&value, Some(timestamp_path));
                }
                Err(_) => {
                    observations.record_disabled(None);
                    push_error(&mut errors, harness, schema::PROBE_FAILED);
                }
            }
        }
        if !checks.main_app_excluded {
            push_error(&mut errors, harness, schema::MAIN_APP_NOT_EXCLUDED);
        }
        if !checks.main_non_app_preserved_disabled {
            push_error(&mut errors, harness, schema::NON_APP_CONTROL_MISSING);
        }
        after_disable_catalog = facts::catalog_snapshot(app).await.ok();
        if initial_catalog
            .as_ref()
            .zip(after_disable_catalog.as_ref())
            .is_none_or(|(before, after)| before != after)
        {
            push_error(&mut errors, harness, schema::NATIVE_CATALOG_CHANGED);
        }
    } else {
        after_disable_catalog = initial_catalog.clone();
    }

    let second_closed = lifecycle::close_and_confirm(app, harness, child, &mut errors).await;
    if !second_closed {
        push_error(&mut errors, harness, schema::CHILD_CLOSE_FAILED);
    }

    let mut third_child = None;
    if second_closed {
        match lifecycle::open_child(app, harness).await {
            Ok((opened, id)) => {
                checks.reopened_child_fresh =
                    second_session.as_deref().is_some_and(|old| old != id);
                if !checks.reopened_child_fresh {
                    push_error(&mut errors, harness, schema::REOPEN_FAILED);
                }
                third_child = Some(opened);
            }
            Err(_) => push_error(&mut errors, harness, schema::REOPEN_FAILED),
        }
    }

    let mut reopened_ui = None;
    if let Some(child) = third_child.as_ref() {
        let navigated = probe::child_theme_navigate(app, harness, child)
            .await
            .is_ok_and(|value| bool_field(&value, "routeGeneral"));
        if !navigated {
            push_error(&mut errors, harness, schema::PERSISTENCE_READBACK_INVALID);
        }
        reopened_ui = probe::child_local_app_search_inspect(app, harness, child)
            .await
            .ok();
        checks.reopened_ui_persisted_disabled = reopened_ui
            .as_ref()
            .is_some_and(|value| child_inspect_valid(value, false));
        let reopened_database = facts::read_general(harness).await.ok();
        checks.reopened_database_persisted_disabled = original_settings
            .as_ref()
            .zip(reopened_database.as_ref())
            .is_some_and(|(before, after)| facts::general_write_matches(before, after, false));
        if reopened_ui.is_none() {
            push_error(&mut errors, harness, schema::PROBE_FAILED);
        }
        if !checks.reopened_ui_persisted_disabled
            || !checks.reopened_database_persisted_disabled
            || !checks.reopened_child_fresh
        {
            push_error(&mut errors, harness, schema::PERSISTENCE_READBACK_INVALID);
        }

        let can_enable = mutation_may_have_happened
            && reopened_ui
                .as_ref()
                .is_some_and(|value| child_inspect_valid(value, false));
        if can_enable {
            match probe::child_local_app_search_toggle(app, harness, child, false).await {
                Ok(value) => checks.enable_ui_click = child_toggle_valid(&value, false, true),
                Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
            }
        }
        if !checks.enable_ui_click {
            push_error(&mut errors, harness, schema::CHECKBOX_TOGGLE_FAILED);
        }
    } else if mutation_may_have_happened {
        push_error(&mut errors, harness, schema::CLEANUP_FAILED);
    }

    if mutation_may_have_happened {
        let enabled = facts::wait_general(harness, true).await;
        checks.enabled_database_stored = original_settings
            .as_ref()
            .zip(enabled.as_ref())
            .is_some_and(|(before, after)| facts::general_write_matches(before, after, true));
        if !checks.enabled_database_stored {
            push_error(&mut errors, harness, schema::ENABLED_NOT_STORED);
        }
    }

    if let (Some(target), Some(timestamp_path)) = (target.as_ref(), timestamp_path.as_deref()) {
        match probe::main_local_app_search(app, harness, target, true, Some(timestamp_path)).await {
            Ok(value) => {
                observations.record_enabled(Some(&value));
                checks.main_app_restored =
                    main_search_valid(&value) && app_target_count_valid(&value, 1);
                checks.main_non_app_preserved_enabled = main_search_valid(&value)
                    && timestamp_control_valid(&value, Some(timestamp_path));
            }
            Err(_) => {
                observations.record_enabled(None);
                push_error(&mut errors, harness, schema::PROBE_FAILED);
            }
        }
    }
    if !checks.main_app_restored {
        push_error(&mut errors, harness, schema::MAIN_APP_NOT_RESTORED);
    }
    if !checks.main_non_app_preserved_enabled {
        push_error(&mut errors, harness, schema::NON_APP_CONTROL_MISSING);
    }

    if let Some(child) = third_child.as_ref() {
        let final_ui = probe::child_local_app_search_inspect(app, harness, child)
            .await
            .ok();
        checks.final_ui_enabled = final_ui
            .as_ref()
            .is_some_and(|value| child_inspect_valid(value, true));
        if final_ui.is_none() {
            push_error(&mut errors, harness, schema::PROBE_FAILED);
        }
    }

    if mutation_may_have_happened && (!checks.enabled_database_stored || !checks.final_ui_enabled) {
        lifecycle::restore_through_ui(
            app,
            harness,
            target.as_ref(),
            timestamp_path.as_deref(),
            original_settings.as_ref(),
            &mut checks,
            &mut errors,
        )
        .await;
    }

    let after_enable_catalog = facts::catalog_snapshot(app).await.ok();
    checks.native_catalog_unchanged = initial_catalog
        .as_ref()
        .zip(after_disable_catalog.as_ref())
        .zip(after_enable_catalog.as_ref())
        .is_some_and(|((before, after_disable), after_enable)| {
            target.as_ref().is_some_and(|target| {
                facts::catalog_unchanged(before, after_disable, after_enable, target)
            })
        });
    if !checks.native_catalog_unchanged {
        push_error(&mut errors, harness, schema::NATIVE_CATALOG_CHANGED);
    }

    let active = super::native::active_child(app, Duration::from_secs(2))
        .await
        .ok();
    if let Some((active_child, _)) = active {
        if !lifecycle::close_and_confirm(app, harness, &active_child, &mut errors).await {
            push_error(&mut errors, harness, schema::CHILD_CLOSE_FAILED);
        }
    }
    checks.child_closed = super::native::wait_for_closed(app).await.is_ok();
    if !checks.child_closed {
        push_error(&mut errors, harness, schema::CLEANUP_FAILED);
    }

    if observations.write(harness.profile()).is_err() {
        push_error(&mut errors, harness, schema::REPORT_WRITE_FAILED);
    }
    if let Err(_) = super::local_app_search_report::write(
        harness.profile(),
        &schema::report(harness.profile(), &checks, &errors),
    ) {
        push_error(&mut errors, harness, schema::REPORT_WRITE_FAILED);
    }
    if checks.all_passed() && errors.is_empty() {
        Ok(())
    } else {
        Err(errors.first().copied().unwrap_or(schema::BASELINE_INVALID))
    }
}

pub(super) fn child_inspect_valid(value: &Value, expected_enabled: bool) -> bool {
    bool_field(value, "routeGeneral")
        && bool_field(value, "controlUnique")
        && value["checked"].as_bool() == Some(expected_enabled)
        && bool_field(value, "settingsObject")
        && bool_field(value, "settingsHasBoolean")
        && value["settingsEnabled"].as_bool() == Some(expected_enabled)
        && hidden_unfocused(value)
}

pub(super) fn child_toggle_valid(value: &Value, before: bool, after: bool) -> bool {
    bool_field(value, "routeGeneral")
        && bool_field(value, "controlUnique")
        && value["beforeChecked"].as_bool() == Some(before)
        && bool_field(value, "clickDispatched")
        && value["afterChecked"].as_bool() == Some(after)
        && bool_field(value, "settingsObject")
        && bool_field(value, "settingsHasBoolean")
        && value["settingsEnabled"].as_bool() == Some(after)
        && hidden_unfocused(value)
}

pub(super) fn main_search_valid(value: &Value) -> bool {
    bool_field(value, "storeUnique")
        && bool_field(value, "storeReady")
        && bool_field(value, "searchCallable")
        && hidden_unfocused(value)
}

pub(super) fn app_target_count_valid(value: &Value, expected: u64) -> bool {
    value["appTargetCount"].as_u64() == Some(expected)
}

pub(super) fn timestamp_control_valid(value: &Value, expected_path: Option<&str>) -> bool {
    value["timestampMatchCount"].as_u64() == Some(1)
        && bool_field(value, "timestampIdentityValid")
        && value["timestampPath"].as_str().is_some_and(|path| {
            !path.is_empty() && expected_path.is_none_or(|expected| path == expected)
        })
}

fn hidden_unfocused(value: &Value) -> bool {
    bool_field(value, "documentHidden") && !bool_field(value, "documentHasFocus")
}

pub(super) fn bool_field(value: &Value, key: &str) -> bool {
    value[key].as_bool() == Some(true)
}

fn session_id(child: &Webview<Wry>) -> Option<String> {
    child
        .label()
        .strip_prefix("ztools-settings-")
        .filter(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_owned)
}

fn push_error(errors: &mut Vec<&'static str>, harness: &Harness, code: &'static str) {
    if !errors.contains(&code) {
        errors.push(code);
        harness.add_error(code);
    }
}

#[cfg(test)]
#[path = "local_app_search_tests.rs"]
mod tests;
