//! Plugin-scoped Electron safeStorage backed by a prewarmed macOS Keychain key.
pub(crate) mod commands;
mod crypto;
mod keychain;
mod lifecycle;
mod once_authorization;
#[cfg(test)]
mod once_authorization_tests;
mod privacy;
pub(crate) mod registry;
mod sessions;
#[cfg(test)]
mod sessions_tests;
mod transport;
mod types;

use atools_core::{
    agent::{PermissionDecision, ToolDefinition},
    Database,
};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager};
use types::{Binding, Session};
type ExecutionGuard = Arc<tokio::sync::OwnedRwLockReadGuard<()>>;

fn key_snapshot(session: &Session) -> Result<zeroize::Zeroizing<[u8; 32]>, String> {
    let active = session.active.lock();
    if !*active {
        return Err("Secret storage session closed".into());
    }
    let key = session.key.lock();
    if !*active {
        return Err("Secret storage session closed".into());
    }
    Ok(zeroize::Zeroizing::new(**key))
}

pub(crate) use privacy::{bind_run, validate_private_request};
pub(crate) use sessions::Sessions;
pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Sessions::default()));
}
pub(crate) fn manager(app: &AppHandle) -> Result<Arc<Sessions>, String> {
    app.try_state::<Arc<Sessions>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Secret storage runtime unavailable".into())
}
fn validate_session(db: &Database, session: &Session) -> Result<(), String> {
    if !*session.active.lock() || session.document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Secret storage session closed".into());
    }
    session.binding.validate(db, &session.owner.plugin)?;
    let tool = db
        .get_agent_tool(&session.tool)
        .map_err(|_| "Secret storage capability unavailable")?
        .ok_or("Secret storage capability unavailable")?;
    if registry::validate(&tool)? != session.owner.plugin || !tool.enabled {
        return Err("Secret storage capability revoked".into());
    }
    match crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &session.tool)? {
        PermissionDecision::Deny => Err("Secret storage permission denied".into()),
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Confirm
            if session
                .once
                .as_ref()
                .is_some_and(|proof| proof.permits(db, session)) =>
        {
            Ok(())
        }
        PermissionDecision::Confirm => Err("Secret storage approval expired or revoked".into()),
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
    let runtime = manager(app)?;
    match args["operation"].as_str() {
        Some("open") => {
            let intent_id = args["intentId"]
                .as_str()
                .ok_or("Missing secret storage intent")?;
            let intent = {
                runtime
                    .store
                    .lock()
                    .intents
                    .get(intent_id)
                    .cloned()
                    .ok_or("Secret storage intent expired")?
            };
            let plugin = db.get_plugin(plugin_id).map_err(|_| "Plugin unavailable")?;
            let binding = Binding::current(db, &plugin)?;
            let decision =
                crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool.name)?;
            if decision == PermissionDecision::Deny {
                return Err("Secret storage permission denied".into());
            }
            let once = if decision == PermissionDecision::Confirm {
                Some(once_authorization::OnceAuthorization::confirmed_open(
                    db, intent_id, &intent, &plugin, &tool.name, run_id,
                )?)
            } else {
                None
            };
            let id = plugin_id.to_owned();
            let key = tauri::async_runtime::spawn_blocking(move || keychain::load_or_create(&id))
                .await
                .map_err(|_| "Keychain worker interrupted")??;
            let current =
                crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool.name)?;
            if current == PermissionDecision::Deny {
                return Err("Secret storage permission denied".into());
            }
            if decision == PermissionDecision::Allow && current != PermissionDecision::Allow {
                return Err("Secret storage permission changed while opening".into());
            }
            binding.validate(db, plugin_id)?;
            let session = runtime.open(intent_id, &binding, key, once)?;
            let mut lease = lifecycle::OpeningLease {
                runtime: runtime.clone(),
                owner: session.owner.clone(),
                app: app.clone(),
                db: app.state::<crate::state::AppState>().db.clone(),
                committed: false,
            };
            if app.get_webview_window(&session.owner.window).is_none() {
                lease.committed = true;
                runtime.close_session(&session.id);
                return Err("Plugin window closed".into());
            }
            if let Err(e) = transport::ensure_server(app, &runtime).await {
                lease.committed = true;
                runtime.close_session(&session.id);
                runtime.idle().await;
                return Err(e);
            }
            let server = runtime.server.lock().await;
            if server.is_none() {
                drop(server);
                lease.committed = true;
                runtime.close_session(&session.id);
                runtime.idle().await;
                return Err("Secret storage transport unavailable".into());
            }
            lease.committed = true;
            if let Some(proof) = session.once.clone() {
                let owner = session.owner.clone();
                let sid = session.id.clone();
                let app = app.clone();
                let db = app.state::<crate::state::AppState>().db.clone();
                let rt = runtime.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(proof.remaining()).await;
                    lifecycle::close_session(&app, &db, &rt, &sid, &owner).await;
                });
            }
            Ok(
                json!({"sessionId":session.id,"pluginId":plugin_id,"runtime":"plugin-secret-storage","available":true}),
            )
        }
        Some("request") => {
            let ticket = args["invocationId"]
                .as_str()
                .ok_or("Missing secret storage invocation")?;
            let invocation = runtime
                .invocation(ticket)
                .ok_or("Secret storage invocation expired")?;
            if invocation.claimed.swap(true, Ordering::AcqRel) {
                return Err("Secret storage invocation already consumed".into());
            }
            *invocation.run.lock() = Some(run_id.into());
            let _operation = runtime
                .operations
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| "Secret storage is busy")?;
            let session = runtime.get(&invocation.session)?;
            validate_session(db, &session)?;
            let _guard = execution.ok_or("Secret storage requires plugin execution gate")?;
            let method = invocation.request["method"]
                .as_str()
                .ok_or("Invalid secret storage method")?
                .to_string();
            let reported_method = method.clone();
            let req = invocation.request.clone();
            let key = key_snapshot(&session)?;
            let plugin = session.owner.plugin.clone();
            let result = tauri::async_runtime::spawn_blocking(move || match method.as_str() {
                "encrypt" => {
                    let text = req["text"].as_str().ok_or("INVALID_REQUEST")?;
                    let data = crypto::encrypt(&key, &plugin, text)?;
                    Ok(json!({"data":data}))
                }
                "decrypt" => {
                    let data = req["data"].as_str().ok_or("INVALID_REQUEST")?;
                    let text = crypto::decrypt(&key, &plugin, data)?;
                    Ok(json!({"text":text}))
                }
                _ => Err("INVALID_REQUEST".into()),
            })
            .await
            .map_err(|_| "Crypto worker interrupted")?;
            let result = result.and_then(|value| {
                transport::validate_response_size(&value)?;
                Ok(value)
            });
            let result = runtime.finish_operation(&session, &invocation, result);
            if let Err(error) = result {
                return Err(error);
            }
            Ok(
                json!({"invocationId":ticket,"method":reported_method,"transportOnly":true,"summary":"Plugin secret storage operation completed"}),
            )
        }
        _ => Err("Unsupported secret storage operation".into()),
    }
}
pub(crate) async fn invalidate(app: &AppHandle, db: &Database, plugin: Option<&str>) {
    if let Ok(rt) = manager(app) {
        lifecycle::close(app, db, &rt, None, plugin, None, false).await
    }
}
pub(crate) async fn close_document(app: &AppHandle, id: &str) {
    lifecycle::close_document(app, id).await
}
pub(crate) async fn close_window(app: &AppHandle, label: &str) {
    if let (Ok(rt), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &rt, None, None, Some(label), false).await;
    }
}
pub(crate) async fn stop(app: &AppHandle) {
    if let (Ok(rt), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &rt, None, None, None, true).await
    }
}
#[cfg(feature = "legacy-node-smoke")]
pub(crate) async fn runtime_state(app: &AppHandle) -> Value {
    manager(app).map(|r|{let(s,i,v)=r.counts();json!({"secretStorageSessions":s,"secretStorageIntents":i,"secretStorageInvocations":v,"secretStorageTransport":r.server.try_lock().ok().is_some_and(|x|x.is_some())})}).unwrap_or_else(|_|json!({"secretStorageSessions":0,"secretStorageIntents":0,"secretStorageInvocations":0,"secretStorageTransport":false}))
}
