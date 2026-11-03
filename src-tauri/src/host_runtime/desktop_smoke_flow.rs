use crate::host_runtime::{
    self as host, commands,
    registry::{self, Access},
};
use crate::state::AppState;
use atools_core::{task_run::TaskRunStatus, Plugin};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;

fn check(value: bool, message: &str) -> Result<(), String> {
    if value {
        Ok(())
    } else {
        Err(message.into())
    }
}
async fn approve(app: &AppHandle, pending: &Value) -> Result<Value, String> {
    let db = &app.state::<AppState>().db;
    let id = pending["runId"].as_str().ok_or("Missing pending run")?;
    let run = db
        .get_task_run(id)
        .map_err(|e| e.to_string())?
        .ok_or("Missing run")?;
    check(
        run.status == TaskRunStatus::AwaitingPermission,
        "Expected pending permission",
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
        "Did not resume original run",
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
    check(replay.is_error, "Terminal approval replay was accepted")?;
    Ok(result.structured_content)
}
async fn config(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &str,
    instance: &str,
    opened: &Value,
) -> Result<Value, String> {
    commands::get_host_clipboard_session(
        app.clone(),
        window.clone(),
        app.state(),
        plugin.into(),
        instance.into(),
        opened["sessionId"]
            .as_str()
            .ok_or("Missing session")?
            .into(),
    )
    .await
}
async fn post(endpoint: &str, origin: Option<&str>, value: Value) -> Result<(u16, Value), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.post(endpoint).json(&value);
    if let Some(origin) = origin {
        request = request.header("Origin", origin);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Clipboard fixture HTTP failed")?;
    let status = response.status().as_u16();
    Ok((
        status,
        response.json().await.map_err(|_| "Invalid HTTP result")?,
    ))
}
pub(super) async fn run(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &Plugin,
    bridge: &str,
    native_clipboard: &host::clipboard::NamedClipboard,
    ready: oneshot::Receiver<()>,
    result: oneshot::Receiver<Value>,
) -> Result<Value, String> {
    ready.await.map_err(|_| "Wry host not ready")?;
    let state = app.state::<AppState>();
    let db = &state.db;
    let runtime = host::manager(app)?;
    let instance = uuid::Uuid::new_v4().to_string();
    let owner = commands::window_owner(window.label(), &instance)?;
    for access in [Access::Read, Access::Write] {
        check(
            commands::prepare(app, db, &owner, &plugin.id, access, false, None).await?
                ["unavailable"]
                == true,
            "Unrequested clipboard scope opened",
        )?;
    }
    check(
        db.list_task_runs(100).unwrap().is_empty()
            && db.list_agent_tools().unwrap().is_empty()
            && runtime.server.lock().await.is_none(),
        "Pure metadata caused clipboard side effects",
    )?;
    let pending = commands::prepare(app, db, &owner, &plugin.id, Access::Read, true, None).await?;
    check(
        pending["permission_required"] == true
            && runtime.server.lock().await.is_none()
            && runtime.store.lock().sessions.is_empty(),
        "Clipboard listener started before grant",
    )?;
    let private = format!("PRIVATE_CLIPBOARD_{}", uuid::Uuid::new_v4());
    let tool = registry::tool_name(&plugin.id, Access::Read);
    let count = db.list_task_runs(100).unwrap().len();
    let raw = json!({"operation":"request","text":private});
    check(
        crate::agent_tools::call_tool_with_audit(app, db, "atools-ui", &tool, raw.clone(), true)
            .await
            .is_error,
        "Raw text accepted",
    )?;
    check(
        crate::commands::start_agent_tool_background(
            app,
            tool.clone(),
            raw,
            "atools-ui".into(),
            true,
            None,
        )
        .is_err(),
        "Background raw text accepted",
    )?;
    check(
        db.list_task_runs(100).unwrap().len() == count,
        "Rejected raw text was persisted",
    )?;
    check(
        crate::agent_tools::call_tool_with_audit(
            app,
            db,
            "atools-ui",
            &tool,
            json!({"operation":"request","format":"files","path":private}),
            true,
        )
        .await
        .is_error
            && db.list_task_runs(100).unwrap().len() == count,
        "Raw file payload bypassed private invocation or entered TaskRun history",
    )?;
    let read = approve(app, &pending).await?;
    let read_config = config(app, window, &plugin.id, &instance, &read).await?;
    let read_endpoint = read_config["endpoint"].as_str().unwrap().to_string();
    check(
        post(&read_endpoint, Some("https://untrusted.example"), json!({}))
            .await?
            .0
            == 400,
        "Foreign origin accepted",
    )?;
    let invalid_token = format!(
        "{}/{}",
        read_endpoint.rsplit_once('/').unwrap().0,
        "0".repeat(64)
    );
    check(
        post(&invalid_token, Some("null"), json!({})).await?.0 == 401,
        "Unknown token accepted",
    )?;
    check(
        post(&read_endpoint, Some("null"), json!({"text":private}))
            .await?
            .1["ok"]
            == false,
        "Read authorization escalated to write",
    )?;
    let files = host::desktop_smoke_files_flow::run(
        native_clipboard,
        std::path::Path::new(&plugin.path)
            .parent()
            .ok_or("Missing private fixture parent")?,
        &read_endpoint,
        db,
    )
    .await?;
    let pending_write =
        commands::prepare(app, db, &owner, &plugin.id, Access::Write, true, None).await?;
    check(
        pending_write["permission_required"] == true,
        "Read grant silently granted write",
    )?;
    let write = approve(app, &pending_write).await?;
    let write_config = config(app, window, &plugin.id, &instance, &write).await?;
    let write_endpoint = write_config["endpoint"].as_str().unwrap().to_string();
    host::desktop_smoke_files_flow::reject_write(&write_endpoint).await?;
    let frame_config = json!({"instanceId":instance,"endpoints":{"read":read_endpoint,"write":write_endpoint},"privateText":private,"expectedFiles":files.expected});
    let html = format!(
        "<!doctype html><script>window.__nativeHostClipboardConfig={};</script><script>{}</script>",
        frame_config,
        bridge.replace("</script", "<\\/script")
    );
    window
        .eval(format!(
            "window.startHostFixture({});",
            serde_json::to_string(&html).unwrap()
        ))
        .map_err(|e| e.to_string())?;
    let native = result
        .await
        .map_err(|_| "Opaque clipboard frame did not report")?;
    check(
        native["passed"] == true,
        "Native clipboard frame checks failed",
    )?;
    for key in [
        "filesBeforeGrantThrowsWithoutReplay",
        "nativeFilesFixtureHasActualFileAndDirectory",
        "nativeCopiedFilesAreSynchronousExactMetadata",
        "copiedFileLegacyAliasMatchesCanonicalDirectory",
        "nativeCopiedFilesReturnFreshMetadata",
        "getCopyedFilesSerializedNativeExactFiles",
        "getCopiedFilesSerializedNativeExactFiles",
        "beforeGrantThrowsWithoutPayload",
        "actualMetadata",
        "syncWrite0",
        "syncWrite1",
        "syncWrite2",
        "syncWrite3",
        "exactNativeText0",
        "exactNativeText1",
        "exactNativeText2",
        "exactNativeText3",
        "readDoesNotGrantWrite",
        "uuidOriginalReturn",
        "subnetOriginalReturn",
        "uuid-kitOriginalNativeReadback",
        "subnet-calculatorOriginalNativeReadback",
    ] {
        check(
            native["checks"][key] == true,
            "Native clipboard frame omitted a required assertion",
        )?;
    }
    let originals = native["originalPlugins"]
        .as_array()
        .ok_or("Missing original clipboard checks")?;
    check(
        originals.len() == 2
            && ["uuid-kit", "subnet-calculator"].iter().all(|id| {
                originals
                    .iter()
                    .any(|value| value["id"] == *id && value["businessPassed"] == true)
            }),
        "Original clipboard integration assertions were not preserved",
    )?;
    let next = uuid::Uuid::new_v4().to_string();
    commands::rotate_host_clipboard(
        app.clone(),
        window.clone(),
        app.state(),
        plugin.id.clone(),
        instance.clone(),
        next.clone(),
        None,
    )
    .await?;
    check(
        post(&read_endpoint, Some("null"), json!({})).await?.0 == 401,
        "Rotated read token remained active",
    )?;
    check(
        post(&write_endpoint, Some("null"), json!({"text":private}))
            .await?
            .0
            == 401,
        "Rotated write token remained active",
    )?;
    host::desktop_smoke_files_flow::reject_closed(&read_endpoint).await?;
    let next_owner = commands::window_owner(window.label(), &next)?;
    let reopened =
        commands::prepare(app, db, &next_owner, &plugin.id, Access::Read, false, None).await?;
    let next_config = config(app, window, &plugin.id, &next, &reopened).await?;
    check(
        post(
            next_config["endpoint"].as_str().unwrap(),
            Some("null"),
            json!({}),
        )
        .await?
        .1["ok"]
            == true,
        "One-time authorization did not survive manual reopen",
    )?;
    commands::close_host_clipboard(
        app.clone(),
        window.clone(),
        app.state(),
        plugin.id.clone(),
        instance.clone(),
    )
    .await?;
    check(
        runtime.store.lock().sessions.is_empty() && runtime.server.lock().await.is_none(),
        "Late old-owner close leaked the successor or listener",
    )?;
    check(
        commands::rotate_host_clipboard(
            app.clone(),
            window.clone(),
            app.state(),
            plugin.id.clone(),
            instance,
            uuid::Uuid::new_v4().to_string(),
            None,
        )
        .await
        .is_err(),
        "Late rotation after close resurrected authorization",
    )?;
    // A pending approval loses to close, even if a stale UI attempts to approve.
    let cancelled_instance = uuid::Uuid::new_v4().to_string();
    let cancelled_owner = commands::window_owner(window.label(), &cancelled_instance)?;
    let cancelled = commands::prepare(
        app,
        db,
        &cancelled_owner,
        &plugin.id,
        Access::Read,
        true,
        None,
    )
    .await?;
    commands::close_host_clipboard(
        app.clone(),
        window.clone(),
        app.state(),
        plugin.id.clone(),
        cancelled_instance,
    )
    .await?;
    let cancelled_run = db
        .get_task_run(cancelled["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    check(
        cancelled_run.status == TaskRunStatus::Cancelled,
        "Close did not cancel pending authorization",
    )?;
    let stale = crate::agent_tools::resume_tool_with_audit(
        app,
        db,
        "atools-ui",
        &tool,
        cancelled_run.input,
        true,
        Some(&cancelled_run.id),
    )
    .await;
    check(
        stale.is_error && runtime.store.lock().sessions.is_empty(),
        "Stale approval opened a session",
    )?;
    // Denied capability cannot open; explicit revocation closes one-time sessions.
    db.set_agent_tool_enabled(&tool, false).unwrap();
    let denied_owner = commands::window_owner(window.label(), &uuid::Uuid::new_v4().to_string())?;
    let denied =
        commands::prepare(app, db, &denied_owner, &plugin.id, Access::Read, true, None).await?;
    check(
        denied.get("sessionId").is_none() && runtime.store.lock().sessions.is_empty(),
        "Disabled capability opened",
    )?;
    db.set_agent_tool_enabled(&tool, true).unwrap();
    let revoke_owner = commands::window_owner(window.label(), &uuid::Uuid::new_v4().to_string())?;
    let revoke = approve(
        app,
        &commands::prepare(app, db, &revoke_owner, &plugin.id, Access::Read, true, None).await?,
    )
    .await?;
    check(revoke["sessionId"].is_string(), "One-time session absent")?;
    let revoke_config = config(
        app,
        window,
        &plugin.id,
        revoke_owner.rsplit_once(':').unwrap().1,
        &revoke,
    )
    .await?;
    let revoke_endpoint = revoke_config["endpoint"].as_str().unwrap().to_string();
    let revoke_token = revoke_endpoint.rsplit('/').next().unwrap();
    host::invalidate(app, db, Some(&plugin.id)).await;
    check(
        runtime.store.lock().sessions.is_empty()
            && runtime.server.lock().await.is_none()
            && runtime.by_token(revoke_token).is_none()
            && runtime.store.lock().invocations.is_empty(),
        "Revocation did not close listener or drain private invocations",
    )?;
    let runs = db.list_task_runs(1000).unwrap();
    let durable = format!(
        "{}{}",
        serde_json::to_string(&runs).unwrap(),
        serde_json::to_string(&db.list_audit_entries(1000).unwrap()).unwrap()
    );
    for forbidden in files.forbidden.iter().map(String::as_str).chain([
        &private,
        &read_endpoint,
        &write_endpoint,
        "\"text\":",
        "/host/",
    ]) {
        let escaped = serde_json::to_string(forbidden).unwrap();
        check(
            !durable.contains(forbidden) && !durable.contains(&escaped[1..escaped.len() - 1]),
            "Private clipboard payload leaked to durable history",
        )?;
    }
    Ok(
        json!({"passed":true,"checks":{"metadataZeroAuthorizationAndListener":true,"scopeOnlyPending":true,"rawTextRejectedBeforePersist":true,"sameRunApprovalReplayRejected":true,"directionsIndependentlyGranted":true,"unknownOriginAndTokenRejected":true,"nativeExactValues":true,"manualReopenRotatesToken":true,"lateOldCloseCancelsSuccessor":true,"closeWinsPendingApproval":true,"deniedScopeBlocked":true,"revocationStopsLastListener":true,"durableHistoryContainsNoTextOrEndpoint":true,"durableHistoryContainsNoTextFilesOrEndpoint":true,"privateInvocationStoreDrained":true,"fileReadScopeAndWriteIsolation":true},"nativeFiles":files.checks,"nativeFrame":native,"taskRunCount":runs.len(),"scope":"Wry opaque frame + production Rust HTTP/gate + isolated named native macOS pasteboard; synthetic approval bypasses dialog; never accesses general clipboard"}),
    )
}
