//! Permission-bound, ephemeral native display metadata. No screenshot authority.
pub mod commands;
#[cfg(test)]
mod deferred_open_tests;
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub mod desktop_smoke;
mod geometry;
mod lifecycle;
mod native;
mod privacy;
pub mod registry;
mod session_close;
#[cfg(test)]
mod session_lease_tests;
mod session_open;
mod sessions;
mod source_hint;
#[cfg(test)]
mod tests;
mod transport;
use atools_core::{
    agent::{PermissionDecision, ToolDefinition},
    db::Database,
};
pub use privacy::{bind_run, validate_private_request};
use serde_json::{json, Value};
use sessions::Session;
pub use sessions::Sessions;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager};

pub fn manager(app: &AppHandle) -> Result<Arc<Sessions>, String> {
    app.try_state::<Arc<Sessions>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Display host is unavailable".into())
}
pub fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Sessions::new()));
    app.manage(source_hint::Hints::default());
}
fn validate_session(db: &Database, session: &Session) -> Result<(), String> {
    if session.document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Plugin document closed".into());
    }
    session.binding.validate(db, &session.plugin)?;
    let tool = db
        .get_agent_tool(&session.tool)
        .map_err(|_| "Display capability unavailable")?
        .ok_or("Display capability unavailable")?;
    registry::validate_tool(&tool)?;
    if !tool.enabled {
        return Err("Display capability is disabled".into());
    }
    if crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &session.tool)?
        == PermissionDecision::Deny
    {
        return Err("Display access was revoked".into());
    }
    Ok(())
}
pub async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
) -> Result<Value, String> {
    validate_private_request(app, db, client, &tool.name, &args)?;
    registry::validate_tool(tool)?;
    let plugin = db
        .get_plugin(tool.plugin_id.as_deref().ok_or("Missing plugin identity")?)
        .map_err(|_| "Plugin unavailable")?;
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let runtime = manager(app)?;
    match args.get("operation").and_then(Value::as_str) {
        Some("open") => {
            let intent = args["intentId"].as_str().ok_or("Missing display intent")?;
            let binding = sessions::Binding::current(db, &plugin)?;
            let session = runtime.open(intent, &plugin, &binding)?;
            if let Err(error) = transport::ensure_server(app, &runtime).await {
                runtime.abort_open(intent, &session.id).await;
                return Err(error);
            }
            if let Err(error) = runtime.complete_open(intent, &session.id) {
                runtime.abort_open(intent, &session.id).await;
                return Err(error);
            }
            // Opening is scope-only. Neither transport credentials nor display
            // contents appear in this durable result.
            Ok(
                json!({"operation":"open","sessionId":session.id,"status":"ready","runtime":"plugin-display"}),
            )
        }
        Some("request") => {
            let ticket = args["invocationId"]
                .as_str()
                .ok_or("Missing display ticket")?;
            let invocation = runtime
                .store
                .lock()
                .invocations
                .get(ticket)
                .cloned()
                .ok_or("Display invocation expired")?;
            if invocation.claimed.swap(true, Ordering::AcqRel) {
                return Err("Display invocation already consumed".into());
            }
            *invocation.run.lock() = Some(run_id.into());
            let session = runtime.get(&invocation.session)?;
            validate_session(db, &session)?;
            if !*session.active.lock() {
                return Err("Display session closed".into());
            }
            let result = native::snapshot(app, session.clone())
                .await
                .and_then(|value| {
                    validate_session(db, &session)?;
                    if !*session.active.lock() {
                        return Err("Display session closed".into());
                    }
                    Ok(value)
                });
            let count = result
                .as_ref()
                .ok()
                .and_then(|v| v["displays"].as_array())
                .map_or(0, Vec::len);
            let failed = result.is_err();
            *invocation.result.lock() = Some(result);
            if failed {
                return Err(
                    "Display operation failed; private details were returned to the plugin".into(),
                );
            }
            Ok(
                json!({"operation":"snapshot","count":count,"status":"completed","transportOnly":true}),
            )
        }
        _ => Err("Unsupported display operation".into()),
    }
}
fn same_token(expected: &str, actual: &str) -> bool {
    expected.len() == actual.len()
        && expected
            .bytes()
            .zip(actual.bytes())
            .fold(0u8, |d, (a, b)| d | (a ^ b))
            == 0
}
pub async fn invalidate(app: &AppHandle, db: &Database, plugin: Option<&str>) {
    if let Ok(runtime) = manager(app) {
        lifecycle::close(app, db, &runtime, None, plugin, false).await;
    }
    if let Some(hints) = app.try_state::<source_hint::Hints>() {
        hints.invalidate(plugin);
    }
}
pub(crate) async fn close_document(app: &AppHandle, page_id: &str) {
    let Ok(runtime) = manager(app) else { return };
    let state = app.state::<crate::state::AppState>();
    for (owner, plugin) in runtime.document_owners(page_id) {
        for run in runtime.close_document_owner(&owner, &plugin, page_id).await {
            lifecycle::cancel_pending(app, &state.db, &run);
        }
    }
}
pub async fn close_window(app: &AppHandle, label: &str) {
    let Ok(runtime) = manager(app) else { return };
    let prefix = format!("window:{label}:");
    let owners: std::collections::HashSet<_> = {
        let store = runtime.store.lock();
        store
            .sessions
            .values()
            .map(|s| s.owner.clone())
            .chain(store.intents.values().map(|i| i.owner.clone()))
            .filter(|o| o.starts_with(&prefix))
            .collect()
    };
    let state = app.state::<crate::state::AppState>();
    for owner in owners {
        lifecycle::close(app, &state.db, &runtime, Some(&owner), None, false).await;
    }
}

pub async fn stop(app: &AppHandle) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &runtime, None, None, true).await;
    }
}
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) fn runtime_state(app: &AppHandle) -> Value {
    match manager(app) {
        Ok(runtime) => {
            let store = runtime.store.lock();
            json!({"displayRuntimeAvailable":true,"displaySessions":store.sessions.len(),"displayIntents":store.intents.len(),"displayInvocations":store.invocations.len()})
        }
        Err(_) => {
            json!({"displayRuntimeAvailable":false,"displaySessions":0,"displayIntents":0,"displayInvocations":0})
        }
    }
}
