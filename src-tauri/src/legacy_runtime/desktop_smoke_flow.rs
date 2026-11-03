use super::{page, Fixture};
use crate::legacy_runtime::{commands, Sessions};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;

fn check(value: bool, message: &str) -> Result<(), String> {
    if value {
        Ok(())
    } else {
        Err(message.into())
    }
}

async fn approve(
    app: &AppHandle,
    tool: &str,
    pending: &Value,
    remember: bool,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let id = pending
        .get("runId")
        .and_then(Value::as_str)
        .ok_or("Prepare returned no pending run")?;
    let original = state
        .db
        .get_task_run(id)
        .map_err(|_| "Cannot read pending run")?
        .ok_or("Pending run missing")?;
    check(
        original.status == atools_core::task_run::TaskRunStatus::AwaitingPermission,
        "Expected AwaitingPermission before grant",
    )?;
    if remember {
        state
            .db
            .grant_agent_tool("atools-ui", tool)
            .map_err(|_| "Cannot grant fixture tool")?;
    }
    let result = crate::agent_tools::resume_tool_with_audit(
        app,
        &state.db,
        "atools-ui",
        tool,
        original.input,
        true,
        Some(id),
    )
    .await;
    check(!result.is_error, "Authorized opening failed")?;
    check(
        result
            .structured_content
            .get("runId")
            .and_then(Value::as_str)
            == Some(id),
        "Approval did not resume original run",
    )?;
    crate::permission_requests::remove_for_run(app, id);
    Ok(result.structured_content)
}

