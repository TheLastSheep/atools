use super::{
    command_aliases_open_add_diagnostic as open_add_diagnostic, command_aliases_report as report,
    command_aliases_schema as schema, command_aliases_storage as storage, probe, state::Harness,
};
use atools_core::Database;
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Webview, Wry};

const ADD_ALIAS: &str = "atools-r41-added";
const EDIT_ALIAS: &str = "atools-r41-edited";

pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
) -> Result<(), &'static str> {
    let mut observations = schema::empty_observations();
    let mut errors = Vec::new();
    let before_activity = runtime_activity(app);
    let mut baseline = None;
    let outcome = run_flow(app, harness, target, &mut observations, &mut baseline).await;
    if let Err(error) = outcome {
        errors.push(error);
    }
    if let Some((database, seed)) = baseline.as_ref() {
        let current_raw = storage::raw_aliases(database).await.ok();
        let raw_preserved = current_raw.as_ref().is_some_and(|raw| {
            storage::preserved_alias_data(raw, &seed.raw, storage::target_command(seed))
        });
        let unrelated = storage::unrelated_preserved(database, seed)
            .await
            .unwrap_or(false);
        set_bool(
            &mut observations,
            "unrelatedPreserved",
            Some(raw_preserved && unrelated),
        );
        if !raw_preserved || !unrelated {
            push_error(&mut errors, schema::UNRELATED_CHANGED);
        }
    }
    let after_activity = runtime_activity(app);
    set_bool(
        &mut observations,
        "pluginUiOpened",
        observed_any(before_activity.0, after_activity.0),
    );
    set_bool(
        &mut observations,
        "preloadStarted",
        observed_any(before_activity.1, after_activity.1),
    );
    if observations["pluginUiOpened"].as_bool() != Some(false)
        || observations["preloadStarted"].as_bool() != Some(false)
    {
        push_error(&mut errors, schema::STATE_INVALID);
    }

    let sidecar = report::build(harness.profile(), observations, &errors);
    let report_write = report::write(harness.profile(), &sidecar);
    if report_write.is_err() {
        harness.add_error("settings-input-command-aliases-failed");
        return Err("settings-input-command-aliases-failed");
    }
    if !errors.is_empty() {
        return Err("settings-input-command-aliases-failed");
    }
    Ok(())
}

