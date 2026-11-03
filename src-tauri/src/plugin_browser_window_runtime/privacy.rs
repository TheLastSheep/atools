//! Bind the durable TaskRun envelope to one live, generation-bound source intent.
use crate::plugin_window_sources::SourceBinding;
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
        .map_err(|_| "BrowserWindow capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::SOURCE {
        return Ok(());
    }
    super::registry::validate(&tool)?;
    if client != "atools-ui" {
        return Err("Plugin BrowserWindow requires an active private host intent".into());
    }
    let (operation, intent_id) = private_arguments(args)?;
    let runtime = super::manager(app)?;
    let intent = runtime.intent(intent_id)?;
    let plugin_id = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing BrowserWindow plugin identity")?;
    if intent.owner.plugin != plugin_id
        || name != super::registry::tool_name(plugin_id)
        || intent.operation != operation
        || intent.state() == super::intents::IntentState::Cancelled
    {
        return Err("BrowserWindow intent identity mismatch".into());
    }
    let source = crate::plugin_window_sources::resolve(
        app,
        &intent.owner.window,
        &intent.source_binding_id,
    )?;
    if source.owner() != &intent.owner || !source.is_active() {
        return Err("BrowserWindow source is no longer active".into());
    }
    match operation {
        super::intents::Operation::Open => validate_open_intent(&intent),
        super::intents::Operation::Action => validate_action_intent(&runtime, &source, &intent),
    }
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
        .map_err(|_| "BrowserWindow capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != super::SOURCE {
        return Ok(());
    }
    validate_private_request(app, db, "atools-ui", name, args)?;
    let (_, intent_id) = private_arguments(args)?;
    let intent = super::manager(app)?.intent(intent_id)?;
    intent.set_run(run_id)
}

fn validate_open_intent(intent: &super::intents::Intent) -> Result<(), String> {
    match intent.payload.lock().as_ref() {
        Some(super::intents::Payload::Open { spec: Some(spec) })
            if spec.label().starts_with("atools-native-browser-") =>
        {
            Ok(())
        }
        _ => Err("BrowserWindow open intent is no longer available".into()),
    }
}

fn validate_action_intent(
    runtime: &super::manager::Runtime,
    source: &SourceBinding,
    intent: &super::intents::Intent,
) -> Result<(), String> {
    let action = match intent.payload.lock().as_ref() {
        Some(super::intents::Payload::Action { action, .. }) => action.clone(),
        _ => return Err("BrowserWindow action intent is no longer available".into()),
    };
    let target = runtime.window_for_source(source, &intent.window_id)?;
    if action == "__renderReady" {
        if target.creator_binding_id != source.id()
            || target
                .renderer_ready
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("BrowserWindow renderer readiness intent is not current".into());
        }
    }
    Ok(())
}

fn private_arguments(args: &Value) -> Result<(super::intents::Operation, &str), String> {
    let fields = args
        .as_object()
        .ok_or("Invalid BrowserWindow private envelope")?;
    if fields.len() != 2
        || fields
            .keys()
            .any(|key| !["operation", "intentId"].contains(&key.as_str()))
    {
        return Err(
            "BrowserWindow options and actions cannot enter durable TaskRun history".into(),
        );
    }
    let operation = match args.get("operation").and_then(Value::as_str) {
        Some("open") => super::intents::Operation::Open,
        Some("action") => super::intents::Operation::Action,
        _ => return Err("Unsupported BrowserWindow operation".into()),
    };
    let id = args
        .get("intentId")
        .and_then(Value::as_str)
        .ok_or("Missing BrowserWindow intent")?;
    if !super::intents::is_private_id(id) {
        return Err("Invalid BrowserWindow intent".into());
    }
    Ok((operation, id))
}

#[cfg(test)]
#[path = "privacy_tests.rs"]
mod tests;
