use super::{
    binary, lifecycle, manager, read, registry,
    types::{Binding, Owner, Request, LEASE},
};
use crate::plugin_page_runtime::resolve_binding;
use atools_core::{
    agent::PermissionDecision,
    task_run::{TaskRunInitiatorType, TaskRunStatus},
    Database,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub(crate) async fn prepare_plugin_file_drop(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    intent_id: String,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
) -> Result<Value, String> {
    if window.label() != "main" || !super::supported() {
        return Err("ERR_ATOOLS_FILE_DROP_UNSUPPORTED_PLATFORM".into());
    }
    if frame_generation == 0
        || frame_generation > 9_007_199_254_740_991
        || document_nonce.is_empty()
        || document_nonce.len() > 256
        || document_nonce.chars().any(char::is_control)
    {
        return Err("Invalid file-drop document identity".into());
    }
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let runtime = manager(&app)?;
    let selection = super::claim_selection(&runtime, &intent_id, window.label())?;
    let document = resolve_binding(
        &app,
        window.label(),
        &plugin_id,
        page_document_id.as_deref(),
    )?;
    if document.as_ref().map(|d| d.id()) != page_document_id.as_deref() {
        return Err("File-drop document identity mismatch".into());
    }
    let state = app.state::<crate::state::AppState>();
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(&state.db, &plugin)?;
    let tool = registry::ensure_tool(&state.db, &plugin)?;
    let permission =
        crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &tool)?;
    if selection.created.elapsed() >= LEASE
        || !selection.valid
        || selection.paths.len() != selection.file_count
    {
        return Err("Native drop selection is unavailable".into());
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = Arc::new(Request {
        id: request_id.clone(),
        selection_id: selection.id,
        owner,
        binding,
        document,
        generation: frame_generation,
        nonce: document_nonce,
        tool: tool.clone(),
        permission_at_prepare: permission,
        created: selection.created,
        run_id: parking_lot::Mutex::new(None),
        read_started: parking_lot::Mutex::new(false),
        payload: parking_lot::Mutex::new(None),
        selection: parking_lot::Mutex::new(Some(selection.paths)),
    });
    super::insert_request(&runtime, request.clone())?;
    let remaining = LEASE.saturating_sub(request.created.elapsed());
    let timer_app = app.clone();
    let timer_id = request_id.clone();
    let timer = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(remaining).await;
        lifecycle::expire_request(&timer_app, &timer_id);
    });
    super::register_request_timer(&runtime, &request_id, timer);
    let args = json!({"operation":"read","requestId":request_id});
    let result =
        crate::agent_tools::call_tool_with_audit(&app, &state.db, "atools-ui", &tool, args, false)
            .await;
    let mut value = result.structured_content;
    if result.is_error && value.get("permission_required") != Some(&Value::Bool(true)) {
        if let Some(removed) = super::remove_request(&runtime, &request_id) {
            if let Some(run) = removed.run_id.lock().clone() {
                lifecycle::cancel_run(&app, &state.db, &run);
            }
        }
        value["requestId"] = json!(request_id);
        value["tool"] = json!(tool);
        return Ok(value);
    }
    if !result.is_error {
        let run_id = value
            .get("runId")
            .and_then(Value::as_str)
            .ok_or("File-drop TaskRun result is incomplete")?;
        if request.run_id.lock().as_deref() != Some(run_id) {
            return Err("File-drop TaskRun binding changed".into());
        }
        validate_completed_run(&state.db, run_id, &tool, &request_id)?;
        if request.payload.lock().is_none() {
            return Err("File-drop read completed without a private payload".into());
        }
    }
    value["requestId"] = json!(request_id);
    value["tool"] = json!(tool);
    Ok(value)
}

