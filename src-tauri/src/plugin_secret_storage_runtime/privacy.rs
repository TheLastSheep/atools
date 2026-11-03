use atools_core::db::Database;
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
        .map_err(|_| "Secret storage capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::registry::SOURCE {
        return Ok(());
    }
    let plugin = super::registry::validate(&tool)?;
    if client != "atools-ui" {
        return Err("Secret storage requires an active private host ticket".into());
    }
    validate_task_metadata(args)?;
    let runtime = super::manager(app)?;
    let operation = args
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Missing operation")?;
    let store = runtime.store.lock();
    if operation == "open" {
        let id = args["intentId"].as_str().ok_or("Missing intent")?;
        let intent = store
            .intents
            .get(id)
            .ok_or("Secret storage intent expired")?;
        if intent.owner.plugin != plugin
            || name != super::registry::tool_name(plugin)
            || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
            || intent.document.as_ref().is_some_and(|d| !d.is_active())
            || intent.created.elapsed().as_secs() >= 600
        {
            return Err("Secret storage intent identity mismatch".into());
        }
    } else {
        let id = args["invocationId"].as_str().ok_or("Missing invocation")?;
        let inv = store
            .invocations
            .get(id)
            .ok_or("Secret storage invocation expired")?;
        let session = store
            .sessions
            .get(&inv.session)
            .ok_or("Secret storage session closed")?;
        if session.owner.plugin != plugin
            || session.tool != name
            || args["sessionId"] != session.id
            || args["method"] != inv.request["method"]
            || session.document.as_ref().is_some_and(|d| !d.is_active())
        {
            return Err("Secret storage invocation identity mismatch".into());
        }
    }
    Ok(())
}

fn validate_task_metadata(args: &Value) -> Result<(), String> {
    let object = args.as_object().ok_or("Invalid secret storage metadata")?;
    let operation = args
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Missing operation")?;
    let allowed: &[&str] = match operation {
        "open" => &["operation", "intentId"],
        "request" => &["operation", "sessionId", "invocationId", "method"],
        _ => return Err("Unsupported operation".into()),
    };
    if object.len() != allowed.len() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Secret storage payload cannot enter task history".into());
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
        .map_err(|_| "Secret storage capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::registry::SOURCE {
        return Ok(());
    }
    let runtime = super::manager(app)?;
    let ok = match args["operation"].as_str() {
        Some("open") => runtime.bind_run(args["intentId"].as_str().ok_or("Missing intent")?, run),
        Some("request") => runtime.bind_invocation(
            args["invocationId"].as_str().ok_or("Missing invocation")?,
            run,
        ),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err("Secret storage request closed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_task_metadata;
    use serde_json::json;

    #[test]
    fn task_run_arguments_allow_only_opaque_operation_references() {
        assert!(
            validate_task_metadata(&json!({"operation":"open","intentId":"opaque-intent"})).is_ok()
        );
        assert!(validate_task_metadata(&json!({"operation":"request","sessionId":"opaque-session","invocationId":"opaque-ticket","method":"encrypt"})).is_ok());
        for args in [
            json!({"operation":"request","sessionId":"s","invocationId":"i","method":"encrypt","text":"do not persist"}),
            json!({"operation":"request","sessionId":"s","invocationId":"i","method":"decrypt","data":"do not persist"}),
            json!({"operation":"request","sessionId":"s","invocationId":"i","method":"decrypt","token":"do not persist"}),
        ] {
            assert!(validate_task_metadata(&args).is_err());
        }
    }
}
