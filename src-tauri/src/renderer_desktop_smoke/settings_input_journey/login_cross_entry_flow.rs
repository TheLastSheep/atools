use super::{
    login_cross_entry_journey::Progress, login_cross_entry_probe as probe,
    login_cross_entry_schema as schema, login_cross_entry_storage as storage, state::Harness,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview, Wry};

pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &Harness,
    progress: &Progress,
    child: &mut Webview<Wry>,
    session: &mut String,
) -> Result<(), &'static str> {
    let db = harness.database();
    let original = storage::snapshot_original(app, db.clone()).await?;
    let original_launch_at_login = original.original_launch_at_login;
    progress.set_original(original.clone());
    if storage::read_native(app).await != Some(true) {
        return Err(schema::BASELINE_INVALID);
    }
    storage::seed_disabled(app, db.clone(), &original, &harness.profile().run_id).await?;
    let initial_vue = probe::vue_inspect(app, harness, child)
        .await
        .map_err(|_| schema::BASELINE_INVALID)?;
    let initial = record_vue(app, harness, progress, "initial", &initial_vue, None).await?;
    if !schema::stage_matches("initial", &initial, original_launch_at_login) {
        return Err(schema::BASELINE_INVALID);
    }

    super::launch_at_login_journey::close_child(app, harness, child)
        .await
        .map_err(|_| schema::CHILD_CLOSE_FAILED)?;
    let (fallback_window, fallback_view) = super::login_cross_entry_window::open(app)
        .await
        .map_err(|_| schema::FALLBACK_OPEN_FAILED)?;
    progress.set_fallback(fallback_window, fallback_view);
    let fallback_view = progress
        .fallback_view()
        .ok_or(schema::FALLBACK_OPEN_FAILED)?;
    let fallback_initial = probe::wait_fallback_loaded(app, harness, &fallback_view)
        .await
        .map_err(|_| schema::FALLBACK_PROBE_INVALID)?;
    let stage = record_fallback(
        app,
        harness,
        progress,
        "fallbackInitial",
        &fallback_initial,
        None,
    )
    .await?;
    if !schema::stage_matches("fallbackInitial", &stage, original_launch_at_login) {
        return Err(schema::FALLBACK_PROBE_INVALID);
    }

    let disabled = probe::fallback(app, harness, &fallback_view, "fallbackLoginDisable")
        .await
        .map_err(|_| schema::FALLBACK_DISABLE_FAILED)?;
    let stage = record_fallback(
        app,
        harness,
        progress,
        "fallbackDisabled",
        &disabled,
        Some(&disabled),
    )
    .await?;
    if !schema::stage_matches("fallbackDisabled", &stage, original_launch_at_login) {
        return Err(schema::FALLBACK_DISABLE_FAILED);
    }
    close_fallback(app, progress).await?;

    let previous_session = session.clone();
    let (fresh_disabled, fresh_session) = super::launch_at_login_journey::open_child(app, harness)
        .await
        .map_err(|_| schema::VUE_READBACK_INVALID)?;
    if fresh_session == previous_session {
        return Err(schema::VUE_READBACK_INVALID);
    }
    *child = fresh_disabled;
    *session = fresh_session;
    let vue_disabled = probe::vue_inspect(app, harness, child)
        .await
        .map_err(|_| schema::VUE_READBACK_INVALID)?;
    let stage = record_vue(
        app,
        harness,
        progress,
        "vueAfterDisabled",
        &vue_disabled,
        None,
    )
    .await?;
    if !schema::stage_matches("vueAfterDisabled", &stage, original_launch_at_login) {
        return Err(schema::VUE_READBACK_INVALID);
    }

    let enabled = probe::vue_enable(app, harness, child)
        .await
        .map_err(|_| schema::VUE_ENABLE_FAILED)?;
    let stage = record_vue(
        app,
        harness,
        progress,
        "vueReenabled",
        &enabled,
        Some(&enabled),
    )
    .await?;
    if !schema::stage_matches("vueReenabled", &stage, original_launch_at_login) {
        return Err(schema::VUE_ENABLE_FAILED);
    }
    super::launch_at_login_journey::close_child(app, harness, child)
        .await
        .map_err(|_| schema::CHILD_CLOSE_FAILED)?;

    let (fallback_window, fallback_view) = super::login_cross_entry_window::open(app)
        .await
        .map_err(|_| schema::FALLBACK_OPEN_FAILED)?;
    progress.set_fallback(fallback_window, fallback_view);
    let fallback_view = progress
        .fallback_view()
        .ok_or(schema::FALLBACK_OPEN_FAILED)?;
    let fresh_fallback = probe::wait_fallback_loaded(app, harness, &fallback_view)
        .await
        .map_err(|_| schema::FALLBACK_PROBE_INVALID)?;
    let stage = record_fallback(
        app,
        harness,
        progress,
        "fallbackFresh",
        &fresh_fallback,
        None,
    )
    .await?;
    if !schema::stage_matches("fallbackFresh", &stage, original_launch_at_login) {
        return Err(schema::FALLBACK_PROBE_INVALID);
    }

    let saved = probe::fallback(app, harness, &fallback_view, "fallbackLoginSave")
        .await
        .map_err(|_| schema::FALLBACK_SAVE_FAILED)?;
    let placeholder_stored = storage::placeholder_saved(app, db.clone())
        .await
        .map_err(|_| schema::FALLBACK_SAVE_FAILED)?;
    let mut stage =
        record_fallback(app, harness, progress, "ordinarySave", &saved, Some(&saved)).await?;
    stage["actionSucceeded"] =
        Value::Bool(stage["actionSucceeded"].as_bool() == Some(true) && placeholder_stored);
    progress.set_stage("ordinarySave", stage.clone());
    if !schema::stage_matches("ordinarySave", &stage, original_launch_at_login) {
        return Err(schema::FALLBACK_SAVE_FAILED);
    }

    let externally_disabled = storage::set_native(app, true, false).await?;
    if externally_disabled != false || storage::read_native(app).await != Some(false) {
        return Err(schema::CONFLICT_INVALID);
    }
    let conflict = probe::fallback(app, harness, &fallback_view, "fallbackLoginConflict")
        .await
        .map_err(|_| schema::CONFLICT_INVALID)?;
    let stage = record_fallback(
        app,
        harness,
        progress,
        "conflict",
        &conflict,
        Some(&conflict),
    )
    .await?;
    if !schema::stage_matches("conflict", &stage, original_launch_at_login) {
        return Err(schema::CONFLICT_INVALID);
    }

    let reread = probe::fallback(app, harness, &fallback_view, "fallbackLoginReread")
        .await
        .map_err(|_| schema::REREAD_INVALID)?;
    let stage = record_fallback(app, harness, progress, "reread", &reread, Some(&reread)).await?;
    if !schema::stage_matches("reread", &stage, original_launch_at_login) {
        return Err(schema::REREAD_INVALID);
    }
    close_fallback(app, progress).await?;

    let previous_session = session.clone();
    let (fresh_vue, fresh_vue_session) = super::launch_at_login_journey::open_child(app, harness)
        .await
        .map_err(|_| schema::VUE_READBACK_INVALID)?;
    if fresh_vue_session == previous_session {
        return Err(schema::VUE_READBACK_INVALID);
    }
    *child = fresh_vue;
    *session = fresh_vue_session;
    let disabled_vue = probe::vue_inspect(app, harness, child)
        .await
        .map_err(|_| schema::VUE_READBACK_INVALID)?;
    if disabled_vue["uiEnabled"].as_bool() != Some(false)
        || disabled_vue["getterEnabled"].as_bool() != Some(false)
    {
        return Err(schema::VUE_READBACK_INVALID);
    }
    let restored_enabled = probe::vue_enable(app, harness, child)
        .await
        .map_err(|_| schema::VUE_ENABLE_FAILED)?;
    if restored_enabled["clickDispatched"].as_bool() != Some(true)
        || restored_enabled["uiEnabled"].as_bool() != Some(true)
        || restored_enabled["getterEnabled"].as_bool() != Some(true)
        || !restored_enabled["errorCode"].is_null()
        || storage::read_native(app).await != Some(true)
    {
        return Err(schema::VUE_ENABLE_FAILED);
    }
    let original = progress.original().ok_or(schema::RESTORE_FAILED)?;
    if !storage::coordinator_barrier(app).await {
        return Err(schema::COORDINATOR_TIMEOUT);
    }
    let (_, restored) = storage::restore(app, db, &original).await?;
    if !restored {
        return Err(schema::RESTORE_FAILED);
    }
    let mut final_stage = record_vue(
        app,
        harness,
        progress,
        "final",
        &restored_enabled,
        Some(&restored_enabled),
    )
    .await?;
    final_stage["unknownMarkerPreserved"] = Value::Null;
    if !schema::stage_matches("final", &final_stage, original_launch_at_login) {
        return Err(schema::RESTORE_FAILED);
    }
    progress.set_stage("final", final_stage);
    Ok(())
}

