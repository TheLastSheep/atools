use atools_core::{agent::ToolDefinition, Database};
use serde_json::Value;
use tauri::AppHandle;

pub(crate) fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "AI capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::types::SOURCE {
        return Ok(());
    }
    let plugin = super::registry::validate(&tool)?;
    if client != "atools-ui" {
        return Err("Plugin AI requires an active private request".into());
    }
    let fields = args.as_object().ok_or("Invalid AI TaskRun input")?;
    if fields.len() != 2 || args["operation"] != "execute" {
        return Err("AI prompts cannot enter durable TaskRun input".into());
    }
    let request_id = args["requestId"].as_str().ok_or("Missing AI request")?;
    let runtime = super::manager(app)?;
    let req = runtime.get(request_id)?;
    if req.owner.plugin != plugin || req.tool != name || !runtime.is_current(&req) {
        return Err("AI request identity changed".into());
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
        .map_err(|_| "AI capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::types::SOURCE {
        return Ok(());
    }
    validate_private_request(app, db, "atools-ui", name, args)?;
    let req = super::manager(app)?.get(args["requestId"].as_str().ok_or("Missing AI request")?)?;
    let mut slot = req.run_id.lock();
    if slot.as_deref().is_some_and(|old| old != run) {
        return Err("AI request already belongs to another TaskRun".into());
    }
    *slot = Some(run.into());
    Ok(())
}
pub(crate) fn validate_tool(tool: &ToolDefinition) -> Result<&str, String> {
    super::registry::validate(tool)
}
