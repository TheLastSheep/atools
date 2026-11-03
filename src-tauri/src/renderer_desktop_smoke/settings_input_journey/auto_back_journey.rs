use super::{general_policies_probe as policy_probe, native, state::Harness};
#[path = "auto_back_host.rs"]
mod host;
#[path = "auto_back_observations.rs"]
mod observations;
#[path = "auto_back_phases.rs"]
mod phases;
#[path = "auto_back_settings.rs"]
mod settings;
use host::{navigate_general, open_settings, set_main_query, wait_for_search_return};
use observations::{
    elapsed_ms, empty_observations, push_error, returned_to_search, sample, session_closed,
    session_is_closed, window_is_hidden_unfocused,
};
use serde_json::{json, Value};
use settings::{
    fact_value, optional_policy, policy_value, read_policy, read_settings, required_policy,
    unrelated_preserved,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Webview, Wry};

pub(super) const REPORT_NAME: &str = "native-auto-back-report.json";
const SCOPE: &str = "hidden-original-vue-auto-back-search";
const BASELINE_INVALID: &str = "settings-input-auto-back-baseline-invalid";
const SAVE_FAILED: &str = "settings-input-auto-back-save-failed";
const HIDE_FAILED: &str = "settings-input-auto-back-hide-failed";
const DELAYED_EARLY: &str = "settings-input-auto-back-delayed-early";
const DELAYED_RETURN_FAILED: &str = "settings-input-auto-back-delayed-return-failed";
const FRESH_REOPEN_FAILED: &str = "settings-input-auto-back-fresh-reopen-failed";
const IMMEDIATE_RETURN_FAILED: &str = "settings-input-auto-back-immediate-return-failed";
const GLOBAL_RETURN_FAILED: &str = "settings-input-auto-back-global-return-failed";
const RESTORE_FAILED: &str = "settings-input-auto-back-restore-failed";
const WINDOW_STATE_INVALID: &str = "settings-input-auto-back-window-state-invalid";
const UNRELATED_CHANGED: &str = "settings-input-auto-back-unrelated-settings-changed";

const EARLY_OBSERVATION: Duration = Duration::from_millis(150);
const DELAYED_RETURN_TIMEOUT: Duration = Duration::from_secs(40);
const IMMEDIATE_RETURN_TIMEOUT: Duration = Duration::from_secs(8);
struct RepairState {
    original_settings: Option<Value>,
    baseline_policy: Option<String>,
    pending_timer: Option<(Instant, Duration)>,
}

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let focus_events_before = harness.focus_gained_events();
    let mut observations = empty_observations();
    let mut errors = Vec::new();
    let mut repair = RepairState {
        original_settings: None,
        baseline_policy: None,
        pending_timer: None,
    };
    let outcome = run_flow(
        app,
        harness,
        focus_events_before,
        &mut observations,
        &mut repair,
    )
    .await;
    if let Err(error) = outcome {
        push_error(&mut errors, error);
        if !restore_after_failure(
            app,
            harness,
            focus_events_before,
            &mut observations,
            &mut repair,
        )
        .await
        {
            push_error(&mut errors, RESTORE_FAILED);
        }
    }
    observations["final"]["focusEvents"] = Value::from(harness.focus_gained_events());
    if observations["final"]["focusEvents"].as_u64() != Some(focus_events_before) {
        push_error(&mut errors, WINDOW_STATE_INVALID);
    }
    let report = json!({
        "schemaVersion": 1,
        "journey": "settings-auto-back-search",
        "scope": SCOPE,
        "identifier": harness.profile().identifier,
        "root": harness.profile().root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": harness.profile().run_id,
        "observations": observations,
        "errors": errors,
    });
    if super::local_app_search_report::write_owned_artifact(harness.profile(), REPORT_NAME, &report)
        .is_err()
    {
        return Err("settings-input-journey-failed");
    }
    if errors.is_empty() && outcome.is_ok() {
        Ok(())
    } else {
        Err("settings-input-journey-failed")
    }
}

