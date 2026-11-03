//! Renderer-owned lifecycle dispatch with a short active deadline and one receipt.
use super::{
    admission,
    dto::{Operation, Outcome, Receipt},
    registry,
    store::Intent,
};
use atools_core::{agent::ToolDefinition, Database};
use serde::Serialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Dispatch<'a> {
    request_id: &'a str,
    ticket: &'a str,
    session_id: &'a str,
    operation: Operation,
    plugin_id: &'a str,
    code_revision: &'a str,
    action: &'a Value,
}

struct IntentLease {
    app: AppHandle,
    db: Database,
    intent: Arc<Intent>,
    finished: bool,
}

impl Drop for IntentLease {
    fn drop(&mut self) {
        if !self.finished {
            super::close_intent(&self.app, &self.db, &self.intent, false);
        }
    }
}

pub(super) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
) -> Result<Value, String> {
    let intent = admission::intent_for(app, db, client, &tool.name, &args)?
        .ok_or("ERR_PLUGIN_BACKGROUND_UI_REQUIRED")?;
    if intent.run_id().as_deref() != Some(run_id) {
        return Err("ERR_PLUGIN_BACKGROUND_RUN_OWNER".into());
    }
    let (_, access) = registry::validate(tool)?;
    if access.operation() != intent.request.operation {
        return Err("ERR_PLUGIN_BACKGROUND_OWNER".into());
    }
    validate_current(app, db, &intent)?;
    let mut lease = IntentLease {
        app: app.clone(),
        db: db.clone(),
        intent: intent.clone(),
        finished: false,
    };
    let (ticket, reply) = intent.start()?;
    app.emit_to(
        &intent.window,
        "plugin-background-dispatch",
        Dispatch {
            request_id: &intent.request.request_id,
            ticket: &ticket,
            session_id: &intent.request.session_id,
            operation: intent.request.operation,
            plugin_id: &intent.request.plugin_id,
            code_revision: &intent.request.code_revision,
            action: &intent.action,
        },
    )
    .map_err(|_| "ERR_PLUGIN_BACKGROUND_UI_REQUIRED")?;

    let receipt = wait(&intent, reply).await?;
    validate_current(app, db, &intent)?;
    super::finish_intent(app, &intent, receipt.outcome, run_id)?;
    if receipt.outcome == Outcome::Failed {
        return Err("ERR_PLUGIN_BACKGROUND_RENDERER_FAILED".into());
    }
    lease.finished = true;
    Ok(json!({
        "runtime":"plugin-background",
        "operation":intent.request.operation.as_str(),
        "outcome":receipt.outcome.as_str(),
        "sessionId":intent.request.session_id,
        "pluginId":intent.request.plugin_id,
        "codeRevision":intent.request.code_revision
    }))
}

fn validate_current(app: &AppHandle, db: &Database, intent: &Intent) -> Result<(), String> {
    super::candidates::validate_current(
        db,
        &intent.request.plugin_id,
        &intent.request.code_revision,
        intent.request.operation == Operation::Start,
    )?;
    if intent.request.operation == Operation::Start {
        let name = registry::tool_name(&intent.request.plugin_id, registry::Access::Start);
        if crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &name)?
            == atools_core::agent::PermissionDecision::Deny
        {
            return Err("ERR_PLUGIN_BACKGROUND_PERMISSION_REVOKED".into());
        }
    }
    if app.get_webview_window(&intent.window).is_none() || !intent.is_live() {
        return Err("ERR_PLUGIN_BACKGROUND_CANCELLED".into());
    }
    Ok(())
}

pub(super) async fn wait(
    intent: &Intent,
    mut reply: tokio::sync::oneshot::Receiver<Result<Receipt, String>>,
) -> Result<Receipt, String> {
    loop {
        let remaining = {
            let state = intent.state.lock();
            if state.closed {
                return Err("ERR_PLUGIN_BACKGROUND_CANCELLED".into());
            }
            state
                .flight
                .as_ref()
                .ok_or("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED")?
                .clock
                .remaining(Instant::now())
        };
        if remaining.is_some_and(|left| left.is_zero()) {
            return Err("ERR_PLUGIN_BACKGROUND_DEADLINE".into());
        }
        tokio::select! {
            response = &mut reply => {
                let state = intent.state.lock();
                if state.closed { return Err("ERR_PLUGIN_BACKGROUND_CANCELLED".into()); }
                if state.flight.as_ref().and_then(|flight| flight.clock.remaining(Instant::now())).is_some_and(|left| left.is_zero()) {
                    return Err("ERR_PLUGIN_BACKGROUND_DEADLINE".into());
                }
                return response.map_err(|_| "ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED".to_string())?;
            }
            _ = intent.changed.notified() => {}
            _ = async {
                if let Some(delay) = remaining { tokio::time::sleep(delay).await; }
                else { std::future::pending::<()>().await; }
            } => {
                let state = intent.state.lock();
                if state.flight.as_ref().and_then(|flight| flight.clock.remaining(Instant::now())).is_some_and(|left| left.is_zero()) {
                    return Err("ERR_PLUGIN_BACKGROUND_DEADLINE".into());
                }
            }
        }
    }
}
