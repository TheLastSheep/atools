//! Authorized Node module primitives for local WebView preloads.
//! All executable operations use the same permission/TaskRun pipeline as Agent tools.
pub mod commands;
mod http;
mod intents;
mod inventory;
mod lifecycle;
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) mod local_archive_verification;
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) mod local_package_verification;
mod native_filesystem_request;
mod native_image;
mod native_image_request;
mod native_image_session;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) mod native_image_startup_measurement;
mod native_image_worker;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) mod native_node_startup_fixture;
mod node_entry;
mod node_selected_entry;
#[cfg(test)]
mod node_selected_entry_tests;
pub(crate) mod node_startup_diagnostic;
pub mod permission_context;
mod privacy;
pub mod registry;
mod session_process_budget;
#[cfg(all(test, unix))]
mod session_process_budget_tests;
mod sessions;
mod types;
pub async fn invalidate(app: &tauri::AppHandle, db: &atools_core::Database, plugin: Option<&str>) {
    if let Some(hints) = app.try_state::<std::sync::Arc<node_entry::Hints>>() {
        if let Some(plugin) = plugin {
            hints.invalidate(plugin);
        }
    }
    crate::plugin_main_push::invalidate(app, db, plugin);
    crate::plugin_dialog_runtime::invalidate(app, db, plugin).await;
    crate::plugin_system_paths::invalidate(app, db, plugin);
    crate::plugin_display_runtime::invalidate(app, db, plugin).await;
    crate::plugin_data_runtime::invalidate(app, db, plugin).await;
    crate::plugin_secret_storage_runtime::invalidate(app, db, plugin).await;
    crate::plugin_file_drop::invalidate(app, plugin).await;
    crate::plugin_ai_runtime::invalidate(app, plugin).await;
    if let Err(error) = crate::plugin_background_runtime::invalidate(app, db, plugin).await {
        tracing::error!(%error, "Background plugin invalidation was incomplete");
    }
    lifecycle::invalidate(app, db, plugin).await;
}

pub(crate) async fn close_plugin_owner(
    app: &tauri::AppHandle,
    db: &atools_core::Database,
    owner: &str,
    plugin_id: &str,
) -> Result<(), String> {
    lifecycle::close_owner_strict(app, db, owner, Some(plugin_id)).await
}
pub use privacy::validate_private_request;
#[cfg(test)]
mod document_tests;
#[cfg(test)]
mod http_tests;
#[cfg(all(test, unix))]
mod session_closing_tests;
#[cfg(all(test, unix))]
mod session_startup_abort_tests;
#[cfg(test)]
mod session_tests;
use async_trait::async_trait;
use atools_core::agent::{PermissionDecision, ToolDefinition};
use atools_core::db::Database;
use atools_core::task_run::{TaskIssue, TaskRunStatus};
pub use commands::install_manager;
pub(crate) use inventory::inventory_snapshot;
use serde_json::{json, Value};
pub use sessions::Sessions;
use sessions::{Invocation, Session};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

