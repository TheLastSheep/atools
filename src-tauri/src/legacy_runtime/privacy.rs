use atools_core::db::Database;
use serde_json::Value;
use tauri::AppHandle;

/// Validate before the shared pipeline persists input. Node payloads are private
/// transport data; only metadata and a one-shot ephemeral ticket enter TaskRun.
pub fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    // Background UI/MCP precreation also enters this privacy boundary.
    if name.starts_with("plugin_main_push_") {
        return crate::plugin_main_push::validate_private_request(app, db, client, name, args);
    }
    let Some(tool) = db.get_agent_tool(name).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if tool.source == crate::plugin_main_push::registry::SOURCE {
        return crate::plugin_main_push::validate_private_request(app, db, client, name, args);
    }
    if tool.source != super::registry::SOURCE {
        crate::plugin_browser_window_runtime::validate_private_request(
            app, db, client, name, args,
        )?;
        crate::plugin_secret_storage_runtime::validate_private_request(
            app, db, client, name, args,
        )?;
        crate::plugin_dialog_runtime::validate_private_request(app, db, client, name, args)?;
        crate::plugin_system_paths::validate_private_request(app, db, client, name, args)?;
        crate::plugin_data_runtime::validate_private_request(app, db, client, name, args)?;
        crate::plugin_display_runtime::validate_private_request(app, db, client, name, args)?;
        return crate::host_runtime::validate_private_request(app, db, client, name, args);
    }
    let fields = args.as_object().ok_or("Invalid Node operation")?;
    let operation = args
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Missing Node operation")?;
    let allowed: &[&str] = match operation {
        "open" => &["operation", "intentId"],
        "close" => &["operation", "sessionId"],
        "request" => &["operation", "sessionId", "invocationId", "method"],
        _ => return Err("Unsupported Node operation".into()),
    };
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Raw Node arguments cannot enter durable task history".into());
    }
    if operation != "request" {
        return Ok(());
    }
    let runtime = super::manager(app);
    let ticket=args.get("invocationId").and_then(Value::as_str).ok_or("Node primitives require an active plugin transport ticket; use declared structured plugin capabilities")?;
    let invocation = runtime
        .invocations
        .lock()
        .get(ticket)
        .cloned()
        .ok_or("Node invocation expired")?;
    let session = runtime.get(&invocation.session_id)?;
    if session.document.as_ref().is_some_and(|d| !d.is_active())
        || session.client != client
        || session.tool != name
        || tool.plugin_id.as_deref() != Some(&session.plugin_id)
        || args.get("sessionId").and_then(Value::as_str) != Some(&session.id)
        || args.get("method") != invocation.request.get("method")
    {
        return Err("Node invocation identity mismatch".into());
    }
    Ok(())
}
