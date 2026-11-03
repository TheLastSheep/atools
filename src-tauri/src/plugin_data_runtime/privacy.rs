//! Durable arguments contain only validated generation-bound metadata tickets.
use atools_core::Database;
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
        .map_err(|_| "Data capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::registry::SOURCE {
        return Ok(());
    }
    let plugin = super::registry::validate(&tool)?;
    if client != "atools-ui" {
        return Err("Plugin data requires an active private host ticket".into());
    }
    let runtime = super::manager(app)?;
    validate(&runtime, plugin, name, args)
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
        .map_err(|_| "Data capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::registry::SOURCE {
        return Ok(());
    }
    let runtime = super::manager(app)?;
    let store = runtime.store.lock();
    let slot = match args["operation"].as_str() {
        Some("open") => {
            &store
                .intents
                .get(args["intentId"].as_str().ok_or("Missing data intent")?)
                .ok_or("Data authorization closed")?
                .run
        }
        Some("request") => {
            &store
                .invocations
                .get(args["invocationId"].as_str().ok_or("Missing data ticket")?)
                .ok_or("Data invocation closed")?
                .run
        }
        _ => return Err("Unsupported data metadata".into()),
    };
    *slot.lock() = Some(run.into());
    Ok(())
}
pub(super) fn validate(
    runtime: &super::Sessions,
    plugin: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    let fields = args.as_object().ok_or("Invalid data metadata")?;
    let operation = args
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Missing data operation")?;
    let allowed: &[&str] = match operation {
        "open" => &["operation", "intentId"],
        "request" => &["operation", "sessionId", "invocationId", "method"],
        _ => return Err("Unsupported data operation".into()),
    };
    if fields.len() != allowed.len() || fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Private data payloads cannot enter durable task history".into());
    }
    let store = runtime.store.lock();
    if operation == "open" {
        let intent = store
            .intents
            .get(args["intentId"].as_str().ok_or("Missing data intent")?)
            .ok_or("Data authorization expired")?;
        if intent.document.as_ref().is_some_and(|d| !d.is_active())
            || intent.owner.plugin != plugin
            || name != super::registry::tool_name(plugin)
        {
            return Err("Data intent identity mismatch".into());
        }
    } else {
        let invocation = store
            .invocations
            .get(args["invocationId"].as_str().ok_or("Missing data ticket")?)
            .ok_or("Data invocation expired")?;
        let session = store
            .sessions
            .get(&invocation.session)
            .ok_or("Data session closed")?;
        if session.document.as_ref().is_some_and(|d| !d.is_active())
            || session.owner.plugin != plugin
            || session.tool != name
            || args["sessionId"] != session.id
            || args["method"] != invocation.request["method"]
        {
            return Err("Data invocation identity mismatch".into());
        }
    }
    Ok(())
}
