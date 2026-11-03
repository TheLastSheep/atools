//! Main-window commands for trusted discovery and one-shot background dispatch.
use super::{
    candidates,
    dto::{Operation, Outcome, Request},
    lifecycle, manager, registry,
    store::Intent,
};
use crate::state::AppState;
use atools_core::{db::Database, task_run::TaskRunStatus};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, WebviewWindow};

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("ERR_PLUGIN_BACKGROUND_UI_REQUIRED".into())
    }
}

fn parse_uuid(value: &str) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(value).map_err(|_| "ERR_PLUGIN_BACKGROUND_INPUT")?;
    if id.to_string() != value {
        return Err("ERR_PLUGIN_BACKGROUND_INPUT".into());
    }
    Ok(())
}

fn arm_expiry(app: &AppHandle, db: &Database, intent: Arc<Intent>) {
    let app = app.clone();
    let db = db.clone();
    tauri::async_runtime::spawn(async move { lifecycle::expire_after(app, db, intent).await });
}

struct CommandLease {
    app: AppHandle,
    db: Arc<Database>,
    intent: Arc<Intent>,
    retain: bool,
}

impl Drop for CommandLease {
    fn drop(&mut self) {
        if !self.retain {
            lifecycle::close_intent(&self.app, &self.db, &self.intent, true);
        }
    }
}

#[tauri::command]
pub(crate) async fn list_plugin_background_candidates(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<candidates::Candidate>, String> {
    require_main(&window)?;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || candidates::list(&db))
        .await
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_UNAVAILABLE")?
}

#[tauri::command]
pub(crate) async fn run_plugin_background(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    request_id: String,
    session_id: String,
    plugin_id: String,
    code_revision: String,
    operation: String,
) -> Result<Value, String> {
    require_main(&window)?;
    let operation = match operation.as_str() {
        "start" => Operation::Start,
        "stop" => Operation::Stop,
        _ => return Err("ERR_PLUGIN_BACKGROUND_INPUT".into()),
    };
    let request = Request {
        request_id,
        session_id,
        plugin_id,
        code_revision,
        operation,
    };
    request.validate()?;
    let runtime = manager(&app)?;
    let action = match operation {
        Operation::Start => {
            let plugin = candidates::validate_current(
                &state.db,
                &request.plugin_id,
                &request.code_revision,
                true,
            )?;
            serde_json::to_value(candidates::boot_action(&plugin))
                .map_err(|_| "ERR_PLUGIN_BACKGROUND_INPUT")?
        }
        Operation::Stop => {
            let admission = runtime.admission("main", &request.session_id)?;
            if admission.request.plugin_id != request.plugin_id
                || admission.request.code_revision != request.code_revision
            {
                return Err("ERR_PLUGIN_BACKGROUND_OWNER".into());
            }
            admission.action
        }
    };
    let intent = runtime.begin("main", request.clone(), action)?;
    arm_expiry(&app, &state.db, intent.clone());
    let mut lease = CommandLease {
        app: app.clone(),
        db: state.db.clone(),
        intent: intent.clone(),
        retain: false,
    };

    let plugin = candidates::validate_current(
        &state.db,
        &request.plugin_id,
        &request.code_revision,
        operation == Operation::Start,
    )?;
    let names = registry::ensure_tools(&state.db, &plugin)?;
    let tool = names[if operation == Operation::Start { 0 } else { 1 }].clone();
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &state.db,
        "atools-ui",
        &tool,
        request.to_value(),
        operation == Operation::Stop,
    )
    .await;
    let mut reply = result.structured_content;
    let run_id = reply
        .get("runId")
        .and_then(Value::as_str)
        .ok_or("ERR_PLUGIN_BACKGROUND_TASK_UNAVAILABLE")?
        .to_string();
    let status = reply
        .get("status")
        .and_then(Value::as_str)
        .ok_or("ERR_PLUGIN_BACKGROUND_TASK_UNAVAILABLE")?
        .to_string();
    lease.retain = matches!(
        status.as_str(),
        "created" | "awaiting_permission" | "running" | "succeeded"
    );
    let object = reply
        .as_object_mut()
        .ok_or("ERR_PLUGIN_BACKGROUND_TASK_UNAVAILABLE")?;
    object.insert("tool".into(), Value::String(tool));
    object.insert("runId".into(), Value::String(run_id));
    if status == TaskRunStatus::AwaitingPermission.as_str() {
        object.insert("permission_required".into(), Value::Bool(true));
    }
    Ok(reply)
}

#[tauri::command]
pub(crate) fn complete_plugin_background(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    ticket: String,
    session_id: String,
    outcome: String,
) -> Result<(), String> {
    require_main(&window)?;
    parse_uuid(&request_id)?;
    parse_uuid(&ticket)?;
    parse_uuid(&session_id)?;
    let intent = manager(&app)?.intent(&request_id)?;
    let outcome = Outcome::parse(&outcome)?;
    manager(&app)?.complete(
        &intent,
        super::dto::Receipt {
            request_id,
            ticket,
            session_id,
            outcome,
        },
    )
}

#[tauri::command]
pub(crate) fn set_plugin_background_waiting(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    ticket: String,
    waiting: bool,
) -> Result<(), String> {
    require_main(&window)?;
    parse_uuid(&request_id)?;
    parse_uuid(&ticket)?;
    manager(&app)?
        .intent(&request_id)?
        .waiting(window.label(), &ticket, waiting)
}

#[tauri::command]
pub(crate) fn cancel_plugin_background(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    require_main(&window)?;
    parse_uuid(&request_id)?;
    lifecycle::cancel_request(&app, &state.db, &request_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn verify_plugin_background_session(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    session_id: String,
    plugin_id: String,
    code_revision: String,
) -> Result<Value, String> {
    require_main(&window)?;
    parse_uuid(&session_id)?;
    if plugin_id.trim().is_empty()
        || plugin_id.len() > 256
        || plugin_id.trim() != plugin_id
        || plugin_id.chars().any(char::is_control)
        || code_revision.len() != 64
        || !code_revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("ERR_PLUGIN_BACKGROUND_INPUT".into());
    }
    let runtime = manager(&app)?;
    let admission = match runtime.admission("main", &session_id) {
        Ok(admission) => admission,
        Err(_) => return Ok(json!({"valid":false})),
    };
    if admission.request.plugin_id != plugin_id || admission.request.code_revision != code_revision
    {
        return Err("ERR_PLUGIN_BACKGROUND_OWNER".into());
    }
    let Some(run) = state
        .db
        .get_task_run(&admission.run_id)
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_TASK_UNAVAILABLE")?
    else {
        return Ok(json!({"valid":false}));
    };
    if run.status != TaskRunStatus::Succeeded
        || !lifecycle::successful_admission(&app, &run, &admission.request)
        || candidates::validate_current(&state.db, &plugin_id, &code_revision, true).is_err()
    {
        return Ok(json!({"valid":false}));
    }
    let tool = registry::tool_name(&plugin_id, registry::Access::Start);
    if crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &tool)?
        == atools_core::agent::PermissionDecision::Deny
    {
        return Ok(json!({"valid":false}));
    }
    Ok(json!({"valid":true}))
}

#[tauri::command]
pub(crate) async fn close_plugin_background_session(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    require_main(&window)?;
    parse_uuid(&session_id)?;
    lifecycle::close_session(&app, &state.db, "main", &session_id, true).await
}
