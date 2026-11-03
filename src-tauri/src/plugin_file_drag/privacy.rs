//! Strict, durable-metadata-only private TaskRun validation and binding.
use atools_core::{db::Database, task_run::TaskRunStatus};
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
        .map_err(|_| "File-drag capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::SOURCE {
        return Ok(());
    }
    let plugin = super::registry::validate(&tool)?;
    if client != "atools-ui" || name != super::registry::tool_name(plugin) || !tool.enabled {
        return Err("File-drag requires an active private host ticket".into());
    }
    validate_metadata(args)?;
    let runtime = super::manager(app)?;
    match args["operation"].as_str() {
        Some("open") => {
            let intent = runtime.get_intent(
                args["intentId"]
                    .as_str()
                    .ok_or("Missing file-drag intent")?,
            )?;
            if intent.owner.plugin != plugin
                || intent.binding.validate(db, plugin).is_err()
                || intent.created.elapsed() >= super::types::SESSION_TTL
                || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
                || intent
                    .document
                    .as_ref()
                    .is_some_and(|document| !document.is_active())
            {
                return Err("File-drag authorization expired or changed".into());
            }
        }
        Some("request") => {
            let invocation_id = args["invocationId"]
                .as_str()
                .ok_or("Missing file-drag invocation")?;
            let invocation = runtime.invocation(invocation_id)?;
            let session = runtime.get(&invocation.session)?;
            super::registry::validate_invocation_identity(&invocation, &session, &tool)?;
            if session.owner.plugin != plugin
                || args["sessionId"] != session.id
                || invocation
                    .cancelled
                    .load(std::sync::atomic::Ordering::Acquire)
                || invocation.paths.lock().is_none()
            {
                return Err("File-drag invocation identity mismatch".into());
            }
            super::validate_session(db, &session)?;
            let bound_run_id = invocation.run.lock().clone();
            if let Some(run_id) = bound_run_id.as_deref() {
                let run = db
                    .get_task_run(run_id)
                    .map_err(|_| "File-drag TaskRun unavailable")?
                    .ok_or("File-drag TaskRun unavailable")?;
                if run.capability_id != name
                    || run.input != *args
                    || run.status != TaskRunStatus::Created
                        && run.status != TaskRunStatus::Running
                        && run.status != TaskRunStatus::AwaitingPermission
                {
                    return Err("File-drag TaskRun identity mismatch".into());
                }
            }
        }
        _ => return Err("Unsupported file-drag operation".into()),
    }
    Ok(())
}

pub(crate) fn bind_run(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args: &Value,
    run_id: &str,
) -> Result<(), String> {
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "File-drag capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::SOURCE {
        return Ok(());
    }
    super::registry::validate(&tool)?;
    validate_metadata(args)?;
    let runtime = super::manager(app)?;
    match args["operation"].as_str() {
        Some("open") => runtime.bind_intent_run(
            args["intentId"]
                .as_str()
                .ok_or("Missing file-drag intent")?,
            run_id,
        ),
        Some("request") => runtime.bind_invocation_run(
            args["invocationId"]
                .as_str()
                .ok_or("Missing file-drag invocation")?,
            run_id,
        ),
        _ => return Err("Unsupported file-drag operation".into()),
    }
}

fn validate_metadata(args: &Value) -> Result<(), String> {
    let object = args.as_object().ok_or("Invalid file-drag metadata")?;
    let allowed: &[&str] = match args.get("operation").and_then(Value::as_str) {
        Some("open") => &["operation", "intentId"],
        Some("request") => &["operation", "sessionId", "invocationId"],
        _ => return Err("Unsupported file-drag operation".into()),
    };
    if object.len() != allowed.len() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("File paths cannot enter durable TaskRun metadata".into());
    }
    for key in allowed.iter().skip(1) {
        let value = args
            .get(*key)
            .and_then(Value::as_str)
            .ok_or("Invalid file-drag reference")?;
        if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
            return Err("Invalid file-drag reference".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_metadata;
    use serde_json::json;

    #[test]
    fn task_arguments_contain_only_opaque_references() {
        assert!(validate_metadata(&json!({"operation":"open","intentId":"opaque"})).is_ok());
        assert!(validate_metadata(
            &json!({"operation":"request","sessionId":"s","invocationId":"i"})
        )
        .is_ok());
        for invalid in [
            json!({"operation":"request","sessionId":"s","invocationId":"i","paths":["/private/file"]}),
            json!({"operation":"open","intentId":"opaque","path":"/private/file"}),
            json!({"operation":"request","sessionId":"s","invocationId":"i","method":"startDrag"}),
        ] {
            assert!(validate_metadata(&invalid).is_err());
        }
    }
}