async fn run_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    focus_events_before: u64,
    observations: &mut Value,
    repair: &mut RepairState,
) -> Result<(), &'static str> {
    observations["focusEventsBefore"] = Value::from(focus_events_before);
    native::wait_for_closed(app)
        .await
        .map_err(|_| BASELINE_INVALID)?;
    let before_open = crate::renderer_settings_view::snapshot(app);
    observations["baseline"]["sessionCountBefore"] = before_open["sessionCount"].clone();
    observations["baseline"]["childPresentBefore"] = before_open["childPresent"].clone();
    let no_session_before_open = before_open["stateAvailable"].as_bool() == Some(true)
        && before_open["runtimeInitialized"].as_bool() == Some(true)
        && before_open["sessionCount"].as_u64() == Some(0)
        && before_open["childPresent"].as_bool() == Some(false)
        && before_open["pendingCalls"].as_u64() == Some(0)
        && before_open["pendingWrites"].as_u64() == Some(0)
        && crate::window::main_child_layout_active_count(app).ok() == Some(0);
    let original = read_settings(harness).await?;
    observations["baseline"]["sqliteValue"] = policy_value(&original);
    observations["baseline"]["sqliteValueMissing"] =
        Value::Bool(original.get("autoBackToSearch").is_none());
    let baseline_stored = read_policy(&original)?;
    repair.original_settings = Some(original.clone());
    let (child, first_session) = open_settings(app, harness, BASELINE_INVALID).await?;
    let fresh_session_id_observed = !first_session.is_empty();
    observations["baseline"]["freshSessionIdObserved"] = Value::Bool(fresh_session_id_observed);
    let session_fresh = no_session_before_open && fresh_session_id_observed;
    observations["baseline"]["sessionFresh"] = Value::Bool(session_fresh);
    if !session_fresh {
        return Err(BASELINE_INVALID);
    }
    let navigation = navigate_general(app, harness, &child, BASELINE_INVALID).await?;
    observations["baseline"]["navigationDispatched"] = navigation["navigationDispatched"].clone();
    observations["baseline"]["navigationRouteGeneral"] = navigation["routeGeneral"].clone();
    observations["baseline"]["themeControlFound"] = navigation["themeControlFound"].clone();
    let baseline_facts =
        policy_probe::child_general_policies_auto_back_inspect(app, harness, &child)
            .await
            .map_err(|_| BASELINE_INVALID)?;
    observations["baseline"]["routeGeneral"] = baseline_facts["routeGeneral"].clone();
    observations["baseline"]["controlUnique"] = baseline_facts["controlUnique"].clone();
    observations["baseline"]["uiValue"] = fact_value(&baseline_facts, "uiValue");
    observations["baseline"]["browserDbValue"] = fact_value(&baseline_facts, "dbValue");
    let baseline_ui = required_policy(&baseline_facts, "uiValue").ok_or(BASELINE_INVALID)?;
    let baseline_browser = optional_policy(&baseline_facts, "dbValue");
    let effective_baseline = baseline_stored.as_deref().unwrap_or("never");
    let baseline_valid = baseline_facts["routeGeneral"].as_bool() == Some(true)
        && baseline_facts["controlUnique"].as_bool() == Some(true)
        && navigation["routeGeneral"].as_bool() == Some(true)
        && navigation["themeControlFound"].as_bool() == Some(true)
        && baseline_ui == effective_baseline
        && baseline_browser.as_deref() == Some(effective_baseline);
    observations["baseline"] = json!({
        "sessionCountBefore": before_open["sessionCount"],
        "childPresentBefore": before_open["childPresent"],
        "freshSessionIdObserved": fresh_session_id_observed,
        "sessionFresh": session_fresh,
        "navigationDispatched": navigation["navigationDispatched"],
        "routeGeneral": baseline_facts["routeGeneral"],
        "controlUnique": baseline_facts["controlUnique"],
        "uiValue": baseline_ui,
        "effectiveValue": effective_baseline,
        "sqliteValue": policy_value(&original),
        "sqliteValueMissing": baseline_stored.is_none(),
        "browserDbValue": baseline_browser,
    });
    if !baseline_valid {
        return Err(BASELINE_INVALID);
    }
    repair.baseline_policy = Some(effective_baseline.to_owned());

    phases::run_delayed(
        app,
        harness,
        &child,
        &first_session,
        &original,
        focus_events_before,
        observations,
        repair,
    )
    .await?;

    native::wait_for_closed(app)
        .await
        .map_err(|_| DELAYED_RETURN_FAILED)?;
    let (fresh_child, fresh_session) = open_settings(app, harness, FRESH_REOPEN_FAILED).await?;
    observations["freshReopen"]["sessionChanged"] = Value::Bool(fresh_session != first_session);
    let fresh_navigation =
        navigate_general(app, harness, &fresh_child, FRESH_REOPEN_FAILED).await?;
    observations["freshReopen"]["navigationDispatched"] =
        fresh_navigation["navigationDispatched"].clone();
    observations["freshReopen"]["navigationRouteGeneral"] =
        fresh_navigation["routeGeneral"].clone();
    observations["freshReopen"]["themeControlFound"] =
        fresh_navigation["themeControlFound"].clone();
    let fresh_facts =
        policy_probe::child_general_policies_auto_back_inspect(app, harness, &fresh_child)
            .await
            .map_err(|_| FRESH_REOPEN_FAILED)?;
    observations["freshReopen"] = json!({
        "sessionChanged": fresh_session != first_session,
        "navigationDispatched": fresh_navigation["navigationDispatched"],
        "navigationRouteGeneral": fresh_navigation["routeGeneral"],
        "themeControlFound": fresh_navigation["themeControlFound"],
        "routeGeneral": fresh_facts["routeGeneral"],
        "controlUnique": fresh_facts["controlUnique"],
        "uiValue": fact_value(&fresh_facts, "uiValue"),
        "browserDbValue": fact_value(&fresh_facts, "dbValue"),
        "sqliteValue": null,
        "unrelatedSettingsUnchanged": null,
    });
    let reopened_db = read_settings(harness)
        .await
        .map_err(|_| FRESH_REOPEN_FAILED)?;
    let reopened_policy = read_policy(&reopened_db).map_err(|_| FRESH_REOPEN_FAILED)?;
    let fresh_ok = fresh_session != first_session
        && fresh_facts["routeGeneral"].as_bool() == Some(true)
        && fresh_facts["controlUnique"].as_bool() == Some(true)
        && fresh_facts["uiValue"].as_str() == Some("30s")
        && fresh_facts["dbValue"].as_str() == Some("30s")
        && reopened_policy.as_deref() == Some("30s")
        && unrelated_preserved(&original, &reopened_db);
    observations["freshReopen"]["sqliteValue"] = policy_value(&reopened_db);
    observations["freshReopen"]["unrelatedSettingsUnchanged"] =
        Value::Bool(unrelated_preserved(&original, &reopened_db));
    if !fresh_ok {
        return Err(FRESH_REOPEN_FAILED);
    }

    phases::run_immediate(
        app,
        harness,
        &fresh_child,
        &fresh_session,
        &original,
        focus_events_before,
        observations,
        repair,
    )
    .await?;

    // Exercise the unscoped global return while already in search, with no child session.
    let query = format!(
        "__atools_auto_back_search_{}",
        &harness.profile().run_id[..8]
    );
    set_main_query(app, harness, &query, GLOBAL_RETURN_FAILED).await?;
    let before_global = sample(app, harness).await;
    observations["globalSearch"]["beforeHide"] = before_global.clone();
    if before_global["queryEmpty"].as_bool() != Some(false)
        || !session_is_closed(&before_global)
        || before_global["pluginDomPresent"].as_bool() != Some(false)
        || before_global["searchDomPresent"].as_bool() != Some(true)
        || !window_is_hidden_unfocused(&before_global, focus_events_before)
    {
        return Err(GLOBAL_RETURN_FAILED);
    }
    let global_started = Instant::now();
    crate::window::hide_main_window(app).map_err(|_| HIDE_FAILED)?;
    repair.pending_timer = Some((global_started, IMMEDIATE_RETURN_TIMEOUT));
    let global_after = wait_for_search_return(
        app,
        harness,
        IMMEDIATE_RETURN_TIMEOUT,
        GLOBAL_RETURN_FAILED,
        focus_events_before,
    )
    .await?;
    let global_elapsed = elapsed_ms(global_started);
    repair.pending_timer = None;
    observations["globalSearch"]["elapsedMs"] = Value::from(global_elapsed);
    observations["globalSearch"]["afterReturn"] = global_after.clone();
    if !returned_to_search(&global_after, focus_events_before) {
        return Err(GLOBAL_RETURN_FAILED);
    }

    restore_baseline_and_close(app, harness, focus_events_before, observations, repair).await?;
    Ok(())
}

