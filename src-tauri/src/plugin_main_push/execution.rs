//! A successful TaskRun requires a correlated real callback receipt.
use super::{
    candidates,
    dto::{Outcome, Receipt},
    store::Intent,
};
use atools_core::{agent::ToolDefinition, Database};
use serde::Serialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Dispatch<'a> {
    request_id: &'a str,
    ticket: &'a str,
    runner_id: &'a str,
    operation: super::dto::Operation,
    candidate: &'a super::dto::Identity,
    action: serde_json::Value,
}
struct Lease {
    app: AppHandle,
    intent: Arc<Intent>,
    finished: bool,
    successful: bool,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(runtime) = super::manager(&self.app) {
            let closed = runtime.finish(&self.intent, self.successful);
            if let Some(state) = self.app.try_state::<crate::state::AppState>() {
                super::close_set(&self.app, &state.db, closed);
            }
        }
        if self.finished {
            self.intent.close();
        } else if let Some(state) = self.app.try_state::<crate::state::AppState>() {
            super::close_intent(&self.app, &state.db, &self.intent);
        }
    }
}
pub(super) async fn wait(
    intent: &Intent,
    mut reply: tokio::sync::oneshot::Receiver<Result<Receipt, String>>,
) -> Result<Receipt, String> {
    loop {
        let remaining = {
            let state = intent.state.lock();
            if state.closed {
                return Err("ERR_MAIN_PUSH_CANCELLED".into());
            }
            state
                .flight
                .as_ref()
                .ok_or("ERR_MAIN_PUSH_REQUEST_CLOSED")?
                .clock
                .remaining(intent.request.operation.deadline(), Instant::now())
        };
        if remaining.is_some_and(|left| left.is_zero()) {
            return Err("ERR_MAIN_PUSH_DEADLINE".into());
        }
        tokio::select! {
            receipt = &mut reply => {
                // The timer and receiver may both be ready after runtime contention.
                let state = intent.state.lock();
                if state.closed { return Err("ERR_MAIN_PUSH_CANCELLED".into()); }
                if state.flight.as_ref().and_then(|f| f.clock.remaining(intent.request.operation.deadline(), Instant::now())).is_some_and(|left| left.is_zero()) {
                    return Err("ERR_MAIN_PUSH_DEADLINE".into());
                }
                return receipt.map_err(|_| "ERR_MAIN_PUSH_REQUEST_CLOSED".to_string())?;
            },
            _ = intent.changed.notified() => {},
            _ = async {
                if let Some(duration) = remaining { tokio::time::sleep(duration).await; }
                else { std::future::pending::<()>().await; }
            } => {
                // A permission transition racing the sleep must be observed first.
                let state = intent.state.lock();
                if state.flight.as_ref().and_then(|f| f.clock.remaining(intent.request.operation.deadline(), Instant::now())).is_some_and(|d| d.is_zero()) {
                    return Err("ERR_MAIN_PUSH_DEADLINE".into());
                }
            }
        }
    }
}
pub(super) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    execution: Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
) -> Result<Value, String> {
    let intent = super::intent_for(app, db, client, &tool.name, &args)?
        .ok_or("ERR_MAIN_PUSH_UI_REQUIRED")?;
    let _execution = execution.ok_or("ERR_MAIN_PUSH_GATE_REQUIRED")?;
    let mut lease = Lease {
        app: app.clone(),
        intent: intent.clone(),
        finished: false,
        successful: false,
    };
    candidates::validate(db, &intent.request.identity)?;
    let action = crate::feature_activation::resolve_checked(
        db,
        &intent.request.identity.feature_code,
        None,
        Some(&intent.request.identity.plugin_id),
    )
    .map_err(|_| "ERR_MAIN_PUSH_OWNER_CHANGED")?;
    if !action.payload.is_null() {
        return Err("ERR_MAIN_PUSH_PRIVATE_METADATA_ONLY".into());
    }
    let (ticket, reply) = intent.start()?;
    app.emit_to(
        &intent.window,
        "plugin-main-push-dispatch",
        Dispatch {
            request_id: &intent.request.request_id,
            ticket: &ticket,
            runner_id: &intent.request.runner_id,
            operation: intent.request.operation,
            candidate: &intent.request.identity,
            action: serde_json::to_value(action).map_err(|_| "ERR_MAIN_PUSH_ACTION_INVALID")?,
        },
    )
    .map_err(|_| "ERR_MAIN_PUSH_UI_REQUIRED")?;
    let result = wait(&intent, reply).await;
    // Pipeline owns terminal failure/success. External cancellation separately wins
    // through its atomic TaskRun cancellation and removes permission requests.
    lease.finished = true;
    let receipt = result?;
    candidates::validate(db, &intent.request.identity)?;
    if receipt.outcome == Outcome::Ready {
        super::manager(app)?.ready(&intent)?;
    }
    let result = match receipt.outcome {
        Outcome::Failed => Err("ERR_MAIN_PUSH_CALLBACK_FAILED".into()),
        Outcome::Superseded => Err("ERR_MAIN_PUSH_SUPERSEDED".into()),
        _ => Ok(
            json!({"pluginId":intent.request.identity.plugin_id,"featureCode":intent.request.identity.feature_code,
            "operation":intent.request.operation,"outcome":receipt.outcome,"rowCount":receipt.row_count,
            "durationMs":receipt.duration_ms,"runtime":"plugin-main-push"}),
        ),
    };
    lease.successful = result.is_ok();
    result
}
