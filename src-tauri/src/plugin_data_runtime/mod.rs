//! Private synchronous SQLite bridge for opaque plugin frames.
pub(crate) mod commands;
#[cfg(test)]
mod document_tests;
mod dynamic_features;
#[cfg(test)]
mod dynamic_features_tests;
mod failure_category;
mod lifecycle;
mod operations;
mod privacy;
pub(crate) mod registry;
mod sessions;
mod source_hint;
mod startup;
#[cfg(test)]
mod startup_tests;
#[cfg(test)]
mod tests;
mod transport;
mod types;
mod web_storage;
mod web_storage_events;
#[cfg(test)]
mod web_storage_tests;

use atools_core::{
    agent::{PermissionDecision, ToolDefinition},
    Database,
};
pub(crate) use privacy::bind_run;
pub(crate) use privacy::validate_private_request;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use failure_category::task_run_audit_fields;
use serde_json::{json, Value};
pub(crate) use sessions::Sessions;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager};
use types::{Binding, Session};
type ExecutionGuard = Arc<tokio::sync::OwnedRwLockReadGuard<()>>;
pub(crate) const BACKGROUND_STARTUP_KEY: &str = "__atools_background_startup_v1";

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Sessions::default()));
    app.manage(source_hint::Hints::default());
    app.manage(Arc::new(web_storage_events::WebStorageEvents::default()));
}
pub(crate) fn manager(app: &AppHandle) -> Result<Arc<Sessions>, String> {
    app.try_state::<Arc<Sessions>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Plugin data runtime is unavailable".into())
}
fn validate_session(db: &Database, session: &Session) -> Result<(), String> {
    if session.document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Plugin document closed".into());
    }
    session.binding.validate(db, &session.owner.plugin)?;
    let tool = db
        .get_agent_tool(&session.tool)
        .map_err(|_| "Data capability unavailable")?
        .ok_or("Data capability unavailable")?;
    if registry::validate(&tool)? != session.owner.plugin
        || !tool.enabled
        || crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &session.tool)?
            == PermissionDecision::Deny
    {
        return Err("Plugin data permission was revoked".into());
    }
    Ok(())
}
pub(crate) fn prune_web_storage_events(app: &AppHandle, runtime: &Sessions) {
    // Snapshot sessions before acquiring event storage; never nest these locks.
    let active_sessions = runtime
        .store
        .lock()
        .sessions
        .values()
        .filter(|session| *session.active.lock())
        .map(|session| session.id.clone())
        .collect::<std::collections::HashSet<_>>();
    if let Some(events) = app.try_state::<Arc<web_storage_events::WebStorageEvents>>() {
        events.prune(&active_sessions);
    }
}
pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
    execution: Option<ExecutionGuard>,
) -> Result<Value, String> {
    validate_private_request(app, db, client, &tool.name, &args)?;
    let plugin_id = registry::validate(tool)?;
    let plugin = db.get_plugin(plugin_id).map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(db, &plugin)?;
    let runtime = manager(app)?;
    match args["operation"].as_str() {
        Some("open") => {
            let intent = args["intentId"].as_str().ok_or("Missing data intent")?;
            let session = runtime.open(intent, &binding)?;
            let mut opening = lifecycle::OpeningLease {
                runtime: runtime.clone(),
                owner: session.owner.clone(),
                app: app.clone(),
                db: app.state::<crate::state::AppState>().db.clone(),
                committed: false,
            };
            if app.get_webview_window(&session.owner.window).is_none() {
                runtime.close(Some(&session.owner), None, None, false);
                return Err("Plugin window closed".into());
            }
            if let Err(error) = transport::ensure_server(app, &runtime).await {
                runtime.close(Some(&session.owner), None, None, false);
                runtime.idle().await;
                return Err(error);
            }
            runtime.get(&session.id)?;
            opening.committed = true;
            Ok(
                json!({"sessionId":session.id,"pluginId":plugin_id,"runtime":"plugin-data","requiresData":true}),
            )
        }
        Some("request") => {
            let ticket = args["invocationId"].as_str().ok_or("Missing data ticket")?;
            let invocation = runtime
                .store
                .lock()
                .invocations
                .get(ticket)
                .cloned()
                .ok_or("Data invocation expired")?;
            if invocation.claimed.swap(true, Ordering::AcqRel) {
                return Err("Data invocation already consumed".into());
            }
            *invocation.run.lock() = Some(run_id.into());
            let session = runtime.get(&invocation.session)?;
            let guard = execution.ok_or("Data operation requires plugin execution gate")?;
            let permit = runtime
                .operations
                .clone()
                .try_acquire_owned()
                .map_err(|_| "Plugin data runtime is busy")?;
            let database = app.state::<crate::state::AppState>().db.clone();
            let worker_invocation = invocation.clone();
            let worker_app = app.clone();
            let worker_runtime = runtime.clone();
            let ticket_for_event = ticket.to_owned();
            // Both guard and worker permit outlive an aborted async/HTTP caller.
            let result = tauri::async_runtime::spawn_blocking(move || {
                let (_execution, _permit) = (guard, permit);
                if !*session.active.lock() {
                    return Err("Data session closed".into());
                }
                validate_session(&database, &session)?;
                let context = web_storage::ExecutionContext {
                    app: worker_app,
                    runtime: worker_runtime,
                    session: session.clone(),
                    invocation_id: ticket_for_event,
                };
                operations::execute_with_context(
                    &database,
                    &session.owner.plugin,
                    &worker_invocation.request,
                    Some(&context),
                )
            })
            .await
            .map_err(|_| "Data worker interrupted")?;
            let failed = result.as_ref().map_or(true, |value| {
                operations::logical_failure(args["method"].as_str().unwrap_or(""), value)
            });
            let failure_code = failed.then(|| {
                failure_category::for_operation(args["method"].as_str().unwrap_or(""), &result)
            });
            *invocation.result.lock() = Some(result);
            if let Some(failure_code) = failure_code {
                return Err(format!("Plugin data operation failed; private details returned only to the active plugin [failureCode={failure_code}]"));
            }
            Ok(
                json!({"invocationId":ticket,"method":args["method"],"transportOnly":true,
                "summary":"Plugin-local SQLite operation completed; data contents are private"}),
            )
        }
        _ => Err("Unsupported data operation".into()),
    }
}
pub(crate) async fn invalidate(app: &AppHandle, db: &Database, plugin: Option<&str>) {
    if let Some(hints) = app.try_state::<source_hint::Hints>() {
        if let Some(id) = plugin {
            hints.invalidate(id);
        }
    }
    if let Ok(runtime) = manager(app) {
        lifecycle::close(app, db, &runtime, None, plugin, None, false).await;
        prune_web_storage_events(app, &runtime);
    }
}
pub(crate) async fn close_document(app: &AppHandle, page_id: &str) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        for owner in runtime.document_owners(page_id) {
            lifecycle::close(app, &state.db, &runtime, Some(&owner), None, None, false).await;
        }
        prune_web_storage_events(app, &runtime);
    }
}
pub(crate) async fn close_window(app: &AppHandle, label: &str) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &runtime, None, None, Some(label), false).await;
        prune_web_storage_events(app, &runtime);
    }
}
pub(crate) async fn stop(app: &AppHandle) {
    if let Ok(runtime) = manager(app) {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            lifecycle::close(app, &state.db, &runtime, None, None, None, true).await;
            prune_web_storage_events(app, &runtime);
        } else {
            runtime.close(None, None, None, true);
            prune_web_storage_events(app, &runtime);
            runtime.idle().await;
        }
    }
}
#[cfg(feature = "legacy-node-smoke")]
pub(crate) async fn runtime_state(app: &AppHandle) -> Value {
    if let Ok(runtime) = manager(app) {
        let (sessions, intents, invocations, preparations) = runtime.counts();
        let (
            web_storage_events,
            web_storage_event_bytes,
            web_storage_event_evictions,
            web_storage_event_emit_mismatches,
        ) = app
            .try_state::<Arc<web_storage_events::WebStorageEvents>>()
            .map(|events| events.counts())
            .unwrap_or_default();
        json!({"dataSessions":sessions,"dataIntents":intents,"dataInvocations":invocations,
            "dataPreparations":preparations,"dataTransport":runtime.server.lock().await.is_some(),
            "webStorageEvents":web_storage_events,"webStorageEventBytes":web_storage_event_bytes,
            "webStorageEventEvictions":web_storage_event_evictions,
            "webStorageEventEmitMismatches":web_storage_event_emit_mismatches})
    } else {
        json!({"dataSessions":0,"dataIntents":0,"dataInvocations":0,"dataPreparations":0,"dataTransport":false,
            "webStorageEvents":0,"webStorageEventBytes":0,"webStorageEventEvictions":0,
            "webStorageEventEmitMismatches":0})
    }
}