const METHODS: &[&str] = &[
    "require",
    "call",
    "get",
    "set",
    "construct",
    "poll",
    "pollPromise",
    "pollPromises",
    "release",
    "readPngPath",
    "readTextPath",
    "writeTextPath",
    "nativeImageTransform",
];
fn manager(app: &AppHandle) -> Arc<Sessions> {
    app.state::<Arc<Sessions>>().inner().clone()
}
fn uses_task_run(method: &str) -> bool {
    METHODS.contains(&method)
        && !matches!(method, "poll" | "pollPromise" | "pollPromises" | "release")
}
fn validate_session(db: &Database, session: &Session) -> Result<(), String> {
    if session.is_closing() {
        return Err("Node session is closing".into());
    }
    if session.document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Plugin document closed".into());
    }
    if session.runtime.status() != atools_plugin::sidecar::SidecarStatus::Running {
        return Err("Node process stopped; reopen the plugin".into());
    }
    let plugin = db
        .get_plugin(&session.plugin_id)
        .map_err(|_| "Plugin no longer exists")?;
    if !plugin.enabled || plugin.path != session.plugin_path || plugin.version != session.version {
        return Err("Plugin was disabled or updated; reopen it".into());
    }
    if crate::agent_tools::permission_decision_for_tool(db, &session.client, &session.tool)?
        == PermissionDecision::Deny
    {
        return Err("Node access was revoked by the permission policy".into());
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
) -> Result<Value, node_startup_diagnostic::LegacyRuntimeError> {
    let plugin_id = tool.plugin_id.as_deref().ok_or("Missing plugin identity")?;
    let plugin = db.get_plugin(plugin_id).map_err(|e| e.to_string())?;
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    if tool.name != registry::tool_name(plugin_id) {
        return Err("Invalid Node capability identity".into());
    }
    let runtime = manager(app);
    match args
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Missing Node operation")?
    {
        "open" => {
            let intent = runtime.take_intent(
                args.get("intentId").and_then(Value::as_str),
                client,
                plugin_id,
            )?;
            *intent.run_id.lock() = Some(run_id.to_owned());
            let validation = intent
                .selected
                .as_ref()
                .map_or(Ok(()), |selected| selected.validate_revision(db, &plugin));
            let opened = match validation {
                Ok(()) => runtime.open(&plugin, tool.name.clone(), intent).await,
                Err(error) => Err(error.into()),
            };
            if let Some(id) = args.get("intentId").and_then(Value::as_str) {
                runtime.intents.lock().remove(id);
            }
            let session = opened?;
            let started = ensure_server(app, &runtime).await;
            if let Err(error) = started {
                runtime.remove(&session.id).await;
                return Err(error.into());
            }
            // Credentials deliberately stay out of TaskRun, audit, and MCP results.
            Ok(
                json!({"sessionId":session.id,"pluginId":plugin_id,"runtime":"node-modules","isolatedProcess":true}),
            )
        }
        "request" => {
            let id = args
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or("Missing Node session")?;
            let session = runtime.get(id)?;
            if session.plugin_id != plugin_id || session.client != client {
                return Err("Node session identity mismatch".into());
            }
            validate_session(db, &session)?;
            if let Some(ticket) = args.get("invocationId").and_then(Value::as_str) {
                let invocation = runtime
                    .invocations
                    .lock()
                    .get(ticket)
                    .cloned()
                    .ok_or("Node invocation expired")?;
                if invocation.session_id != id {
                    return Err("Node invocation identity mismatch".into());
                }
                if invocation
                    .claimed
                    .swap(true, std::sync::atomic::Ordering::AcqRel)
                {
                    return Err("Node invocation is already being processed".into());
                }
                *invocation.run_id.lock() = Some(run_id.into());
                let result = if invocation.request.get("method").and_then(Value::as_str)
                    == Some("nativeImageTransform")
                {
                    native_image_request::handle(db, &session, &invocation.request).await
                } else if matches!(
                    invocation.request.get("method").and_then(Value::as_str),
                    Some("readTextPath" | "writeTextPath")
                ) {
                    native_filesystem_request::handle(db, &session, &invocation.request).await
                } else {
                    request(&session, &invocation.request).await
                };
                let response_kind = result
                    .as_ref()
                    .ok()
                    .and_then(|value| value.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("response")
                    .to_string();
                let error = result.as_ref().err().cloned();
                *invocation.result.lock() = Some(result);
                if error.is_some() {
                    return Err("Node module request failed; private details were returned to the active plugin".into());
                }
                Ok(
                    json!({"invocationId":ticket,"method":invocation.request.get("method"),"resultKind":response_kind,"transportOnly":true,
                    "summary":"Node module invocation returned; asynchronous callbacks and business results require separate validation"}),
                )
            } else {
                Err("Node primitives require an active plugin transport ticket; use declared structured plugin capabilities".into())
            }
        }
        "close" => {
            let id = args
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or("Missing Node session")?;
            let session = runtime.get(id)?;
            if session.plugin_id != plugin_id || session.client != client {
                return Err("Node session identity mismatch".into());
            }
            cancel_inflight(db, &runtime, id);
            runtime.remove(id).await;
            Ok(json!({"closed":true}))
        }
        _ => Err("Unsupported Node operation".into()),
    }
}
async fn request(session: &Session, request: &Value) -> Result<Value, String> {
    if session.document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Plugin document closed".into());
    }
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or("Missing Node method")?;
    if !METHODS.contains(&method) {
        return Err("Unsupported Node module method".into());
    }
    if matches!(
        method,
        "nativeImageTransform" | "readTextPath" | "writeTextPath"
    ) {
        return Err("Native requests require the authorized host path".into());
    }
    session
        .runtime
        .request(method, request.get("params").cloned().unwrap_or(json!({})))
        .await
        .map_err(|e| e.to_string())
}
async fn ensure_server(app: &AppHandle, runtime: &Arc<Sessions>) -> Result<(), String> {
    let mut server = runtime.server.lock().await;
    if runtime.sessions.read().is_empty() {
        return Err("Plugin opening was cancelled".into());
    }
    if server.is_none() {
        *server = Some(
            http::BridgeServer::start(Arc::new(Router {
                app: app.clone(),
                runtime: runtime.clone(),
            }))
            .await?,
        );
    }
    Ok(())
}
struct Router {
    app: AppHandle,
    runtime: Arc<Sessions>,
}
#[async_trait]
impl http::RequestHandler for Router {
    fn authenticated(&self, token: &str) -> bool {
        self.runtime.by_token(token).is_some()
    }
    fn origin_policy(&self, token: &str) -> crate::plugin_loopback::OriginPolicy {
        self.runtime
            .by_token(token)
            .map_or(crate::plugin_loopback::OriginPolicy::Deny, |s| {
                s.document
                    .as_ref()
                    .map_or(crate::plugin_loopback::OriginPolicy::Opaque, |d| {
                        d.origin_policy()
                    })
            })
    }
    async fn handle(&self, token: &str, payload: Value) -> Result<Value, String> {
        let session = self
            .runtime
            .sessions
            .read()
            .values()
            .find(|session| same_token(&session.token, token))
            .cloned()
            .ok_or("Node session closed")?;
        let state = self.app.state::<crate::state::AppState>();
        if let Err(error) = validate_session(&state.db, &session) {
            cancel_inflight(&state.db, &self.runtime, &session.id);
            self.runtime.remove(&session.id).await;
            return Err(error);
        }
        let method = payload
            .get("method")
            .and_then(Value::as_str)
            .ok_or("Missing method")?;
        if !METHODS.contains(&method) {
            return Err("Unsupported Node method".into());
        }
        if !uses_task_run(method) {
            // Transport observation and handle cleanup do not create a TaskRun per timer tick.
            let result = request(&session, &payload).await;
            validate_session(&state.db, &session)?;
            self.runtime.get(&session.id)?;
            return result;
        }
        let ticket = sessions::credential();
        let invocation = Arc::new(Invocation {
            session_id: session.id.clone(),
            request: payload,
            claimed: std::sync::atomic::AtomicBool::new(false),
            run_id: parking_lot::Mutex::new(None),
            result: parking_lot::Mutex::new(None),
        });
        {
            let mut pending = self.runtime.invocations.lock();
            if pending.len() >= 32 {
                return Err("Too many in-flight Node requests".into());
            }
            pending.insert(ticket.clone(), invocation.clone());
        }
        let mut lease = lifecycle::InvocationLease {
            runtime: self.runtime.clone(),
            db: state.db.clone(),
            ticket: ticket.clone(),
            session_id: session.id.clone(),
            completed: false,
        };
        let audit=crate::agent_tools::call_tool_with_audit(&self.app,&state.db,&session.client,&session.tool,
            json!({"operation":"request","sessionId":session.id,"invocationId":ticket,"method":invocation.request.get("method")}),true).await;
        lease.completed = true;
        let result = invocation.result.lock().take();
        validate_session(&state.db, &session)?;
        self.runtime.get(&session.id)?;
        if audit.is_error {
            return Err(result
                .and_then(Result::err)
                .unwrap_or_else(|| "Node request failed; see the task result for details".into()));
        }
        result.ok_or_else(|| "Node invocation did not produce a result".to_string())?
    }
}
fn same_token(expected: &str, supplied: &str) -> bool {
    expected.len() == supplied.len()
        && expected
            .bytes()
            .zip(supplied.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}
pub fn cancel_inflight(db: &Database, runtime: &Sessions, session_id: &str) {
    if let Some(session) = runtime.sessions.read().get(session_id) {
        session.mark_closing();
    }
    let ids: Vec<_> = runtime
        .invocations
        .lock()
        .values()
        .filter(|item| item.session_id == session_id)
        .filter_map(|item| item.run_id.lock().clone())
        .collect();
    for id in ids {
        if let Ok(Some(mut run)) = db.get_task_run(&id) {
            if !run.status.is_terminal() {
                run.errors.push(TaskIssue::error(
                    "node_session_closed",
                    "Node session closed during this invocation",
                ));
                run.summary = Some("Node invocation cancelled because the plugin closed".into());
                let _ = run.transition(TaskRunStatus::Cancelled);
                let _ = db.finish_running_task_run(&run);
            }
        }
    }
}
pub(crate) async fn close_document(app: &AppHandle, page_id: &str) {
    let Some(runtime) = app.try_state::<Arc<Sessions>>().map(|s| s.inner().clone()) else {
        return;
    };
    let state = app.state::<crate::state::AppState>();
    for (owner, plugin) in runtime.document_owners(page_id) {
        lifecycle::close_document_owner(app, &state.db, &owner, &plugin, page_id).await;
    }
}
pub async fn close_window(app: &AppHandle, label: &str) {
    let runtime = manager(app);
    let prefix = format!("window:{label}:");
    let db = &app.state::<crate::state::AppState>().db;
    let ids: Vec<_> = runtime
        .sessions
        .read()
        .values()
        .filter(|session| session.owner.starts_with(&prefix))
        .map(|session| session.id.clone())
        .collect();
    for id in ids {
        cancel_inflight(db, &runtime, &id);
    }
    let mut owners: std::collections::HashSet<_> = runtime
        .sessions
        .read()
        .values()
        .filter(|s| s.owner.starts_with(&prefix))
        .map(|s| s.owner.clone())
        .collect();
    owners.extend(
        runtime
            .intents
            .lock()
            .values()
            .filter(|s| s.owner.starts_with(&prefix))
            .map(|s| s.owner.clone()),
    );
    owners.extend(
        runtime
            .openings
            .lock()
            .keys()
            .filter(|s| s.starts_with(&prefix))
            .cloned(),
    );
    for owner in owners {
        lifecycle::close_owner(app, db, &owner, None).await;
    }
}
