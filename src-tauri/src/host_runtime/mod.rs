//! Private clipboard host primitives, using the shared capability/TaskRun gate.
mod clipboard;
#[cfg(test)]
mod clipboard_buffer_tests;
mod clipboard_formats;
#[cfg(test)]
mod clipboard_formats_tests;
mod clipboard_html;
mod clipboard_image;
#[cfg(test)]
mod clipboard_image_tests;
mod clipboard_image_write;
#[cfg(test)]
mod clipboard_image_write_tests;
mod clipboard_paste;
#[cfg(test)]
mod clipboard_paste_tests;
pub mod commands;
mod copied_files;
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub mod desktop_smoke;
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
mod desktop_smoke_files_flow;
#[cfg(test)]
mod document_tests;
#[cfg(test)]
mod files_tests;
#[cfg(test)]
mod history_media_tests;
#[cfg(test)]
mod history_session_tests;
#[cfg(test)]
mod history_tests;
mod lifecycle;
mod once_authorization;
#[cfg(test)]
mod once_authorization_tests;
mod privacy;
pub mod registry;
mod request;
mod sessions;
mod target_activation;
#[cfg(test)]
mod tests;
use async_trait::async_trait;
use atools_core::{
    agent::{PermissionDecision, ToolDefinition},
    db::Database,
};
use once_authorization::OnceAuthorization;
pub use privacy::validate_private_request;
use serde_json::{json, Value};
pub use sessions::Sessions;
use sessions::{Invocation, Session};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};