#[tauri::command]
pub(crate) async fn get_plugin_file_drop_delivery(
    app: AppHandle,
    window: WebviewWindow,
    ipc_request: tauri::ipc::Request<'_>,
    plugin_id: String,
    instance_id: String,
    request_id: String,
) -> Result<tauri::ipc::Response, String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let runtime = manager(&app)?;
    let request = super::request(&runtime, &request_id)?;
    if request.owner != owner || !super::is_current(&runtime, &request) {
        return Err("File-drop owner or document changed".into());
    }
    let state = app.state::<crate::state::AppState>();
    validate_current(&state.db, &request)?;
    if !has_binary_response_callbacks(&ipc_request) {
        return Err("Binary file-drop transport is unavailable".into());
    }
    let run_id = request
        .run_id
        .lock()
        .clone()
        .ok_or("File-drop read TaskRun unavailable")?;
    validate_completed_run(&state.db, &run_id, &request.tool, &request.id)?;
    let mut store = runtime.store.lock();
    let current = store
        .requests
        .get(&request_id)
        .ok_or("File-drop request expired")?;
    if !Arc::ptr_eq(current, &request) || !request.valid() {
        return Err("File-drop request changed or expired".into());
    }
    validate_current(&state.db, &request)?;
    validate_completed_run(&state.db, &run_id, &request.tool, &request.id)?;
    let payload = request
        .payload
        .lock()
        .take()
        .ok_or("File-drop delivery already consumed")?;
    store.requests.remove(&request_id);
    if let Some(timer) = store.request_timers.remove(&request_id) {
        timer.abort();
    }
    Ok(tauri::ipc::Response::new(payload))
}

#[tauri::command]
pub(crate) async fn close_plugin_file_drop(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    super::close_owner(&app, &owner);
    Ok(())
}

#[tauri::command]
pub(crate) fn discard_plugin_file_drop_intent(
    app: AppHandle,
    window: WebviewWindow,
    intent_id: String,
) -> Result<bool, String> {
    super::discard(&app, window.label(), &intent_id)
}

pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &atools_core::agent::ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
) -> Result<Value, String> {
    validate_private_request(app, db, client, &tool.name, &args)?;
    let plugin = registry::validate(tool)?;
    let request_id = args["requestId"]
        .as_str()
        .ok_or("Missing file-drop request")?;
    let runtime = manager(app)?;
    let request = super::request(&runtime, request_id)?;
    registry::validate_request_identity(&request, tool)?;
    if request.owner.plugin != plugin || request.run_id.lock().as_deref() != Some(run_id) {
        return Err("File-drop TaskRun does not match request".into());
    }
    validate_current(db, &request)?;
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "File-drop TaskRun unavailable")?
        .ok_or("File-drop TaskRun unavailable")?;
    if run.status != TaskRunStatus::Running
        || run.capability_id != tool.name
        || run.input != json!({"operation":"read","requestId":request_id})
        || run.initiator.kind != TaskRunInitiatorType::Human
        || run.initiator.client_id.as_deref() != Some("atools-ui")
    {
        return Err("File-drop TaskRun identity mismatch".into());
    }
    let permit = runtime.read_permit()?;
    {
        let mut started = request.read_started.lock();
        if *started {
            return Err("File-drop read already started".into());
        }
        *started = true;
    }
    let paths = request
        .selection
        .lock()
        .take()
        .ok_or("File-drop selection already consumed")?;
    let db_after = app.state::<crate::state::AppState>().db.clone();
    let closure_db = db_after.clone();
    let rt = runtime.clone();
    let req = request.clone();
    let read_run_id = run_id.to_owned();
    let checked_run = read_run_id.clone();
    let (files, raw) = tauri::async_runtime::spawn_blocking(move || {
        let _read_permit = permit;
        read::read_paths(paths, || {
            if !super::is_current(&rt, &req) {
                return Err("FILE_DROP_CANCELLED".into());
            }
            validate_current(&closure_db, &req)?;
            validate_running_run(&closure_db, &req, &checked_run)
        })
    })
    .await
    .map_err(|_| "FILE_DROP_WORKER")??;
    let bytes = raw.len();
    let packet = binary::pack(
        &request.id,
        &request.selection_id,
        read::expires_at_ms(request.created),
        &files,
        &raw,
    )?;
    {
        let store = runtime.store.lock();
        let current = store
            .requests
            .get(&request.id)
            .ok_or("File-drop request closed before read completion")?;
        if !Arc::ptr_eq(current, &request) || !request.valid() {
            return Err("File-drop request changed before read completion".into());
        }
        validate_current(&db_after, &request)?;
        validate_running_run(&db_after, &request, &read_run_id)?;
        *request.payload.lock() = Some(packet);
    }
    Ok(
        json!({"requestId":request.id,"readCompleted":true,"fileCount":files.len(),"totalBytes":bytes,"runtime":"plugin-file-drop"}),
    )
}