async fn run_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
    observations: &mut Value,
    baseline: &mut Option<(Database, storage::Baseline)>,
) -> Result<(), &'static str> {
    let (database, seed) = storage::seed_and_read_baseline(harness, target).await?;
    set_bool(observations, "initialStateValid", Some(true));
    *baseline = Some((database, seed));
    if super::native::wait_for_closed(app).await.is_err() || !clear_main_search(app, harness).await
    {
        set_bool(observations, "initialStateValid", Some(false));
        return Err(schema::BASELINE_INVALID);
    }
    let initial = inspect_counters(app, harness, None).await?.counters;
    set_count(
        observations,
        "aliasEventsBefore",
        Some(initial.alias_events),
    );
    set_count(
        observations,
        "appListReadsBefore",
        Some(initial.app_list_reads),
    );

    let (add_child, add_session) = open_child(app, harness).await?;
    let add_menu =
        open_add_diagnostic::open_add_with_diagnostic(app, harness, &add_child, target, ADD_ALIAS)
            .await
            .map_err(|_| schema::ADD_FAILED)?;
    let menu_dispatched = bool_field(&add_menu, "menuDispatched");
    let dialog_opened = bool_field(&add_menu, "dialogOpened");
    set_bool(observations, "addMenuDispatched", Some(menu_dispatched));
    set_bool(observations, "addDialogOpened", Some(dialog_opened));
    if !menu_dispatched || !dialog_opened {
        return Err(schema::ADD_FAILED);
    }
    let added = probe::child_alias_add_save(app, harness, &add_child, ADD_ALIAS)
        .await
        .map_err(|_| schema::ADD_FAILED)?;
    let add_save_dispatched = bool_field(&added, "saveDispatched");
    set_bool(observations, "addSaveDispatched", Some(add_save_dispatched));
    let add_save_completed = bool_field(&added, "saveCompleted");
    if !add_save_dispatched || !add_save_completed {
        return Err(schema::ADD_FAILED);
    }
    let add_raw = storage::raw_aliases(&baseline.as_ref().unwrap().0).await?;
    let add_stored = storage::target_aliases_equal(
        &add_raw,
        storage::target_command(&baseline.as_ref().unwrap().1),
        &[ADD_ALIAS],
    ) && storage::preserved_alias_data(
        &add_raw,
        &baseline.as_ref().unwrap().1.raw,
        storage::target_command(&baseline.as_ref().unwrap().1),
    );
    set_bool(observations, "addStored", Some(add_stored));
    if !add_stored {
        return Err(schema::ADD_FAILED);
    }
    close_child(app, harness, &add_child)
        .await
        .map_err(|_| schema::ADD_FAILED)?;
    let after_add_observation =
        inspect_counters(app, harness, Some(next_event_count(initial.alias_events)?)).await?;
    let after_add = after_add_observation.counters;
    let add_event_ok = after_add_observation.expected_count_reached
        && one_event_after(initial.alias_events, after_add.alias_events);
    set_count(
        observations,
        "aliasEventsAfterAdd",
        Some(after_add.alias_events),
    );
    if !add_event_ok {
        return Err(schema::COUNTER_INVALID);
    }
    let add_search = main_search(app, harness, target, ADD_ALIAS, 1).await?;
    set_count(observations, "addMatchCount", Some(add_search.count));
    set_bool(observations, "addMainMatched", Some(add_search.matched));
    if !add_search.matched || !clear_main_search(app, harness).await {
        return Err(schema::MAIN_SEARCH_INVALID);
    }

    let (edit_child, edit_session) = open_child(app, harness).await?;
    if edit_session == add_session {
        return Err(schema::REOPEN_FAILED);
    }
    let edited = probe::child_alias_edit_save(app, harness, &edit_child, ADD_ALIAS, EDIT_ALIAS)
        .await
        .map_err(|_| schema::EDIT_FAILED)?;
    let edit_save_dispatched = bool_field(&edited, "saveDispatched");
    set_bool(
        observations,
        "editSaveDispatched",
        Some(edit_save_dispatched),
    );
    let edit_save_completed = bool_field(&edited, "saveCompleted");
    if !edit_save_dispatched || !edit_save_completed {
        return Err(schema::EDIT_FAILED);
    }
    let edit_raw = storage::raw_aliases(&baseline.as_ref().unwrap().0).await?;
    let edit_stored = storage::target_aliases_equal(
        &edit_raw,
        storage::target_command(&baseline.as_ref().unwrap().1),
        &[EDIT_ALIAS],
    ) && storage::preserved_alias_data(
        &edit_raw,
        &baseline.as_ref().unwrap().1.raw,
        storage::target_command(&baseline.as_ref().unwrap().1),
    );
    set_bool(observations, "editStored", Some(edit_stored));
    if !edit_stored {
        return Err(schema::EDIT_FAILED);
    }
    close_child(app, harness, &edit_child)
        .await
        .map_err(|_| schema::EDIT_FAILED)?;
    set_bool(observations, "closedAfterEdit", Some(true));
    let after_edit_observation = inspect_counters(
        app,
        harness,
        Some(next_event_count(after_add.alias_events)?),
    )
    .await?;
    let after_edit = after_edit_observation.counters;
    set_count(
        observations,
        "aliasEventsAfterEdit",
        Some(after_edit.alias_events),
    );
    if !after_edit_observation.expected_count_reached
        || !one_event_after(after_add.alias_events, after_edit.alias_events)
    {
        return Err(schema::COUNTER_INVALID);
    }
    let old_search = main_search(app, harness, target, ADD_ALIAS, 0).await?;
    set_count(observations, "editOldMatchCount", Some(old_search.count));
    let new_search = main_search(app, harness, target, EDIT_ALIAS, 1).await?;
    set_count(observations, "editNewMatchCount", Some(new_search.count));
    let edit_main_updated = !old_search.matched && new_search.matched;
    set_bool(observations, "editMainUpdated", Some(edit_main_updated));
    if !edit_main_updated || !clear_main_search(app, harness).await {
        return Err(schema::MAIN_SEARCH_INVALID);
    }

    let (delete_child, delete_session) = open_child(app, harness).await?;
    let fresh_session = delete_session != edit_session;
    set_bool(observations, "freshSessionOnReopen", Some(fresh_session));
    if !fresh_session {
        return Err(schema::REOPEN_FAILED);
    }
    let read_back = probe::child_alias_read_back(app, harness, &delete_child, target, EDIT_ALIAS)
        .await
        .map_err(|_| schema::REOPEN_FAILED)?;
    let reopen_read_back = bool_field(&read_back, "routeValid")
        && bool_field(&read_back, "aliasVisible")
        && storage::target_aliases_equal(
            &storage::raw_aliases(&baseline.as_ref().unwrap().0).await?,
            storage::target_command(&baseline.as_ref().unwrap().1),
            &[EDIT_ALIAS],
        );
    set_bool(observations, "reopenReadBack", Some(reopen_read_back));
    if !reopen_read_back {
        return Err(schema::REOPEN_FAILED);
    }
    let deleted = probe::child_alias_delete(app, harness, &delete_child, EDIT_ALIAS)
        .await
        .map_err(|_| schema::DELETE_FAILED)?;
    let delete_dialog_opened = bool_field(&deleted, "deleteDialogOpened");
    let delete_confirmed = bool_field(&deleted, "deleteConfirmed");
    let row_removed = bool_field(&deleted, "rowRemoved");
    set_bool(
        observations,
        "deleteDialogOpened",
        Some(delete_dialog_opened),
    );
    set_bool(observations, "deleteConfirmed", Some(delete_confirmed));
    if !delete_dialog_opened || !delete_confirmed || !row_removed {
        return Err(schema::DELETE_FAILED);
    }
    let delete_raw = storage::raw_aliases(&baseline.as_ref().unwrap().0).await?;
    let delete_stored = storage::target_aliases_equal(
        &delete_raw,
        storage::target_command(&baseline.as_ref().unwrap().1),
        &[],
    ) && storage::preserved_alias_data(
        &delete_raw,
        &baseline.as_ref().unwrap().1.raw,
        storage::target_command(&baseline.as_ref().unwrap().1),
    );
    set_bool(observations, "deleteStored", Some(delete_stored));
    if !delete_stored {
        return Err(schema::DELETE_FAILED);
    }
    close_child(app, harness, &delete_child)
        .await
        .map_err(|_| schema::DELETE_FAILED)?;
    let after_delete_observation = inspect_counters(
        app,
        harness,
        Some(next_event_count(after_edit.alias_events)?),
    )
    .await?;
    let after_delete = after_delete_observation.counters;
    set_count(
        observations,
        "aliasEventsAfterDelete",
        Some(after_delete.alias_events),
    );
    set_count(
        observations,
        "appListReadsAfter",
        Some(after_delete.app_list_reads),
    );
    let no_reload = initial.app_list_reads == after_delete.app_list_reads;
    set_bool(observations, "noAppCatalogReload", Some(no_reload));
    if !after_delete_observation.expected_count_reached
        || !one_event_after(after_edit.alias_events, after_delete.alias_events)
    {
        return Err(schema::COUNTER_INVALID);
    }
    let delete_search = main_search(app, harness, target, EDIT_ALIAS, 0).await?;
    set_count(observations, "deleteMatchCount", Some(delete_search.count));
    set_bool(
        observations,
        "deleteMainExcluded",
        Some(!delete_search.matched),
    );
    if !delete_search.matched && clear_main_search(app, harness).await && no_reload {
        Ok(())
    } else {
        Err(schema::MAIN_SEARCH_INVALID)
    }
}