struct SaveResult {
    facts: Value,
}

async fn save_policy(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    original: &Value,
    expected: &str,
) -> Result<SaveResult, &'static str> {
    let started = Instant::now();
    let evidence =
        policy_probe::child_general_policies_auto_back_select(app, harness, child, expected)
            .await
            .map_err(|_| SAVE_FAILED)?;
    let sqlite = read_settings(harness).await.map_err(|_| SAVE_FAILED)?;
    let preserved = unrelated_preserved(original, &sqlite);
    let valid = evidence["routeGeneral"].as_bool() == Some(true)
        && evidence["controlUnique"].as_bool() == Some(true)
        && evidence["selectionDispatched"].as_bool() == Some(true)
        && evidence["optionSetValid"].as_bool() == Some(true)
        && evidence["uiValue"].as_str() == Some(expected)
        && evidence["dbValue"].as_str() == Some(expected)
        && read_policy(&sqlite).ok().flatten().as_deref() == Some(expected)
        && preserved;
    let facts = json!({
        "value": expected,
        "routeGeneral": evidence["routeGeneral"],
        "controlUnique": evidence["controlUnique"],
        "selectionDispatched": evidence["selectionDispatched"],
        "optionSetValid": evidence["optionSetValid"],
        "uiValue": fact_value(&evidence, "uiValue"),
        "browserDbValue": fact_value(&evidence, "dbValue"),
        "sqliteValue": policy_value(&sqlite),
        "unrelatedSettingsUnchanged": preserved,
        "elapsedMs": elapsed_ms(started),
    });
    if !preserved {
        return Err(UNRELATED_CHANGED);
    }
    if !valid {
        return Err(SAVE_FAILED);
    }
    Ok(SaveResult { facts })
}

