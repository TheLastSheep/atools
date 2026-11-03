use super::evidence;
use crate::{
    plugin_display_runtime::{self as display, commands, registry},
    state::AppState,
};
use atools_core::{task_run::TaskRunStatus, Plugin};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;

pub(super) const HOST: &str = r#"<!doctype html><meta charset="utf-8"><title>Display fixture</title>
<script src="atools-display-smoke://localhost/probe.js"></script>"#;

fn check(value: bool, message: &'static str) -> Result<(), String> {
    if value {
        Ok(())
    } else {
        Err(message.into())
    }
}

async fn approve(app: &AppHandle, pending: &Value) -> Result<Value, String> {
    let db = &app.state::<AppState>().db;
    let id = pending["runId"].as_str().ok_or("Missing permission run")?;
    let run = db
        .get_task_run(id)
        .map_err(|_| "Permission run unavailable")?
        .ok_or("Permission run unavailable")?;
    check(
        run.status == TaskRunStatus::AwaitingPermission,
        "Expected synthetic permission request",
    )?;
    let result = crate::agent_tools::resume_tool_with_audit(
        app,
        db,
        "atools-ui",
        &run.capability_id,
        run.input.clone(),
        true,
        Some(id),
    )
    .await;
    check(
        !result.is_error && result.structured_content["runId"] == id,
        "Synthetic grant did not resume the original run",
    )?;
    crate::permission_requests::remove_for_run(app, id);
    let replay = crate::agent_tools::resume_tool_with_audit(
        app,
        db,
        "atools-ui",
        &run.capability_id,
        run.input,
        true,
        Some(id),
    )
    .await;
    check(
        replay.is_error,
        "Terminal synthetic grant replay was accepted",
    )?;
    Ok(result.structured_content)
}

async fn endpoint(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &str,
    instance: &str,
    opened: &Value,
) -> Result<String, String> {
    let value = commands::get_plugin_display_session(
        app.clone(),
        window.clone(),
        app.state(),
        plugin.into(),
        instance.into(),
        opened["sessionId"]
            .as_str()
            .ok_or("Missing display session")?
            .into(),
    )
    .await?;
    value["endpoint"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Display endpoint unavailable".into())
}

async fn post(endpoint: &str, origin: &str, payload: Value) -> Result<(u16, Value), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "HTTP client unavailable")?;
    let response = client
        .post(endpoint)
        .header("Origin", origin)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "Private display transport unavailable")?;
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(Value::Null);
    Ok((status, body))
}

pub(super) async fn run(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &Plugin,
    ready: oneshot::Receiver<()>,
    result: oneshot::Receiver<Value>,
) -> Result<Value, String> {
    run_inner(app, window, plugin, ready, result).await
}

