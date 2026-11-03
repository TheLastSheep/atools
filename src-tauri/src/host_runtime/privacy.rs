//! Only ephemeral, identity-bound tickets may enter the durable execution path.
use atools_core::db::Database;
use serde_json::Value;
use tauri::AppHandle;

pub fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    let Some(tool) = db.get_agent_tool(name).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if tool.source != super::registry::SOURCE {
        return Ok(());
    }
    let access = super::registry::access_for(&tool)?;
    if client != "atools-ui" {
        return Err("Clipboard primitives require an active plugin host ticket; use structured clipboard tools".into());
    }
    let fields = args.as_object().ok_or("Invalid clipboard operation")?;
    let operation = args
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Missing clipboard operation")?;
    let allowed: &[&str] = match operation {
        "open" => &["operation", "intentId"],
        "request" => &["operation", "sessionId", "invocationId"],
        _ => return Err("Unsupported clipboard operation".into()),
    };
    if fields.len() != allowed.len() || fields.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("Clipboard payloads cannot enter durable task history".into());
    }
    let runtime = super::manager(app)?;
    if operation == "open" {
        let id = args
            .get("intentId")
            .and_then(Value::as_str)
            .ok_or("Missing clipboard intent")?;
        let state = runtime.store.lock();
        let intent = state
            .intents
            .get(id)
            .ok_or("Clipboard authorization expired")?;
        if intent.document.as_ref().is_some_and(|d| !d.is_active())
            || tool.plugin_id.as_deref() != Some(&intent.plugin)
            || intent.access != access
            || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Clipboard intent identity mismatch".into());
        }
    } else {
        let id = args
            .get("invocationId")
            .and_then(Value::as_str)
            .ok_or("Missing clipboard ticket")?;
        let state = runtime.store.lock();
        let invocation = state
            .invocations
            .get(id)
            .ok_or("Clipboard invocation expired")?;
        let session = state
            .sessions
            .get(&invocation.session)
            .ok_or("Clipboard session closed")?;
        if session.document.as_ref().is_some_and(|d| !d.is_active())
            || tool.plugin_id.as_deref() != Some(&session.plugin)
            || session.access != access
            || session.tool != name
            || args.get("sessionId").and_then(Value::as_str) != Some(&session.id)
        {
            return Err("Clipboard invocation identity mismatch".into());
        }
    }
    Ok(())
}