pub(crate) fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "File-drop capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::types::SOURCE {
        return Ok(());
    }
    let plugin = registry::validate(&tool)?;
    if client != "atools-ui" {
        return Err("Native file-drop requires an active private host request".into());
    }
    let fields = args.as_object().ok_or("Invalid file-drop TaskRun input")?;
    if fields.len() != 2 || args["operation"] != "read" {
        return Err("File-drop TaskRun input is not private".into());
    }
    let runtime = manager(app)?;
    let request = super::request(
        &runtime,
        args["requestId"]
            .as_str()
            .ok_or("Missing file-drop request")?,
    )?;
    if request.owner.plugin != plugin
        || request.tool != name
        || !super::is_current(&runtime, &request)
    {
        return Err("File-drop request identity mismatch".into());
    }
    Ok(())
}

pub(crate) fn bind_run(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args: &Value,
    run: &str,
) -> Result<(), String> {
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "File-drop capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::types::SOURCE {
        return Ok(());
    }
    validate_private_request(app, db, "atools-ui", name, args)?;
    let runtime = manager(app)?;
    let request = super::request(
        &runtime,
        args["requestId"]
            .as_str()
            .ok_or("Missing file-drop request")?,
    )?;
    let mut bound = request.run_id.lock();
    if bound.as_deref().is_some_and(|existing| existing != run) {
        return Err("File-drop request already belongs to another TaskRun".into());
    }
    *bound = Some(run.into());
    Ok(())
}

fn validate_current(db: &Database, request: &Request) -> Result<(), String> {
    if !request.valid() || request.generation == 0 || request.nonce.is_empty() {
        return Err("File-drop document lease expired".into());
    }
    request.binding.validate(db, &request.owner.plugin)?;
    let tool = db
        .get_agent_tool(&request.tool)
        .map_err(|_| "File-drop capability unavailable")?
        .ok_or("File-drop capability unavailable")?;
    registry::validate_request_identity(request, &tool)?;
    if !tool.enabled {
        return Err("File-drop capability disabled".into());
    }
    let decision =
        crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &request.tool)?;
    if decision == PermissionDecision::Deny
        || (request.permission_at_prepare == PermissionDecision::Allow
            && decision != PermissionDecision::Allow)
    {
        return Err("File-drop permission was revoked".into());
    }
    Ok(())
}
fn validate_completed_run(
    db: &Database,
    run_id: &str,
    tool: &str,
    request_id: &str,
) -> Result<(), String> {
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "File-drop TaskRun unavailable")?
        .ok_or("File-drop TaskRun unavailable")?;
    if run.status != TaskRunStatus::Succeeded
        || run.capability_id != tool
        || run.initiator.kind != TaskRunInitiatorType::Human
        || run.initiator.client_id.as_deref() != Some("atools-ui")
        || run.input != json!({"operation":"read","requestId":request_id})
        || run.output.get("requestId").and_then(Value::as_str) != Some(request_id)
        || run.output.get("readCompleted") != Some(&Value::Bool(true))
        || run
            .output
            .get("fileCount")
            .and_then(Value::as_u64)
            .is_none_or(|n| n == 0 || n > 16)
        || run
            .output
            .get("totalBytes")
            .and_then(Value::as_u64)
            .is_none_or(|n| n > 8 * 1024 * 1024)
        || run.output.get("runtime").and_then(Value::as_str) != Some("plugin-file-drop")
        || run.output.as_object().is_none_or(|output| {
            output.len() != 5
                || ![
                    "requestId",
                    "readCompleted",
                    "fileCount",
                    "totalBytes",
                    "runtime",
                ]
                .iter()
                .all(|key| output.contains_key(*key))
        })
    {
        return Err("File-drop read has no matching successful TaskRun".into());
    }
    Ok(())
}
fn validate_running_run(db: &Database, request: &Request, run_id: &str) -> Result<(), String> {
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "File-drop TaskRun unavailable")?
        .ok_or("File-drop TaskRun unavailable")?;
    if run.status != TaskRunStatus::Running
        || run.capability_id != request.tool
        || run.initiator.kind != TaskRunInitiatorType::Human
        || run.initiator.client_id.as_deref() != Some("atools-ui")
        || run.input != json!({"operation":"read","requestId":request.id})
    {
        return Err("File-drop TaskRun was cancelled or changed".into());
    }
    Ok(())
}

fn has_binary_response_callbacks(request: &tauri::ipc::Request<'_>) -> bool {
    ["Tauri-Callback", "Tauri-Error"].iter().all(|name| {
        request
            .headers()
            .get(*name)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.parse::<u32>().is_ok())
    })
}
