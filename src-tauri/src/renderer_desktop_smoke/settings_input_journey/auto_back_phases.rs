use super::{
    host,
    observations::{
        elapsed_ms, returned_to_search, sample, session_is_active, window_is_hidden_unfocused,
    },
    RepairState,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Webview, Wry};

pub(super) async fn run_delayed(
    app: &AppHandle<Wry>,
    harness: &super::Harness,
    child: &Webview<Wry>,
    session_id: &str,
    original: &Value,
    focus_events_before: u64,
    observations: &mut Value,
    repair: &mut RepairState,
) -> Result<(), &'static str> {
    let saved = super::save_policy(app, harness, child, original, "30s").await?;
    observations["save30s"] = saved.facts;
    let query = format!("__atools_auto_back_30s_{}", &harness.profile().run_id[..8]);
    let queryable = host::prepare_queryable_settings_and_set_main_query(
        app,
        harness,
        child,
        session_id,
        observations["save30s"]["routeGeneral"].as_bool() == Some(true),
        &query,
    )
    .await;
    observations["save30s"]["queryableSettings"] = queryable.clone();
    if queryable["ready"].as_bool() != Some(true) {
        return Err(super::DELAYED_RETURN_FAILED);
    }

    let before_hide = sample(app, harness).await;
    observations["delayed"]["beforeHide"] = before_hide.clone();
    if before_hide["queryEmpty"].as_bool() != Some(false)
        || !session_is_active(&before_hide)
        || !window_is_hidden_unfocused(&before_hide, focus_events_before)
    {
        return Err(super::WINDOW_STATE_INVALID);
    }

    let hide_started = Instant::now();
    crate::window::hide_main_window(app).map_err(|_| super::HIDE_FAILED)?;
    repair.pending_timer = Some((hide_started, super::DELAYED_RETURN_TIMEOUT));
    tokio::time::sleep(super::EARLY_OBSERVATION).await;
    let early = sample(app, harness).await;
    observations["delayed"]["after150ms"] = early.clone();
    if !session_is_active(&early)
        || early["queryEmpty"].as_bool() != Some(false)
        || !window_is_hidden_unfocused(&early, focus_events_before)
    {
        return Err(super::DELAYED_EARLY);
    }
    let delayed_after = host::wait_for_search_return(
        app,
        harness,
        super::DELAYED_RETURN_TIMEOUT,
        super::DELAYED_RETURN_FAILED,
        focus_events_before,
    )
    .await?;
    let delayed_elapsed = elapsed_ms(hide_started);
    repair.pending_timer = None;
    observations["delayed"]["elapsedMs"] = Value::from(delayed_elapsed);
    observations["delayed"]["afterReturn"] = delayed_after.clone();
    if delayed_elapsed < 30_000
        || delayed_elapsed > 40_000
        || !returned_to_search(&delayed_after, focus_events_before)
    {
        return Err(super::DELAYED_RETURN_FAILED);
    }
    Ok(())
}

pub(super) async fn run_immediate(
    app: &AppHandle<Wry>,
    harness: &super::Harness,
    child: &Webview<Wry>,
    session_id: &str,
    original: &Value,
    focus_events_before: u64,
    observations: &mut Value,
    repair: &mut RepairState,
) -> Result<(), &'static str> {
    let saved = super::save_policy(app, harness, child, original, "immediately").await?;
    observations["saveImmediately"] = saved.facts;
    let query = format!(
        "__atools_auto_back_immediate_{}",
        &harness.profile().run_id[..8]
    );
    let queryable = host::prepare_queryable_settings_and_set_main_query(
        app,
        harness,
        child,
        session_id,
        observations["saveImmediately"]["routeGeneral"].as_bool() == Some(true),
        &query,
    )
    .await;
    observations["saveImmediately"]["queryableSettings"] = queryable.clone();
    if queryable["ready"].as_bool() != Some(true) {
        return Err(super::IMMEDIATE_RETURN_FAILED);
    }

    let before = sample(app, harness).await;
    observations["immediate"]["beforeHide"] = before.clone();
    if before["queryEmpty"].as_bool() != Some(false)
        || !session_is_active(&before)
        || !window_is_hidden_unfocused(&before, focus_events_before)
    {
        return Err(super::IMMEDIATE_RETURN_FAILED);
    }
    let started = Instant::now();
    crate::window::hide_main_window(app).map_err(|_| super::HIDE_FAILED)?;
    repair.pending_timer = Some((started, super::IMMEDIATE_RETURN_TIMEOUT));
    let after = host::wait_for_search_return(
        app,
        harness,
        super::IMMEDIATE_RETURN_TIMEOUT,
        super::IMMEDIATE_RETURN_FAILED,
        focus_events_before,
    )
    .await?;
    let elapsed = elapsed_ms(started);
    repair.pending_timer = None;
    observations["immediate"]["elapsedMs"] = Value::from(elapsed);
    observations["immediate"]["afterReturn"] = after.clone();
    if !returned_to_search(&after, focus_events_before) {
        return Err(super::IMMEDIATE_RETURN_FAILED);
    }
    Ok(())
}