async fn run_inner(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &Plugin,
    ready: oneshot::Receiver<()>,
    result: oneshot::Receiver<Value>,
) -> Result<Value, String> {
    ready
        .await
        .map_err(|_| "Wry display host did not become ready")?;
    let state = app.state::<AppState>();
    let db = &state.db;
    let runtime = display::manager(app)?;
    let instance = uuid::Uuid::new_v4().to_string();
    let owner = commands::window_owner(window.label(), &instance)?;

    let idle = commands::prepare(app, db, &owner, &plugin.id, false, None).await?;
    let no_idle_session = runtime.store.lock().sessions.is_empty();
    let no_idle_server = runtime.server.lock().await.is_none();
    check(
        idle["unavailable"] == true
            && no_idle_session
            && no_idle_server
            && db
                .list_task_runs(100)
                .map_err(|_| "Task history unavailable")?
                .is_empty(),
        "Unused plugin opened display authority",
    )?;

    let pending = commands::prepare(app, db, &owner, &plugin.id, true, None).await?;
    let no_pending_session = runtime.store.lock().sessions.is_empty();
    let no_pending_server = runtime.server.lock().await.is_none();
    check(
        pending["permission_required"] == true && no_pending_session && no_pending_server,
        "Display listener started before approval",
    )?;
    let opened = approve(app, &pending).await?;
    check(
        opened["sessionId"].is_string(),
        "Synthetic grant failed to open display session",
    )?;
    let active_endpoint = endpoint(app, window, &plugin.id, &instance, &opened).await?;
    let token = active_endpoint
        .rsplit('/')
        .next()
        .ok_or("Missing endpoint token")?
        .to_owned();

    let before_invalid = db
        .list_task_runs(1000)
        .map_err(|_| "Task history unavailable")?
        .len();
    let audits_before_invalid = db
        .list_audit_entries(1000)
        .map_err(|_| "Audit history unavailable")?
        .len();
    check(
        post(
            &active_endpoint,
            "https://untrusted.invalid",
            json!({"operation":"snapshot"}),
        )
        .await?
        .0 == 400,
        "Foreign Origin was accepted",
    )?;
    let invalid_endpoint = format!(
        "{}/{}",
        active_endpoint
            .rsplit_once('/')
            .ok_or("Invalid endpoint")?
            .0,
        "0".repeat(64)
    );
    check(
        post(&invalid_endpoint, "null", json!({"operation":"snapshot"}))
            .await?
            .0
            == 401,
        "Invalid display token was accepted",
    )?;
    let (payload_status, payload_result) = post(
        &active_endpoint,
        "null",
        json!({"operation":"snapshot","cursor":{"x":1,"y":2},"capture":true}),
    )
    .await?;
    check(
        payload_status == 200 && payload_result["ok"] == false,
        "Display payload fields outside the fixed operation were accepted",
    )?;
    check(
        db.list_task_runs(1000)
            .map_err(|_| "Task history unavailable")?
            .len()
            == before_invalid,
        "Rejected request entered TaskRun history",
    )?;
    check(
        db.list_audit_entries(1000)
            .map_err(|_| "Audit history unavailable")?
            .len()
            == audits_before_invalid,
        "Rejected request entered audit history",
    )?;

    window
        .eval(
            format!(
                "window.startNativeDisplayFixture({});",
                json!({"instanceId":instance,"endpoint":active_endpoint})
            )
            .as_str(),
        )
        .map_err(|_| "Could not start isolated display iframe")?;
    let frame = tokio::time::timeout(Duration::from_secs(55), result)
        .await
        .map_err(|_| "Display iframe deadline exceeded")?
        .map_err(|_| "Display iframe report channel closed")?;
    check(
        evidence::frame_report_is_safe(&frame),
        "Display frame report contained an unexpected field",
    )?;
    app.state::<evidence::FrameEvidence>().store(frame.clone());
    if frame["passed"] != true
        || frame["ungrantedThrowsWithoutTransport"] != true
        || frame["closeThrowsWithoutTransport"] != true
        || frame["identityConversion"] != true
        || frame["unsupportedConversions"] != true
    {
        return Ok(
            json!({"passed":false,"failure":"Serialized display bridge assertions failed","frame":frame}),
        );
    }
    let Some(calls) = frame["calls"].as_array() else {
        return Ok(json!({"passed":false,"failure":"Missing display call timings","frame":frame}));
    };
    if calls.len() != 20 {
        return Ok(
            json!({"passed":false,"failure":"Display bridge did not complete exactly twenty calls","frame":frame}),
        );
    }
    let snapshots: Vec<_> = db
        .list_task_runs(1000)
        .map_err(|_| "Task history unavailable")?
        .into_iter()
        .filter(|run| {
            run.capability_id == registry::tool_name(&plugin.id)
                && run.input["operation"] == "request"
        })
        .collect();
    check(
        snapshots.len() == 20 && snapshots.iter().all(|run| run.status.is_terminal()),
        "Native getter calls did not produce twenty terminal TaskRuns",
    )?;
    check(
        snapshots
            .iter()
            .all(evidence::snapshot_output_is_whitelisted),
        "TaskRun output included non-contract display data",
    )?;
    let audits = db
        .list_audit_entries(1000)
        .map_err(|_| "Audit history unavailable")?;
    let all_runs = db
        .list_task_runs(1000)
        .map_err(|_| "Task history unavailable")?;
    let history = format!(
        "{}{}",
        serde_json::to_string(&all_runs).unwrap_or_default(),
        serde_json::to_string(&audits).unwrap_or_default()
    );
    check(
        !history.contains(&active_endpoint) && !history.contains(&token),
        "Display endpoint credential entered durable history",
    )?;
    check(
        !history.contains("schemaVersion")
            && !history.contains("primaryId")
            && !history.contains("workArea")
            && !history.contains("scaleFactor"),
        "Raw display metadata entered durable history",
    )?;

    let next_instance = uuid::Uuid::new_v4().to_string();
    commands::rotate_plugin_display(
        app.clone(),
        window.clone(),
        app.state(),
        plugin.id.clone(),
        instance.clone(),
        next_instance.clone(),
        None,
    )
    .await?;
    let (old_status, _) = post(&active_endpoint, "null", json!({"operation":"snapshot"})).await?;
    check(old_status == 401, "Rotated display endpoint remained live")?;
    check(
        commands::get_plugin_display_session(
            app.clone(),
            window.clone(),
            app.state(),
            plugin.id.clone(),
            instance.clone(),
            opened["sessionId"].as_str().unwrap_or_default().into(),
        )
        .await
        .is_err(),
        "Previous session identifier published credentials after rotation",
    )?;
    let next_owner = commands::window_owner(window.label(), &next_instance)?;
    let successor = commands::prepare(app, db, &next_owner, &plugin.id, false, None).await?;
    check(
        successor["sessionId"].is_string() && successor["sessionId"] != opened["sessionId"],
        "Successor did not receive a fresh session",
    )?;
    let successor_endpoint = endpoint(app, window, &plugin.id, &next_instance, &successor).await?;
    check(
        successor_endpoint != active_endpoint,
        "Successor did not receive a fresh endpoint",
    )?;
    let successor_token = successor_endpoint
        .rsplit('/')
        .next()
        .ok_or("Missing endpoint token")?;
    commands::close_plugin_display(
        app.clone(),
        window.clone(),
        app.state(),
        plugin.id.clone(),
        instance.clone(),
    )
    .await?;
    let successor_closed = runtime.store.lock().sessions.is_empty();
    let successor_server_stopped = runtime.server.lock().await.is_none();
    check(
        successor_closed && successor_server_stopped,
        "Closing old owner did not close the rotated successor",
    )?;

    let disabled_instance = uuid::Uuid::new_v4().to_string();
    let disabled_owner = commands::window_owner(window.label(), &disabled_instance)?;
    let disabled_pending =
        commands::prepare(app, db, &disabled_owner, &plugin.id, true, None).await?;
    let disabled_opened = approve(app, &disabled_pending).await?;
    let disabled_endpoint = endpoint(
        app,
        window,
        &plugin.id,
        &disabled_instance,
        &disabled_opened,
    )
    .await?;
    let disabled_token = disabled_endpoint
        .rsplit('/')
        .next()
        .ok_or("Missing endpoint token")?;
    let before_disabled_runs = db
        .list_task_runs(1000)
        .map_err(|_| "Task history unavailable")?;
    let before_disabled_snapshots = evidence::successful_snapshot_count(&before_disabled_runs);
    db.set_agent_tool_enabled(&registry::tool_name(&plugin.id), false)
        .map_err(|_| "Could not disable fixture capability")?;
    let disabled_attempt = post(&disabled_endpoint, "null", json!({"operation":"snapshot"})).await;
    let disabled_rejected = match disabled_attempt {
        Ok((status, result)) => status != 200 || result["ok"] == false,
        Err(_) => true,
    };
    let disabled_runtime_drained =
        runtime.store.lock().sessions.is_empty() && runtime.server.lock().await.is_none();
    check(
        disabled_rejected && disabled_runtime_drained,
        "Disabled display endpoint was accepted",
    )?;
    let after_disabled_runs = db
        .list_task_runs(1000)
        .map_err(|_| "Task history unavailable")?;
    check(
        evidence::successful_snapshot_count(&after_disabled_runs) == before_disabled_snapshots,
        "Disabled display endpoint created a successful snapshot",
    )?;
    let final_history = format!(
        "{}{}",
        serde_json::to_string(
            &db.list_task_runs(1000)
                .map_err(|_| "Task history unavailable")?
        )
        .unwrap_or_default(),
        serde_json::to_string(
            &db.list_audit_entries(1000)
                .map_err(|_| "Audit history unavailable")?
        )
        .unwrap_or_default(),
    );
    check(
        !final_history.contains(&active_endpoint)
            && !final_history.contains(&token)
            && !final_history.contains(&successor_endpoint)
            && !final_history.contains(successor_token)
            && !final_history.contains(&disabled_endpoint)
            && !final_history.contains(disabled_token)
            && !final_history.contains("schemaVersion")
            && !final_history.contains("primaryId")
            && !final_history.contains("workArea")
            && !final_history.contains("scaleFactor"),
        "Display credentials or metadata entered durable history",
    )?;
    display::invalidate(app, db, Some(&plugin.id)).await;
    let runtime_state = display::runtime_state(app);
    check(
        runtime_state["displaySessions"] == 0
            && runtime_state["displayIntents"] == 0
            && runtime_state["displayInvocations"] == 0
            && runtime.server.lock().await.is_none(),
        "Display runtime did not drain",
    )?;
    let runs = db
        .list_task_runs(1000)
        .map_err(|_| "Task history unavailable")?;
    check(
        runs.iter().all(|run| run.status.is_terminal()),
        "Fixture left a non-terminal TaskRun",
    )?;
    let transport_stopped = runtime.server.lock().await.is_none();
    Ok(json!({
        "passed":true,
        "approval":"two-synthetic-one-time-resumes",
        "snapshotTaskRuns":snapshots.len(),
        "rejectedInputsCreatedRuns":false,
        "rotation":{"oldEndpointRejected":true,"successorPrepared":true,"oldOwnerClosedSuccessor":true},
        "disabledCapabilityRejected":true,"disabledRejection":"http-or-transport",
        "cleanup":{"sessions":runtime_state["displaySessions"],"intents":runtime_state["displayIntents"],"invocations":runtime_state["displayInvocations"],"transportStopped":transport_stopped,"taskRunsTerminal":true},
        "frame":frame
    }))
}