pub fn manager(app: &AppHandle) -> Result<Arc<Sessions>, String> {
    app.try_state::<Arc<Sessions>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Clipboard host is unavailable".into())
}
pub fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Sessions::new(Arc::new(
        clipboard::SystemClipboard(app.clone()),
    ))));
}
pub fn capture_external_target_before_show() {
    let _ = clipboard_paste::capture_external_target_before_show();
}
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub fn install_isolated_manager(app: &AppHandle) {
    app.manage(Arc::new(Sessions::new(Arc::new(
        clipboard::NamedClipboard(format!("dev.atools.host-smoke.{}", uuid::Uuid::new_v4())),
    ))));
}
fn validate_session(db: &Database, session: &Session) -> Result<(), String> {
    if session.document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Plugin document closed".into());
    }
    let plugin = db
        .get_plugin(&session.plugin)
        .map_err(|_| "Plugin no longer exists")?;
    if !plugin.enabled || plugin.path != session.path || plugin.version != session.version {
        return Err("Plugin was disabled or updated; reopen it".into());
    }
    match crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &session.tool)? {
        PermissionDecision::Deny => return Err("Clipboard access was denied or disabled".into()),
        PermissionDecision::Allow => {}
        PermissionDecision::Confirm => {
            if !session
                .once_authorization
                .as_ref()
                .is_some_and(|proof| proof.permits(db, session))
            {
                return Err("Clipboard access was revoked".into());
            }
        }
    }
    Ok(())
}
fn execute_sync_request(
    db: &Database,
    session: &Session,
    request: &request::ClipboardRequest,
    backend: &dyn clipboard::ClipboardAccess,
) -> Result<Value, String> {
    let active = session.active.lock();
    if !*active {
        return Err("Clipboard session closed".into());
    }
    validate_session(db, session)?;
    request.execute_host(session.access, backend, db)
}
fn claim_invocation(invocation: &Invocation) -> Result<(), String> {
    if invocation.claimed.swap(true, Ordering::AcqRel) {
        Err("Clipboard invocation already consumed".into())
    } else {
        Ok(())
    }
}
fn invocation_audit_args(session_id: &str, ticket: &str) -> Value {
    json!({"operation":"request","sessionId":session_id,"invocationId":ticket})
}
fn invocation_audit_summary(ticket: &str, access: registry::Access) -> Value {
    json!({"invocationId":ticket,"access":access,"transportOnly":true,"summary":"Native clipboard operation completed; contents are private"})
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
    let access = registry::access_for(tool)?;
    let plugin = db
        .get_plugin(tool.plugin_id.as_deref().ok_or("Missing plugin identity")?)
        .map_err(|_| "Plugin unavailable")?;
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let runtime = manager(app)?;
    match args.get("operation").and_then(Value::as_str) {
        Some("open") => {
            let intent = args["intentId"]
                .as_str()
                .ok_or("Missing clipboard intent")?;
            let decision =
                crate::agent_tools::permission_decision_for_tool(db, client, &tool.name)?;
            if decision == PermissionDecision::Deny {
                return Err("Clipboard access was denied or disabled".into());
            }
            let once_authorization = if decision == PermissionDecision::Confirm {
                let intent_state = runtime.store.lock();
                let pending_intent = intent_state
                    .intents
                    .get(intent)
                    .cloned()
                    .ok_or("Clipboard authorization expired")?;
                drop(intent_state);
                Some(OnceAuthorization::for_confirmed_open(
                    db,
                    intent,
                    &pending_intent,
                    &plugin,
                    access,
                    &tool.name,
                    run_id,
                )?)
            } else {
                None
            };
            let session = runtime.open_with_once_authorization(
                intent,
                &plugin,
                access,
                once_authorization,
            )?;
            if let Err(error) = ensure_server(app, &runtime).await {
                runtime.remove(&session.id).await;
                return Err(error);
            }
            // Opening is scope-only. Neither transport credentials nor clipboard
            // contents appear in this durable result.
            Ok(
                json!({"sessionId":session.id,"pluginId":plugin.id,"access":access,"runtime":"host-clipboard"}),
            )
        }
        Some("request") => {
            let ticket = args["invocationId"]
                .as_str()
                .ok_or("Missing clipboard ticket")?;
            let invocation = runtime
                .store
                .lock()
                .invocations
                .get(ticket)
                .cloned()
                .ok_or("Clipboard invocation expired")?;
            claim_invocation(&invocation)?;
            *invocation.run.lock() = Some(run_id.into());
            let request = invocation
                .request
                .lock()
                .take()
                .ok_or("Clipboard invocation already consumed")?;
            let session = runtime.get(&invocation.session)?;
            let result = if request.is_image_read() {
                let allowed = {
                    let active = session.active.lock();
                    *active && validate_session(db, &session).is_ok()
                };
                if !allowed {
                    Err("Clipboard session closed or access revoked".into())
                } else {
                    let worker_session = session.clone();
                    let worker_db = db.clone();
                    let backend = runtime.clipboard.clone();
                    let result = clipboard_image::run_system_limited(move |cancelled| {
                        if cancelled.load(Ordering::Acquire) {
                            return Err("Clipboard image request was cancelled".into());
                        }
                        if !*worker_session.active.lock()
                            || validate_session(&worker_db, &worker_session).is_err()
                        {
                            return Err("Clipboard session closed or access revoked".into());
                        }
                        if cancelled.load(Ordering::Acquire) {
                            return Err("Clipboard image request was cancelled".into());
                        }
                        clipboard_image::exact_read_cancellable(
                            backend.as_ref(),
                            Some(cancelled.as_ref()),
                        )
                    })
                    .await;
                    match result {
                        Ok(value) => {
                            let active = session.active.lock();
                            if !*active || validate_session(db, &session).is_err() {
                                Err("Clipboard session closed or access revoked".into())
                            } else {
                                Ok(value)
                            }
                        }
                        Err(error) => Err(error),
                    }
                }
            } else if request.is_image_write() {
                let image_request = match request {
                    request::ClipboardRequest::WriteImage(image) => image,
                    _ => unreachable!("image-write predicate matched another request"),
                };
                let allowed = {
                    let active = session.active.lock();
                    *active && validate_session(db, &session).is_ok()
                };
                if !allowed {
                    Err("Clipboard session closed or access revoked".into())
                } else {
                    let worker_session = session.clone();
                    let worker_db = db.clone();
                    let backend = runtime.clipboard.clone();
                    let result = clipboard_image::run_system_limited(move |cancelled| {
                        if cancelled.load(Ordering::Acquire) {
                            return Err("Clipboard image request was cancelled".into());
                        }
                        let decoded = clipboard_image_write::decode(&image_request)?;
                        if cancelled.load(Ordering::Acquire) {
                            return Err("Clipboard image request was cancelled".into());
                        }
                        // Hold the generation lock through the synchronous write so
                        // close/revoke cannot start a later operation in this session.
                        let active = worker_session.active.lock();
                        clipboard_image_write::write_decoded(
                            backend.as_ref(),
                            decoded,
                            cancelled.as_ref(),
                            || *active && validate_session(&worker_db, &worker_session).is_ok(),
                        )?;
                        Ok(Value::Null)
                    })
                    .await;
                    match result {
                        Ok(value) => {
                            let active = session.active.lock();
                            if !*active || validate_session(db, &session).is_err() {
                                Err("Clipboard session closed or access revoked".into())
                            } else {
                                Ok(value)
                            }
                        }
                        Err(error) => Err(error),
                    }
                }
            } else if request.is_content_write() {
                let (content, paste) = match request {
                    request::ClipboardRequest::ContentWrite(content) => (content, false),
                    request::ClipboardRequest::Paste(content) => (content, true),
                    _ => unreachable!("content-write predicate matched another request"),
                };
                clipboard_paste::execute_content(
                    app.clone(),
                    db.clone(),
                    runtime.clone(),
                    session.clone(),
                    runtime.clipboard.clone(),
                    content,
                    paste,
                )
                .await
            } else {
                execute_sync_request(db, &session, &request, runtime.clipboard.as_ref())
            };
            let failed = result.is_err();
            *invocation.result.lock() = Some(result);
            if failed {
                return Err(
                    "Clipboard operation failed; private details were returned to the plugin"
                        .into(),
                );
            }
            Ok(invocation_audit_summary(ticket, access))
        }
        _ => Err("Unsupported clipboard operation".into()),
    }
}
async fn ensure_server(app: &AppHandle, runtime: &Arc<Sessions>) -> Result<(), String> {
    let mut server = runtime.server.lock().await;
    if runtime.store.lock().sessions.is_empty() {
        return Err("Clipboard opening was cancelled".into());
    }
    if server.is_none() {
        *server = Some(
            crate::plugin_loopback::BridgeServer::start_scoped(
                Arc::new(Router {
                    app: app.clone(),
                    runtime: runtime.clone(),
                }),
                "host",
            )
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
impl crate::plugin_loopback::RequestHandler for Router {
    fn max_request_body_bytes(&self, token: &str) -> Option<usize> {
        self.runtime
            .by_token(token)
            .filter(|session| {
                matches!(
                    session.access,
                    registry::Access::ImageWrite
                        | registry::Access::ContentWrite
                        | registry::Access::Paste
                )
            })
            .map(|_| clipboard_image_write::MAX_REQUEST_ENVELOPE_BYTES)
    }
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
            .store
            .lock()
            .sessions
            .values()
            .find(|s| same_token(&s.token, token))
            .cloned()
            .ok_or("Clipboard session closed")?;
        let state = self.app.state::<crate::state::AppState>();
        if let Err(error) = validate_session(&state.db, &session) {
            self.runtime.remove(&session.id).await;
            return Err(error);
        }
        // Endpoint scope is fixed; parse before retaining any ephemeral payload.
        let request = request::ClipboardRequest::parse(session.access, &payload)?;
        let ticket = sessions::credential();
        let invocation = Arc::new(Invocation {
            session: session.id.clone(),
            request: parking_lot::Mutex::new(Some(request)),
            claimed: AtomicBool::new(false),
            run: parking_lot::Mutex::new(None),
            result: parking_lot::Mutex::new(None),
        });
        {
            let mut store = self.runtime.store.lock();
            if store.invocations.len() >= 32 {
                return Err("Too many clipboard requests".into());
            }
            store.invocations.insert(ticket.clone(), invocation.clone());
        }
        let mut lease = lifecycle::InvocationLease {
            runtime: self.runtime.clone(),
            db: state.db.clone(),
            ticket: ticket.clone(),
            completed: false,
        };
        let audit = crate::agent_tools::call_tool_with_audit(
            &self.app,
            &state.db,
            "atools-ui",
            &session.tool,
            invocation_audit_args(&session.id, &ticket),
            true,
        )
        .await;
        lease.completed = true;
        let result = invocation.result.lock().take();
        validate_session(&state.db, &session)?;
        self.runtime.get(&session.id)?;
        if audit.is_error {
            return Err(result
                .and_then(Result::err)
                .unwrap_or_else(|| "Clipboard request was rejected".into()));
        }
        result.ok_or_else(|| "Clipboard request produced no result".to_string())?
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
        let _ = app.emit("host-clipboard://invalidated", json!({"pluginId": plugin}));
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