async fn open_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(Webview<Wry>, String), &'static str> {
    let before = super::probe::main_open_state(app, harness).await.ok();
    let opened = super::probe::main_open_settings(app, harness)
        .await
        .map_err(|_| schema::OPEN_FAILED)?;
    if !bool_field(&opened, "openCallAvailable") || !bool_field(&opened, "openCallDispatched") {
        return Err(schema::OPEN_FAILED);
    }
    super::diagnostics::active_child_after_open(app, harness, before)
        .await
        .map_err(|_| schema::OPEN_FAILED)
}

async fn close_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<(), &'static str> {
    super::cleanup::close_child_via_plugin(app, harness, child).await
}

async fn main_search(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
    query: &str,
    expected_count: u64,
) -> Result<SearchResult, &'static str> {
    let evidence = probe::main_alias_search(app, harness, target, query, expected_count)
        .await
        .map_err(|_| schema::MAIN_SEARCH_INVALID)?;
    let count = evidence["resultCount"]
        .as_u64()
        .filter(|count| *count <= 4096)
        .ok_or(schema::MAIN_SEARCH_INVALID)?;
    let store_count = evidence["storeTargetCount"]
        .as_u64()
        .filter(|count| *count <= 4096)
        .ok_or(schema::MAIN_SEARCH_INVALID)?;
    let matched = count == 1 && bool_field(&evidence, "matchedTarget");
    let valid = bool_field(&evidence, "inputFound")
        && bool_field(&evidence, "eventDispatched")
        && bool_field(&evidence, "valueMatches")
        && count == expected_count
        && store_count == expected_count
        && bool_field(&evidence, "matchedTarget") == (expected_count == 1);
    if !valid {
        return Err(schema::MAIN_SEARCH_INVALID);
    }
    Ok(SearchResult { count, matched })
}