async fn restore_baseline_and_close(
    app: &AppHandle<Wry>,
    harness: &Harness,
    focus_events_before: u64,
    observations: &mut Value,
    repair: &RepairState,
) -> Result<(), &'static str> {
    if let Some((started, timeout)) = repair.pending_timer {
        let remaining = timeout.saturating_sub(started.elapsed());
        if !remaining.is_zero() {
            wait_for_search_return(app, harness, remaining, RESTORE_FAILED, focus_events_before)
                .await?;
        }
    }
    let baseline = repair.baseline_policy.as_deref();
    let active = native::active_child(app, Duration::from_millis(400))
        .await
        .ok();
    let mut child_to_close = active.map(|(child, _)| child);
    if let Some(expected) = baseline {
        if child_to_close.is_none() {
            let (child, _) = open_settings(app, harness, RESTORE_FAILED).await?;
            child_to_close = Some(child);
        }
        let child = child_to_close.as_ref().ok_or(RESTORE_FAILED)?;
        let current = policy_probe::child_general_policies_auto_back_inspect(app, harness, child)
            .await
            .map_err(|_| RESTORE_FAILED)?;
        if current["routeGeneral"].as_bool() != Some(true) {
            navigate_general(app, harness, child, RESTORE_FAILED).await?;
        }
        let evidence =
            policy_probe::child_general_policies_auto_back_select(app, harness, child, expected)
                .await
                .map_err(|_| RESTORE_FAILED)?;
        let restored_settings = read_settings(harness).await.map_err(|_| RESTORE_FAILED)?;
        let sqlite_value = read_policy(&restored_settings).map_err(|_| RESTORE_FAILED)?;
        let original = repair.original_settings.as_ref().ok_or(RESTORE_FAILED)?;
        let unrelated_ok = unrelated_preserved(original, &restored_settings);
        let restored_ok = evidence["routeGeneral"].as_bool() == Some(true)
            && evidence["controlUnique"].as_bool() == Some(true)
            && evidence["selectionDispatched"].as_bool() == Some(true)
            && evidence["optionSetValid"].as_bool() == Some(true)
            && evidence["uiValue"].as_str() == Some(expected)
            && evidence["dbValue"].as_str() == Some(expected)
            && sqlite_value.as_deref() == Some(expected)
            && unrelated_ok;
        observations["restored"] = json!({
            "uiValue": fact_value(&evidence, "uiValue"),
            "browserDbValue": fact_value(&evidence, "dbValue"),
            "optionSetValid": evidence["optionSetValid"],
            "sqliteValue": policy_value(&restored_settings),
            "sqliteValueMissing": sqlite_value.is_none(),
            "baselineValue": expected,
            "baselineRestored": restored_ok,
            "unrelatedSettingsUnchanged": unrelated_ok,
        });
        if !restored_ok {
            if !unrelated_ok {
                return Err(UNRELATED_CHANGED);
            }
            return Err(RESTORE_FAILED);
        }
    } else {
        observations["restored"]["baselineRestored"] = Value::Bool(false);
    }
    if let Some(child) = child_to_close.as_ref() {
        super::cleanup::close_child_via_plugin(app, harness, child)
            .await
            .map_err(|_| RESTORE_FAILED)?;
        native::wait_for_closed(app)
            .await
            .map_err(|_| RESTORE_FAILED)?;
    }
    let final_facts = sample(app, harness).await;
    let closed = session_closed(app)
        && final_facts["mainWindowHidden"].as_bool() == Some(true)
        && final_facts["mainWindowFocused"].as_bool() == Some(false);
    observations["final"] = json!({
        "childClosed": closed,
        "settingsSessionCount": final_facts["settingsSessionCount"],
        "settingsChildPresent": final_facts["settingsChildPresent"],
        "queryEmpty": final_facts["queryEmpty"],
        "pluginDomPresent": final_facts["pluginDomPresent"],
        "searchDomPresent": final_facts["searchDomPresent"],
        "mainWindowHidden": final_facts["mainWindowHidden"],
        "mainWindowFocused": final_facts["mainWindowFocused"],
        "focusEvents": final_facts["focusEvents"],
    });
    if !closed {
        return Err(RESTORE_FAILED);
    }
    Ok(())
}

async fn restore_after_failure(
    app: &AppHandle<Wry>,
    harness: &Harness,
    focus_events_before: u64,
    observations: &mut Value,
    repair: &mut RepairState,
) -> bool {
    if restore_baseline_and_close(app, harness, focus_events_before, observations, repair)
        .await
        .is_ok()
    {
        return true;
    }
    if let Ok((child, _)) = native::active_child(app, Duration::from_millis(400)).await {
        let _ = super::cleanup::close_child_via_plugin(app, harness, &child).await;
        let _ = native::wait_for_closed(app).await;
    }
    false
}
