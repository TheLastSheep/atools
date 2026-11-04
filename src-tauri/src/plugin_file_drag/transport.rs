//! Scoped loopback request handling with a short native-start acknowledgement.
use super::{
    lifecycle, registry, request,
    types::{credential, Invocation, START_ACK_TIMEOUT},
    Sessions,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU8},
    Arc,
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

pub(super) async fn ensure_server(app: &AppHandle, runtime: &Arc<Sessions>) -> Result<(), String> {
    let _control = runtime.control.lock().await;
    let mut server = runtime.server.lock().await;
    let has_session = runtime
        .store
        .lock()
        .sessions
        .values()
        .any(|session| session.valid());
    if !has_session {
        return Err("File-drag opening was cancelled".into());
    }
    if server.is_none() {
        *server = Some(
            crate::plugin_loopback::BridgeServer::start_scoped(
                Arc::new(Router {
                    app: app.clone(),
                    runtime: runtime.clone(),
                }),
                "file-drag",
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

    fn max_request_body_bytes(&self, _token: &str) -> Option<usize> {
        Some(registry::MAX_WIRE_BYTES)
    }

    fn origin_policy(&self, token: &str) -> crate::plugin_loopback::OriginPolicy {
        self.runtime
            .by_token(token)
            .map_or(crate::plugin_loopback::OriginPolicy::Deny, |session| {
                session
                    .document
                    .as_ref()
                    .map_or(crate::plugin_loopback::OriginPolicy::Opaque, |document| {
                        document.origin_policy()
                    })
            })
    }

    async fn handle(&self, token: &str, payload: Value) -> Result<Value, String> {
        let session = self
            .runtime
            .by_token(token)
            .ok_or("File-drag session unavailable; reopen the plugin")?;
        let state = self.app.state::<crate::state::AppState>();
        if let Err(error) = super::validate_session(&state.db, &session) {
            lifecycle::close(
                &self.app,
                &state.db,
                &self.runtime,
                Some(&session.owner),
                None,
                None,
                None,
                false,
            )
            .await;
            return Err(error);
        }
        let raw_paths = request::parse(&payload)?;
        let paths = tokio::task::spawn_blocking(move || request::canonicalize(raw_paths))
            .await
            .map_err(|_| "File-drag path validation interrupted")??;
        if !session.valid() {
            return Err("File-drag session closed".into());
        }
        super::validate_session(&state.db, &session)?;

        let id = credential();
        let (ack_sender, ack_receiver) = oneshot::channel();
        let invocation = Arc::new(Invocation {
            id: id.clone(),
            session: session.id.clone(),
            owner: session.owner.clone(),
            plugin: session.owner.plugin.clone(),
            document: session.document.clone(),
            paths: parking_lot::Mutex::new(Some(paths)),
            claimed: AtomicBool::new(false),
            phase: AtomicU8::new(super::types::INVOCATION_PENDING),
            cancelled: Arc::new(AtomicBool::new(false)),
            run: parking_lot::Mutex::new(None),
            acknowledgement: parking_lot::Mutex::new(Some(ack_sender)),
        });
        self.runtime.insert_invocation(invocation.clone())?;
        let app = self.app.clone();
        let runtime = self.runtime.clone();
        let db = state.db.clone();
        let tool = session.tool.clone();
        let task_args = json!({"operation":"request","sessionId":session.id,"invocationId":id});
        let invocation_for_task = invocation.clone();
        tauri::async_runtime::spawn(async move {
            let audit = crate::agent_tools::call_tool_with_audit(
                &app,
                &db,
                "atools-ui",
                &tool,
                task_args,
                true,
            )
            .await;
            if audit.is_error {
                invocation_for_task.acknowledge(Err("File-drag request was rejected".into()));
            } else if !invocation_for_task.is_started() {
                invocation_for_task
                    .acknowledge(Err("File-drag request did not start natively".into()));
            }
            runtime.remove_invocation(&invocation_for_task.id);
        });

        match tokio::time::timeout(START_ACK_TIMEOUT, ack_receiver).await {
            Ok(Ok(Ok(ack))) => Ok(ack),
            Ok(Ok(Err(error))) => {
                self.runtime.remove_invocation(&id);
                Err(error)
            }
            Ok(Err(_)) => {
                self.runtime.remove_invocation(&id);
                Err("File-drag native start acknowledgement was interrupted".into())
            }
            Err(_) => {
                let cancelled_before_start = invocation.cancel_before_start();
                invocation.paths.lock().take();
                if cancelled_before_start {
                    if let Some(run_id) = invocation.run.lock().clone() {
                        lifecycle::cancel_run(
                            &self.app,
                            &state.db,
                            &run_id,
                            "File-drag start acknowledgement timed out",
                        );
                    }
                }
                self.runtime.remove_invocation(&id);
                Err("File-drag native start acknowledgement timed out".into())
            }
        }
    }
}