async fn inspect_counters(
    app: &AppHandle<Wry>,
    harness: &Harness,
    expected_alias_events: Option<u64>,
) -> Result<CounterInspection, &'static str> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let evidence = probe::main_alias_inspect(app, harness)
            .await
            .map_err(|_| schema::COUNTER_INVALID)?;
        if !bool_field(&evidence, "eventSourceListening") {
            return Err(schema::COUNTER_INVALID);
        }
        let counters = Counters {
            alias_events: bounded_count(&evidence, "aliasEvents").ok_or(schema::COUNTER_INVALID)?,
            app_list_reads: bounded_count(&evidence, "appListReads")
                .ok_or(schema::COUNTER_INVALID)?,
        };
        let Some(expected) = expected_alias_events else {
            return Ok(CounterInspection {
                counters,
                expected_count_reached: true,
            });
        };
        if counters.alias_events >= expected || Instant::now() >= deadline {
            return Ok(CounterInspection {
                expected_count_reached: counters.alias_events == expected,
                counters,
            });
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn clear_main_search(app: &AppHandle<Wry>, harness: &Harness) -> bool {
    let input = super::probe::main_input(app, harness, "").await;
    let current = super::probe::main_inspect(app, harness).await;
    input.is_ok_and(|value| {
        bool_field(&value, "inputFound")
            && bool_field(&value, "eventDispatched")
            && bool_field(&value, "valueMatches")
            && bool_field(&value, "inputEmpty")
    }) && current.is_ok_and(|value| bool_field(&value, "inputEmpty"))
}

fn runtime_activity(app: &AppHandle<Wry>) -> (Option<bool>, Option<bool>) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return (None, None);
    };
    let plugin_ui_opened = Some(state.active_plugin.lock().is_some());
    let preload_started = crate::legacy_runtime::inventory_snapshot(app)
        .ok()
        .filter(|(_, truncated)| !truncated)
        .map(|(sessions, _)| !sessions.is_empty());
    (plugin_ui_opened, preload_started)
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

fn one_event_after(before: u64, after: u64) -> bool {
    before
        .checked_add(1)
        .is_some_and(|expected| expected == after && after <= 4096)
}

fn next_event_count(before: u64) -> Result<u64, &'static str> {
    before
        .checked_add(1)
        .filter(|expected| *expected <= 4096)
        .ok_or(schema::COUNTER_INVALID)
}

fn bounded_count(value: &Value, key: &str) -> Option<u64> {
    value[key].as_u64().filter(|count| *count <= 4096)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value[key].as_bool() == Some(true)
}

fn set_bool(observations: &mut Value, key: &str, value: Option<bool>) {
    observations[key] = value.map(Value::Bool).unwrap_or(Value::Null);
}

fn set_count(observations: &mut Value, key: &str, value: Option<u64>) {
    observations[key] = value
        .filter(|count| *count <= 4096)
        .map(Value::from)
        .unwrap_or(Value::Null);
}

fn push_error(errors: &mut Vec<&'static str>, code: &'static str) {
    if !errors.contains(&code) {
        errors.push(code);
    }
}

struct Counters {
    alias_events: u64,
    app_list_reads: u64,
}

struct CounterInspection {
    counters: Counters,
    expected_count_reached: bool,
}

struct SearchResult {
    count: u64,
    matched: bool,
}
