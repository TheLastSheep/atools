//! Exact private intent, capability and TaskRun binding checks.
use super::{dto::Request, manager, registry, store::Intent, SOURCE};
use atools_core::{agent::ToolDefinition, Database};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub(crate) fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    private_tool(db, client, name)?.map_or(Ok(()), |tool| {
        let request = Request::parse(args)?;
        validate_intent(app, db, &tool, &request).map(|_| ())
    })
}

pub(crate) fn bind_run(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args: &Value,
    run_id: &str,
) -> Result<(), String> {
    let Some(tool) = private_tool(db, "atools-ui", name)? else {
        return Ok(());
    };
    let request = Request::parse(args)?;
    validate_intent(app, db, &tool, &request)?.bind_run(run_id)
}

pub(super) fn intent_for(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<Option<Arc<Intent>>, String> {
    let Some(tool) = private_tool(db, client, name)? else {
        return Ok(None);
    };
    let request = Request::parse(args)?;
    validate_intent(app, db, &tool, &request).map(Some)
}

fn private_tool(db: &Database, client: &str, name: &str) -> Result<Option<ToolDefinition>, String> {
    let private_name = name.starts_with("atools.host.plugin-background.");
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE")?
    else {
        return if private_name {
            Err("ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE".into())
        } else {
            Ok(None)
        };
    };
    if tool.source != SOURCE {
        return if private_name {
            Err("ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE".into())
        } else {
            Ok(None)
        };
    }
    if client != "atools-ui" {
        return Err("ERR_PLUGIN_BACKGROUND_UI_REQUIRED".into());
    }
    registry::validate(&tool)?;
    Ok(Some(tool))
}

fn validate_intent(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    request: &Request,
) -> Result<Arc<Intent>, String> {
    let (plugin_id, access) = registry::validate(tool)?;
    if plugin_id != request.plugin_id || access.operation() != request.operation {
        return Err("ERR_PLUGIN_BACKGROUND_OWNER".into());
    }
    let intent = manager(app)?.intent(&request.request_id)?;
    if intent.window != "main"
        || intent.request != *request
        || intent.request.operation != access.operation()
        || intent.action.get("plugin_id").and_then(Value::as_str) != Some(&request.plugin_id)
        || intent.action.get("feature_code").and_then(Value::as_str) != Some("")
        || !intent.action.get("payload").is_some_and(Value::is_null)
    {
        return Err("ERR_PLUGIN_BACKGROUND_OWNER".into());
    }
    super::candidates::validate_current(
        db,
        &request.plugin_id,
        &request.code_revision,
        request.operation == super::dto::Operation::Start,
    )?;
    if app.get_webview_window(&intent.window).is_none() {
        return Err("ERR_PLUGIN_BACKGROUND_UI_REQUIRED".into());
    }
    if request.operation == super::dto::Operation::Stop {
        let admission = manager(app)?.admission(&intent.window, &request.session_id)?;
        if admission.request.plugin_id != request.plugin_id
            || admission.request.code_revision != request.code_revision
        {
            return Err("ERR_PLUGIN_BACKGROUND_OWNER".into());
        }
    }
    Ok(intent)
}
