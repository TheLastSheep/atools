//! Shared bounded loopback transport; the bearer endpoint stays private.
use super::{
    lifecycle::InvocationLease,
    types::{credential, Invocation},
    Sessions,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc};
use tauri::{AppHandle, Manager};

pub(super) async fn ensure_server(app: &AppHandle, runtime: &Arc<Sessions>) -> Result<(), String> {
    let mut server = runtime.server.lock().await;
    if runtime.store.lock().sessions.is_empty() {
        return Err("Dialog opening was cancelled".into());
    }
    if server.is_none() {
        *server = Some(
            crate::plugin_loopback::BridgeServer::start_scoped(
                Arc::new(Router {
                    app: app.clone(),
                    runtime: runtime.clone(),
                }),
                "dialog",
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
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    fn observe_transport(&self, event: crate::plugin_loopback::TransportObservation) {
        use super::observations::{note, Event};
        use crate::plugin_loopback::TransportObservation as Transport;
        note(match event {
            Transport::AuthenticationRejected
            | Transport::OriginRejected
            | Transport::PreflightAccepted => return,
            Transport::RequestStart => Event::RequestStart,
            Transport::ReadEof => Event::ReadEof,
            Transport::ReadExtraBytes => Event::ReadExtraBytes,
            Transport::ReadErrorKind(kind) => Event::ReadError(kind),
            Transport::HandlerComplete => Event::HandlerComplete,
        });
    }
    fn authenticated(&self, token: &str) -> bool {
        self.runtime.by_token(token).is_some()
    }
    fn origin_policy(&self, token: &str) -> crate::plugin_loopback::OriginPolicy {
        self.runtime
            .by_token(token)
            .map_or(crate::plugin_loopback::OriginPolicy::Deny, |session| {
                session
                    .document
                    .as_ref()
                    .map_or(crate::plugin_loopback::OriginPolicy::Opaque, |d| {
                        d.origin_policy()
                    })
            })
    }
    async fn handle(&self, token: &str, payload: Value) -> Result<Value, String> {
        let session = self
            .runtime
            .by_token(token)
            .ok_or("Plugin dialog authorization required; explicitly reopen the plugin")?;
        let state = self.app.state::<crate::state::AppState>();
        if let Err(error) = super::validate_session(&state.db, &session) {
            super::observations::note(super::observations::Event::ValidationFailed);
            super::lifecycle::close(
                &self.app,
                &state.db,
                &self.runtime,
                Some(&session.owner),
                None,
                None,
                false,
            )
            .await;
            return Err(error);
        }
        let fields = payload.as_object().ok_or("Invalid dialog request")?;
        if fields.len() != 2
            || payload["method"] != session.access.method()
            || !fields.contains_key("options")
        {
            return Err("Invalid dialog request identity".into());
        }
        super::options::Options::parse(&payload["options"], session.access)?;
        let method = session.access.method();
        let ticket = credential();
        let invocation = Arc::new(Invocation {
            session: session.id.clone(),
            request: payload,
            claimed: AtomicBool::new(false),
            cancel: super::native::Cancellation::default(),
            run: parking_lot::Mutex::new(None),
            result: parking_lot::Mutex::new(None),
        });
        {
            let mut store = self.runtime.store.lock();
            if !store.sessions.contains_key(&session.id) {
                return Err("Dialog session closed".into());
            }
            if store.invocations.len() >= 4
                || store.invocations.values().any(|i| {
                    store
                        .sessions
                        .get(&i.session)
                        .is_some_and(|s| s.owner.window == session.owner.window)
                })
            {
                return Err("Too many pending plugin dialog requests".into());
            }
            store.invocations.insert(ticket.clone(), invocation.clone());
        }
        let mut lease = InvocationLease {
            runtime: self.runtime.clone(),
            ticket: ticket.clone(),
            app: self.app.clone(),
            db: state.db.clone(),
            completed: false,
        };
        let audit=crate::agent_tools::call_tool_with_audit(&self.app,&state.db,"atools-ui",&session.tool,
            json!({"operation":"request","sessionId":session.id,"invocationId":ticket,"method":method}),true).await;
        lease.completed = true;
        if self.runtime.get(&session.id).is_err()
            || session.document.as_ref().is_some_and(|d| !d.is_active())
        {
            return Err("Dialog session closed".into());
        }
        let result = invocation.result.lock().take();
        // A private selection never enters the durable TaskRun output. An
        // authorization rejection has no private result to deliver.
        if let Some(result) = result {
            return result;
        }
        if audit.is_error {
            return Err(
                "Plugin dialog request rejected; explicitly reopen after authorization".into(),
            );
        }
        Err("Plugin dialog request produced no result".into())
    }
}
