//! Ordinary 8-second scoped loopback transport; requests retain only fixed tickets.
use super::{
    lifecycle, same_token,
    sessions::{self, Invocation, Sessions},
    validate_session,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc};
use tauri::{AppHandle, Manager};
pub(super) fn parse_request(payload: &Value) -> Result<(), String> {
    let fields = payload.as_object().ok_or("Invalid display request")?;
    if fields.len() != 1 || payload["operation"] != "snapshot" {
        return Err("Unsupported display request".into());
    }
    Ok(())
}
pub(super) async fn ensure_server(app: &AppHandle, runtime: &Arc<Sessions>) -> Result<(), String> {
    let mut server = runtime.server.lock().await;
    if runtime.store.lock().sessions.is_empty() {
        return Err("Display opening was cancelled".into());
    }
    if server.is_none() {
        *server = Some(
            crate::plugin_loopback::BridgeServer::start_scoped(
                Arc::new(Router {
                    app: app.clone(),
                    runtime: runtime.clone(),
                }),
                "display",
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
            .ok_or("Display session closed")?;
        let state = self.app.state::<crate::state::AppState>();
        if let Err(error) = validate_session(&state.db, &session) {
            self.runtime.remove(&session.id).await;
            return Err(error);
        }
        // Endpoint scope is fixed; parse before retaining any ephemeral payload.
        parse_request(&payload)?;
        let ticket = sessions::credential();
        let invocation = Arc::new(Invocation {
            session: session.id.clone(),
            claimed: AtomicBool::new(false),
            run: parking_lot::Mutex::new(None),
            result: parking_lot::Mutex::new(None),
        });
        {
            let mut store = self.runtime.store.lock();
            if store.invocations.len() >= 32 {
                return Err("Too many display requests".into());
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
            json!({"operation":"request","sessionId":session.id,"invocationId":ticket}),
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
                .unwrap_or_else(|| "Display request was rejected".into()));
        }
        result.ok_or_else(|| "Display request produced no result".to_string())?
    }
}