pub(super) async fn run(
    app: &AppHandle,
    window: &WebviewWindow,
    fixture: &Fixture,
    ready: oneshot::Receiver<Value>,
    result: oneshot::Receiver<Value>,
) -> Result<Value, String> {
    ready
        .await
        .map_err(|_| "Native WebView did not report ready")?;
    let state = app.state::<AppState>();
    let runtime = app.state::<Arc<Sessions>>();
    let instance = uuid::Uuid::new_v4().to_string();
    let pending = commands::prepare_legacy_node(
        app.clone(),
        window.clone(),
        app.state(),
        fixture.plugin.id.clone(),
        instance.clone(),
        None,
        None,
    )
    .await?;
    check(
        pending.get("permission_required").and_then(Value::as_bool) == Some(true),
        "First open did not request permission",
    )?;
    check(
        runtime.sessions.read().is_empty()
            && runtime.openings.lock().is_empty()
            && runtime.server.lock().await.is_none(),
        "Node started before permission",
    )?;
    let tool = crate::legacy_runtime::registry::tool_name(&fixture.plugin.id);
    let before = state
        .db
        .list_task_runs(1000)
        .map_err(|_| "Cannot inspect runs")?
        .len();
    let raw = crate::agent_tools::call_tool_with_audit(
        app,
        &state.db,
        "atools-ui",
        &tool,
        json!({"operation":"request","method":"call","params":{"private":fixture.secret}}),
        true,
    )
    .await;
    check(
        raw.is_error
            && state
                .db
                .list_task_runs(1000)
                .map_err(|_| "Cannot inspect runs")?
                .len()
                == before,
        "Raw private arguments entered task history",
    )?;
    let raw_background = crate::commands::start_agent_tool_background(
        app,
        tool.clone(),
        json!({"operation":"request","method":"call","params":{"private":fixture.secret}}),
        "atools-ui".into(),
        true,
        None,
    );
    check(
        raw_background.is_err()
            && state
                .db
                .list_task_runs(1000)
                .map_err(|_| "Cannot inspect background runs")?
                .len()
                == before,
        "Raw background arguments entered Created history",
    )?;
    let open_started = Instant::now();
    let opened = approve(app, &tool, &pending, true).await?;
    let saved_open_ms = open_started.elapsed().as_secs_f64() * 1000.0;
    let session_id = opened
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("No authorized session")?
        .to_string();
    let metadata = commands::get_legacy_node_session(
        app.clone(),
        window.clone(),
        app.state(),
        session_id.clone(),
    )
    .await?;
    let endpoint = metadata
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or("No authorized transport")?
        .to_string();
    let id = pending["runId"].as_str().unwrap();
    let original = state
        .db
        .get_task_run(id)
        .map_err(|_| "Cannot read run")?
        .unwrap();
    let replay = crate::agent_tools::resume_tool_with_audit(
        app,
        &state.db,
        "atools-ui",
        &tool,
        original.input.clone(),
        true,
        Some(id),
    )
    .await;
    check(
        replay.is_error
            && runtime.sessions.read().len() == 1
            && runtime.sessions.read().contains_key(&session_id),
        "Replayed intent opened another session",
    )?;

    let html = page::frame(fixture, &endpoint);
    window
        .eval(format!(
            "document.getElementById('plugin').srcdoc={};",
            serde_json::to_string(&html).unwrap()
        ))
        .map_err(|_| "Cannot start opaque-frame business probe")?;
    let ui = tokio::time::timeout(Duration::from_secs(12), result)
        .await
        .map_err(|_| "Native frame business probe timed out")?
        .map_err(|_| "Native frame report channel closed")?;
    check(
        ui.get("ok").and_then(Value::as_bool) == Some(true),
        "Native frame business checks failed",
    )?;
    let runs = state
        .db
        .list_task_runs(1000)
        .map_err(|_| "Cannot inspect completed runs")?;
    let audits = state
        .db
        .list_audit_entries(1000)
        .map_err(|_| "Cannot inspect audit")?;
    let durable = serde_json::to_string(&json!({"runs":runs,"audits":audits})).unwrap();
    check(
        !durable.contains(&fixture.secret)
            && !durable.contains(&fixture.private_error)
            && !durable.contains(&endpoint)
            && !durable.contains("readFileSync")
            && !durable.contains("plugin/data.txt"),
        "Private transport data leaked into durable history",
    )?;
    check(
        runs.iter().any(|run| {
            run.id == id && run.status == atools_core::task_run::TaskRunStatus::Succeeded
        }),
        "Original approval run was overwritten",
    )?;

    crate::commands::revoke_agent_tool(app.clone(), app.state(), "atools-ui".into(), tool.clone())
        .await?;
    check(
        runtime.sessions.read().is_empty(),
        "Revocation did not close Node process",
    )?;
    check(
        commands::get_legacy_node_session(app.clone(), window.clone(), app.state(), session_id)
            .await
            .is_err(),
        "Revoked session metadata remained available",
    )?;
    let response = reqwest::Client::new()
        .post(&endpoint)
        .header("Origin", "null")
        .timeout(Duration::from_secs(2))
        .json(&json!({"method":"require","params":{"specifier":"node:fs"}}))
        .send()
        .await;
    check(
        response.is_err()
            || response
                .as_ref()
                .is_ok_and(|response| !response.status().is_success()),
        "Revoked HTTP capability still worked",
    )?;
    let next_instance = uuid::Uuid::new_v4().to_string();
    let next_pending = commands::prepare_legacy_node(
        app.clone(),
        window.clone(),
        app.state(),
        fixture.plugin.id.clone(),
        next_instance.clone(),
        None,
        None,
    )
    .await?;
    check(
        next_pending
            .get("permission_required")
            .and_then(Value::as_bool)
            == Some(true),
        "Revoked grant was silently reused",
    )?;
    let once_started = Instant::now();
    let next = approve(app, &tool, &next_pending, false).await?;
    let once_open_ms = once_started.elapsed().as_secs_f64() * 1000.0;
    check(
        !state
            .db
            .is_agent_tool_granted("atools-ui", &tool)
            .map_err(|_| "Cannot inspect one-time grant")?,
        "One-time approval unexpectedly saved a grant",
    )?;
    let next_id = next
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("Reauthorized session missing")?
        .to_string();
    let once_metadata = commands::get_legacy_node_session(
        app.clone(),
        window.clone(),
        app.state(),
        next_id.clone(),
    )
    .await?;
    let once_endpoint = once_metadata
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or("One-time transport missing")?;
    let once_rpc = reqwest::Client::new()
        .post(once_endpoint)
        .header("Origin", "null")
        .timeout(Duration::from_secs(2))
        .json(&json!({"method":"require","params":{"specifier":"node:path"}}))
        .send()
        .await
        .map_err(|_| "One-time HTTP request failed")?;
    check(
        once_rpc.status().is_success(),
        "One-time HTTP request was rejected",
    )?;
    let once_value: Value = once_rpc
        .json()
        .await
        .map_err(|_| "One-time response was invalid")?;
    check(
        once_value.get("ok").and_then(Value::as_bool) == Some(true),
        "One-time approved session could not execute a Node RPC",
    )?;
    crate::commands::toggle_plugin(app.clone(), app.state(), fixture.plugin.id.clone(), false)
        .await?;
    check(
        runtime.sessions.read().is_empty()
            && !state
                .db
                .get_plugin(&fixture.plugin.id)
                .map_err(|_| "Cannot inspect fixture")?
                .enabled,
        "Disable did not close Node process",
    )?;
    check(
        commands::get_legacy_node_session(app.clone(), window.clone(), app.state(), next_id)
            .await
            .is_err(),
        "Disabled session remained available",
    )?;
    commands::close_legacy_node(
        app.clone(),
        window.clone(),
        app.state(),
        fixture.plugin.id.clone(),
        next_instance,
    )
    .await?;
    let runs = state
        .db
        .list_task_runs(1000)
        .map_err(|_| "Cannot inspect final runs")?;
    let audits = state
        .db
        .list_audit_entries(1000)
        .map_err(|_| "Cannot inspect final audit")?;
    let final_history = serde_json::to_string(&json!({"runs":runs,"audits":audits})).unwrap();
    check(
        !final_history.contains(&fixture.secret)
            && !final_history.contains(&fixture.private_error)
            && !final_history.contains(&endpoint)
            && !final_history.contains(once_endpoint),
        "Final task history contains private transport data",
    )?;
    Ok(json!({
        "passed":true,
        "scope":"Real Tauri Wry AppState, temporary SQLite, actual prepare/get/close and revoke/disable commands, Rust BridgeServer, shared audited TaskRun pipeline, real Node process, opaque incognito WebView",
        "checks":{"noNodeBeforeGrant":true,"rawArgumentsRejectedBeforePersistence":true,"rawBackgroundArgumentsRejectedBeforeCreated":true,"approvalResumedOriginalRun":true,
            "replayDidNotOpenAnotherProcess":true,"durableHistoryContainsNoPrivateTransportData":true,"revokeClosedProcessAndEndpoint":true,"disableClosedProcess":true,"oneTimeApprovalWithoutSavedGrant":true},
        "nativeFrame":ui.get("checks"),"taskRuns":runs.len(),"auditEntries":audits.len(),
        "observations":{"savedGrantOpenMs":saved_open_ms,"oneTimeOpenMs":once_open_ms,"frameTimings":ui.get("timings"),"scope":"Single fixture samples; not a latency benchmark or budget acceptance"},
        "limitations":["Synthetic saved grant / one-time confirmation and direct original-run resume bypass approval UX", "Host commands invoked from Rust with actual window/state; JS Tauri IPC approval flow remains unmeasured", "Controlled smoke custom-protocol host and CSP; production navigation/CSP remain unmeasured", "Synthetic fs/crypto fixture, not full community-plugin acceptance", "V8 old-space limit does not establish a process RSS hard limit"]
    }))
}