async fn record_vue(
    app: &AppHandle<Wry>,
    harness: &Harness,
    progress: &Progress,
    name: &str,
    evidence: &Value,
    action: Option<&Value>,
) -> Result<Value, &'static str> {
    let native = storage::read_native(app).await;
    let (database, marker) =
        storage::inspect(app, harness.database(), &harness.profile().run_id).await?;
    let mut stage = probe::vue_stage(evidence, action.is_some());
    stage["actionDispatched"] = action
        .and_then(|value| value["clickDispatched"].as_bool())
        .map(Value::Bool)
        .unwrap_or(Value::Null);
    stage["actionSucceeded"] = action.map_or(Value::Null, |value| {
        Value::Bool(
            value["clickDispatched"].as_bool() == Some(true)
                && value["uiEnabled"].as_bool() == Some(true)
                && value["getterEnabled"].as_bool() == Some(true)
                && value["errorCode"].is_null(),
        )
    });
    stage["nativeEnabled"] = fact(native);
    stage["databaseEnabled"] = fact(database);
    stage["unknownMarkerPreserved"] = Value::Bool(marker);
    progress.set_stage(name, stage.clone());
    Ok(stage)
}

async fn record_fallback(
    app: &AppHandle<Wry>,
    harness: &Harness,
    progress: &Progress,
    name: &str,
    evidence: &Value,
    action: Option<&Value>,
) -> Result<Value, &'static str> {
    let native = storage::read_native(app).await;
    let (database, marker) =
        storage::inspect(app, harness.database(), &harness.profile().run_id).await?;
    let mut stage = schema::stage_observation("fallback", action.or(Some(evidence)));
    stage["nativeEnabled"] = fact(native);
    stage["databaseEnabled"] = fact(database);
    stage["unknownMarkerPreserved"] = Value::Bool(marker);
    progress.set_stage(name, stage.clone());
    Ok(stage)
}

async fn close_fallback(app: &AppHandle<Wry>, progress: &Progress) -> Result<(), &'static str> {
    let Some(pair) = progress.take_fallback() else {
        return Err(schema::CLEANUP_FAILED);
    };
    let close_result = super::login_cross_entry_window::close(app, &pair.0).await;
    if let Err(error) = close_result {
        if let Some(code) = schema::fallback_close_error(error) {
            progress.error(code);
        }
    }
    if close_result.is_ok() && app.get_webview_window("settings").is_none() {
        return Ok(());
    }
    progress.put_fallback(pair);
    Err(schema::CLEANUP_FAILED)
}

fn fact(value: Option<bool>) -> Value {
    value.map(Value::Bool).unwrap_or(Value::Null)
}
