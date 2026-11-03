use super::{
    channel_sink::ChannelSink,
    registry,
    types::{Mode, Request, RUN_LEASE},
};
use crate::ai_runtime::AiProviderConfig;
use atools_core::{
    ai_service::{AiErrorCode, AiOutputMode, AiServiceError},
    task_run::{TaskRunInitiatorType, TaskRunStatus},
    Database,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &atools_core::agent::ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
    execution: Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
) -> Result<Value, String> {
    super::privacy::validate_private_request(app, db, client, &tool.name, &args)?;
    let plugin = registry::validate(tool)?;
    let request_id = args["requestId"].as_str().ok_or("Missing AI request")?;
    let runtime = super::manager(app)?;
    let req = runtime.get(request_id)?;
    registry::validate_request_identity(&req, tool)?;
    if client != "atools-ui"
        || req.owner.plugin != plugin
        || req.run_id.lock().as_deref() != Some(run_id)
    {
        return Err("AI TaskRun does not match prepared request".into());
    }
    if execution.is_none() {
        return Err("Plugin AI requires plugin execution gate".into());
    }
    validate_current(db, &req, run_id)?;
    if *req.started.lock() {
        return Err("AI request execution already started".into());
    }
    let _permit = runtime
        .running
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Plugin AI is busy")?;
    {
        let store = runtime.store.lock();
        if store
            .requests
            .values()
            .filter(|r| {
                r.id != req.id
                    && r.owner.plugin == req.owner.plugin
                    && *r.started.lock()
                    && r.expires_result.lock().is_none()
            })
            .count()
            >= super::types::MAX_PER_PLUGIN
        {
            return Err("Plugin AI is busy".into());
        }
        if *req.started.lock() {
            return Err("AI request execution already started".into());
        }
        *req.started.lock() = true;
        *req.running_at.lock() = Some(std::time::Instant::now());
    }
    super::lifecycle::schedule_expiry(app, &runtime, &req, RUN_LEASE);
    let request = req
        .request
        .lock()
        .take()
        .ok_or("AI request payload already consumed")?;
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| "AI settings unavailable")?
        .ok_or("AI settings unavailable")?;
    let settings: Value = serde_json::from_str(&raw).map_err(|_| "AI settings unavailable")?;
    let config = AiProviderConfig::from_settings(&settings).map_err(safe_error)?;
    if config.default_model() != Some(req.model.as_str()) {
        return Err("AI model configuration changed".into());
    }
    let models = vec![atools_core::ai_service::AiModel {
        id: req.model.clone(),
        value: req.model.clone(),
        label: req.model.clone(),
    }];
    let transport = crate::ai_runtime::AiTransport::new(config).map_err(safe_error)?;
    let cancel = req.cancel.clone();
    let mode = if req.mode == Mode::Stream {
        AiOutputMode::Stream
    } else {
        AiOutputMode::Collect
    };
    let channel = req
        .channel
        .lock()
        .clone()
        .ok_or("AI stream channel unavailable")?;
    let mut sink = ChannelSink {
        request: req.clone(),
        channel,
        seq: 0,
        db: app.state::<crate::state::AppState>().db.clone(),
        run_id: run_id.into(),
    };
    let outcome = tokio::time::timeout(
        RUN_LEASE,
        transport.chat(&request, &models, mode, &cancel, &mut sink),
    )
    .await
    .map_err(|_| AiServiceError::new(AiErrorCode::Timeout))
    .and_then(|result| result);
    match outcome {
        Ok(outcome) => {
            validate_current(db, &req, run_id)?;
            let bytes = outcome.output_bytes;
            sink.terminal("succeeded", bytes, None)
                .await
                .map_err(safe_error)?;
            if let Some(message) = outcome.message {
                *req.output.lock() = Some(message);
            }
            *req.output_bytes.lock() = bytes;
            *req.expires_result.lock() =
                Some(std::time::Instant::now() + super::types::RESULT_LEASE);
            super::lifecycle::schedule_expiry(app, &runtime, &req, super::types::RESULT_LEASE);
            Ok(
                json!({"status":"completed","requestId":req.id,"model":req.model,"outputBytes":bytes,"deltaCount":*req.delta_count.lock()}),
            )
        }
        Err(error) => {
            *req.expires_result.lock() =
                Some(std::time::Instant::now() + super::types::RESULT_LEASE);
            super::lifecycle::schedule_expiry(app, &runtime, &req, super::types::RESULT_LEASE);
            let output_bytes = *req.output_bytes.lock();
            let _ = sink
                .terminal(
                    if error.code == AiErrorCode::Aborted {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    output_bytes,
                    Some(error.code),
                )
                .await;
            Err(safe_error(error))
        }
    }
}
pub(super) fn validate_current(
    db: &Database,
    request: &Request,
    run_id: &str,
) -> Result<(), String> {
    validate_binding_and_permission(db, request)?;
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "AI TaskRun unavailable")?
        .ok_or("AI TaskRun unavailable")?;
    if run.status != TaskRunStatus::Running {
        return Err("AI TaskRun identity changed".into());
    }
    validate_run_identity(request, &run)
}
pub(super) fn validate_completed(
    db: &Database,
    request: &Request,
    owner: &super::types::Owner,
) -> Result<(), String> {
    if &request.owner != owner {
        return Err("AI request owner changed".into());
    }
    validate_binding_and_permission(db, request)?;
    let run_id = request
        .run_id
        .lock()
        .clone()
        .ok_or("AI TaskRun unavailable")?;
    let run = db
        .get_task_run(&run_id)
        .map_err(|_| "AI TaskRun unavailable")?
        .ok_or("AI TaskRun unavailable")?;
    if run.status != TaskRunStatus::Succeeded {
        return Err("AI TaskRun has not succeeded".into());
    }
    validate_run_identity(request, &run)
}
fn validate_binding_and_permission(db: &Database, request: &Request) -> Result<(), String> {
    if !request.valid() {
        return Err("AI request expired or was cancelled".into());
    }
    request.binding.validate(db, &request.owner.plugin)?;
    let tool = db
        .get_agent_tool(&request.tool)
        .map_err(|_| "AI capability unavailable")?
        .ok_or("AI capability unavailable")?;
    registry::validate_request_identity(request, &tool)?;
    if !tool.enabled {
        return Err("AI capability disabled".into());
    }
    let permission =
        crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &request.tool)?;
    if permission == atools_core::agent::PermissionDecision::Deny
        || (request.permission_at_prepare == atools_core::agent::PermissionDecision::Allow
            && permission != atools_core::agent::PermissionDecision::Allow)
    {
        return Err("AI permission was revoked".into());
    }
    Ok(())
}
fn validate_run_identity(
    request: &Request,
    run: &atools_core::task_run::TaskRun,
) -> Result<(), String> {
    if request.run_id.lock().as_deref() != Some(run.id.as_str())
        || run.capability_id != request.tool
        || run.input != json!({"operation":"execute","requestId":request.id})
        || run.initiator.kind != TaskRunInitiatorType::Human
        || run.initiator.client_id.as_deref() != Some("atools-ui")
    {
        return Err("AI TaskRun identity changed".into());
    }
    Ok(())
}
pub(super) fn safe_error(error: impl std::fmt::Debug) -> String {
    format!("Plugin AI failed: {error:?}")
}
