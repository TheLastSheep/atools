//! Only ephemeral, identity-bound tickets may enter the durable execution path.
use atools_core::db::Database;
use serde_json::Value;
use tauri::AppHandle;

pub(super) fn private_operation(args: &Value) -> Result<&str, String> {
    let fields = args.as_object().ok_or("Invalid display operation")?;
    let operation = args
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Missing display operation")?;
    let allowed: &[&str] = match operation {
        "open" => &["operation", "intentId"],
        "request" => &["operation", "sessionId", "invocationId"],
        _ => return Err("Unsupported display operation".into()),
    };
    if fields.len() != allowed.len() || fields.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("Display payloads cannot enter durable task history".into());
    }
    for field in allowed
        .iter()
        .copied()
        .filter(|field| *field != "operation")
    {
        let value = args[field].as_str().ok_or("Invalid display ticket")?;
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid display ticket".into());
        }
    }
    Ok(operation)
}

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
    super::registry::validate_tool(&tool)?;
    if client != "atools-ui" {
        return Err(
            "Display primitives require an active plugin host ticket; use structured display tools"
                .into(),
        );
    }
    let operation = private_operation(args)?;
    let runtime = super::manager(app)?;
    if operation == "open" {
        let id = args
            .get("intentId")
            .and_then(Value::as_str)
            .ok_or("Missing display intent")?;
        let state = runtime.store.lock();
        let intent = state
            .intents
            .get(id)
            .ok_or("Display authorization expired")?;
        if intent.document.as_ref().is_some_and(|d| !d.is_active())
            || tool.plugin_id.as_deref() != Some(&intent.plugin)
            || intent.created.elapsed().as_secs() >= 600
            || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Display intent identity mismatch".into());
        }
        intent.binding.validate(db, &intent.plugin)?;
    } else {
        let id = args
            .get("invocationId")
            .and_then(Value::as_str)
            .ok_or("Missing display ticket")?;
        let state = runtime.store.lock();
        let invocation = state
            .invocations
            .get(id)
            .ok_or("Display invocation expired")?;
        let session = state
            .sessions
            .get(&invocation.session)
            .ok_or("Display session closed")?;
        if session.document.as_ref().is_some_and(|d| !d.is_active())
            || tool.plugin_id.as_deref() != Some(&session.plugin)
            || session.tool != name
            || args.get("sessionId").and_then(Value::as_str) != Some(&session.id)
        {
            return Err("Display invocation identity mismatch".into());
        }
        super::validate_session(db, session)?;
    }
    Ok(())
}

/// Bind before audit starts so close can cancel both awaiting and running tickets.
pub fn bind_run(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args: &Value,
    run: &str,
) -> Result<(), String> {
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "Display capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::registry::SOURCE {
        return Ok(());
    }
    validate_private_request(app, db, "atools-ui", name, args)?;
    let runtime = super::manager(app)?;
    let store = runtime.store.lock();
    if args["operation"] == "open" {
        let intent = store
            .intents
            .get(args["intentId"].as_str().ok_or("Missing display intent")?)
            .ok_or("Display authorization closed")?;
        if intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
            || intent.created.elapsed().as_secs() >= 600
            || intent.document.as_ref().is_some_and(|d| !d.is_active())
        {
            return Err("Display authorization closed".into());
        }
        *intent.run.lock() = Some(run.into());
    } else {
        let invocation = store
            .invocations
            .get(
                args["invocationId"]
                    .as_str()
                    .ok_or("Missing display invocation")?,
            )
            .ok_or("Display invocation closed")?;
        let session = store
            .sessions
            .get(&invocation.session)
            .ok_or("Display session closed")?;
        if !*session.active.lock() || session.document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Display session closed".into());
        }
        *invocation.run.lock() = Some(run.into());
    }
    Ok(())
}
