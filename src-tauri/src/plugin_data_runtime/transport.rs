//! Shared bounded loopback transport; the bearer endpoint stays private.
use super::{
    lifecycle::InvocationLease,
    operations,
    types::{credential, Invocation},
    Sessions,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};

pub(super) async fn ensure_server(app: &AppHandle, runtime: &Arc<Sessions>) -> Result<(), String> {
    let mut server = runtime.server.lock().await;
    if runtime.store.lock().sessions.is_empty() {
        return Err("Data opening was cancelled".into());
    }
    if server.is_none() {
        *server = Some(
            crate::plugin_loopback::BridgeServer::start_scoped(
                Arc::new(Router {
                    app: app.clone(),
                    runtime: runtime.clone(),
                }),
                "data",
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
            .ok_or("Plugin data authorization required; explicitly reopen the plugin")?;
        let state = self.app.state::<crate::state::AppState>();
        if let Err(error) = super::validate_session(&state.db, &session) {
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
        let method = operations::validate(&payload)?.to_owned();
        let ticket = credential();
        let invocation = Arc::new(Invocation {
            session: session.id.clone(),
            request: payload,
            claimed: AtomicBool::new(false),
            dynamic_features_changed: AtomicBool::new(false),
            run: parking_lot::Mutex::new(None),
            result: parking_lot::Mutex::new(None),
        });
        {
            let mut store = self.runtime.store.lock();
            if !store.sessions.contains_key(&session.id) {
                return Err("Data session closed".into());
            }
            if store.invocations.len() >= 32 {
                return Err("Too many pending plugin data requests".into());
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
            if let Some(events) = self
                .app
                .try_state::<Arc<super::web_storage_events::WebStorageEvents>>()
            {
                events.abandon(&ticket);
            }
            return Err("Data session closed".into());
        }
        if method == "webStorage.event" && super::validate_session(&state.db, &session).is_err() {
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
            return Err("Data session closed".into());
        }
        let result = invocation.result.lock().take();
        if super::dynamic_features::should_refresh(
            &method,
            !audit.is_error,
            result.as_ref(),
            invocation.dynamic_features_changed.load(Ordering::Acquire),
        ) {
            // Closing waits for this short guard; no store access is nested.
            let active = session.active.lock();
            if *active && super::validate_session(&state.db, &session).is_ok() {
                let _ = self.app.emit("builtin-plugins-loaded", ());
                crate::plugin_inventory::events::notify(&self.app);
            }
        }
        self.publish_web_storage_mutation(
            &session,
            &method,
            &ticket,
            !audit.is_error,
            result.as_ref(),
        );
        // Executed logical conflicts remain official API values even though the
        // durable task is Failed. An authorization rejection has no private result.
        if let Some(result) = result {
            return result;
        }
        if audit.is_error {
            return Err(
                "Plugin data request rejected; explicitly reopen after authorization".into(),
            );
        }
        Err("Plugin data request produced no result".into())
    }
}

impl Router {
    fn publish_web_storage_mutation(
        &self,
        session: &Arc<super::types::Session>,
        method: &str,
        invocation_id: &str,
        task_succeeded: bool,
        result: Option<&Result<Value, String>>,
    ) {
        let Some(events) = self
            .app
            .try_state::<Arc<super::web_storage_events::WebStorageEvents>>()
        else {
            return;
        };
        let mutation = matches!(
            method,
            "webStorage.setItem" | "webStorage.removeItem" | "webStorage.clear"
        );
        let changed = result
            .and_then(|result| result.as_ref().ok())
            .is_some_and(|value| {
                value.get("changed") == Some(&Value::Bool(true))
                    && value.get("error") != Some(&Value::Bool(true))
            });
        if !mutation || !task_succeeded || !changed {
            events.abandon(invocation_id);
            return;
        }
        let writer_current = self.runtime.get(&session.id).is_ok()
            && *session.active.lock()
            && session
                .document
                .as_ref()
                .is_none_or(|document| document.is_active());
        if !writer_current {
            events.abandon(invocation_id);
            return;
        }
        let context = super::web_storage::ExecutionContext {
            app: self.app.clone(),
            runtime: self.runtime.clone(),
            session: session.clone(),
            invocation_id: invocation_id.into(),
        };
        let database = self.app.state::<crate::state::AppState>().db.clone();
        let current_sessions =
            super::web_storage::authorized_session_ids(&context, &database, &session.owner.plugin);
        let Some((event_id, targets)) = events.publish(invocation_id, &current_sessions) else {
            return;
        };
        for target in targets {
            let metadata = json!({
                "pluginId": target.plugin_id,
                "instanceId": target.instance_id,
                "eventId": event_id,
            });
            if self
                .app
                .emit_to(
                    &target.window,
                    super::web_storage_events::EVENT_NAME,
                    metadata,
                )
                .is_err()
            {
                events.emit_mismatch();
            }
        }
    }
}
