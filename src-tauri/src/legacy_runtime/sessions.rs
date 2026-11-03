use super::http::BridgeServer;
use super::native_image::NativeImageEngine;
use super::native_image_session::ImageSessionStore;
use super::node_startup_diagnostic::LegacyRuntimeError;
#[path = "session_closing.rs"]
mod session_closing;
#[path = "session_opening.rs"]
mod session_opening;
#[path = "session_transport.rs"]
mod session_transport;
use self::session_closing::StopCompletion;
use self::session_opening::OpeningLease;
use crate::plugin_page_runtime::DocumentBinding;
use atools_plugin::sidecar::NodeRuntimeSelector;
use atools_plugin::LegacyNodeSession;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::Instant;

pub use super::types::{Intent, Invocation, Session};

type Openings = Mutex<HashMap<String, (String, Arc<AtomicBool>, Option<DocumentBinding>)>>;

#[derive(Default)]
pub struct Sessions {
    pub sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    pub intents: Mutex<HashMap<String, Intent>>,
    pub openings: Arc<Openings>,
    pub invocations: Mutex<HashMap<String, Arc<Invocation>>>,
    pub server: Arc<tokio::sync::Mutex<Option<BridgeServer>>>,
    transport_cleanup: Arc<session_transport::IdleCleanupState>,
    pub(super) cancelled_owners: Mutex<HashMap<String, Instant>>,
    pub(super) stopping: AtomicBool,
    pub(super) process_budget: super::session_process_budget::NodeProcessBudget,
    stop_completions: Mutex<HashMap<String, Arc<StopCompletion>>>,
    transition: tokio::sync::Mutex<()>,
    native_image_engine: OnceLock<Arc<NativeImageEngine>>,
    node_runtime_selector: NodeRuntimeSelector,
}
pub fn credential() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
impl Sessions {
    pub(crate) fn with_node_runtime_selector(selector: NodeRuntimeSelector) -> Self {
        Self {
            node_runtime_selector: selector,
            ..Self::default()
        }
    }

    fn native_image_engine(&self) -> Arc<NativeImageEngine> {
        Arc::clone(
            self.native_image_engine
                .get_or_init(|| Arc::new(NativeImageEngine::new())),
        )
    }

    fn opening_cancelled(&self, intent: &Intent) -> bool {
        self.stopping.load(Ordering::Acquire)
            || intent.cancelled.load(Ordering::Acquire)
            || intent
                .document
                .as_ref()
                .is_some_and(|document| !document.is_active())
            || self.cancelled_owners.lock().contains_key(&intent.owner)
    }

    pub async fn open(
        &self,
        plugin: &atools_core::Plugin,
        tool: String,
        intent: Intent,
    ) -> Result<Arc<Session>, LegacyRuntimeError> {
        #[cfg(feature = "legacy-node-smoke")]
        let mut startup_attempt = intent
            .startup_diagnostic
            .as_ref()
            .map(|permit| permit.begin_attempt());
        let _transition = self.transition.lock().await;
        if self.opening_cancelled(&intent) {
            return Err("Plugin opening was cancelled".into());
        }
        let opening = OpeningLease::begin(
            self,
            &intent.owner,
            &plugin.id,
            intent.cancelled.clone(),
            intent.document.clone(),
        );
        // Reject a changed child anchor before reusing or touching a live parent.
        let selected_entry = if let Some(selected) = intent.selected.clone() {
            let entry_plugin = plugin.clone();
            Some(
                tokio::task::spawn_blocking(move || selected.revalidate(&entry_plugin))
                    .await
                    .map_err(|_| "Plugin Node source inspection was interrupted")??,
            )
        } else {
            None
        };
        if self.opening_cancelled(&intent) {
            return Err("Plugin opening was cancelled".into());
        }
        let existing = {
            self.sessions
                .read()
                .values()
                .find(|s| {
                    s.owner == intent.owner
                        && s.plugin_id == plugin.id
                        && s.document.as_ref().map(|d| d.id())
                            == intent.document.as_ref().map(|d| d.id())
                        && s.version == plugin.version
                        && s.plugin_path == plugin.path
                        && !s.is_closing()
                        && s.runtime.status() == atools_plugin::sidecar::SidecarStatus::Running
                })
                .cloned()
        };
        if let Some(existing) = existing {
            if !opening.finish() {
                return Err("Plugin opening was cancelled".into());
            }
            return Ok(existing);
        }
        let old: Vec<_> = self
            .sessions
            .read()
            .values()
            .filter(|s| s.owner == intent.owner)
            .cloned()
            .collect();
        for session in old {
            self.remove_strict(&session.id)
                .await
                .map_err(LegacyRuntimeError::from)?;
        }
        if self.opening_cancelled(&intent) {
            return Err("Plugin opening was cancelled".into());
        }
        let process_permit = self.process_budget.reserve()?;
        if self.opening_cancelled(&intent) {
            return Err("Plugin opening was cancelled".into());
        }
        let entry_plugin = plugin.clone();
        let entry = if let Some(entry) = selected_entry {
            entry
        } else {
            tokio::task::spawn_blocking(move || super::node_entry::select_entry(&entry_plugin))
                .await
                .map_err(|_| "Plugin Node source inspection was interrupted")??
        };
        if self.opening_cancelled(&intent) {
            return Err("Plugin opening was cancelled".into());
        }
        let sidecar_id = format!("legacy-{}", credential());
        #[cfg(feature = "legacy-node-smoke")]
        let runtime = if startup_attempt.is_some() {
            let task_run_id = intent
                .run_id
                .lock()
                .clone()
                .ok_or("Diagnostic fixture open is missing its TaskRun identity")?;
            match LegacyNodeSession::start_with_diagnostics_and_permit(
                sidecar_id,
                &entry.package_root,
                &entry.entry,
                true,
                self.node_runtime_selector.clone(),
                intent.cancelled.clone(),
                process_permit,
            )
            .await
            {
                Ok(runtime) => {
                    if let Some(attempt) = startup_attempt.as_ref() {
                        if let Some(snapshot) = runtime.startup_diagnostic_snapshot() {
                            let _ = attempt.record_success(&task_run_id, &snapshot);
                        } else {
                            attempt.mark_incomplete();
                        }
                    }
                    Ok(runtime)
                }
                Err(atools_plugin::sidecar::SidecarError::Startup {
                    failure,
                    diagnostic,
                }) => match startup_attempt.take() {
                    Some(attempt) => Err(LegacyRuntimeError::Startup(
                        super::node_startup_diagnostic::NodeStartupFailure {
                            failure,
                            diagnostic,
                            task_run_id,
                            owner: attempt.owner().to_owned(),
                            plugin_id: attempt.plugin_id().to_owned(),
                            attempt,
                        },
                    )),
                    None => Err(LegacyRuntimeError::from(
                        "Node sidecar startup diagnostic lost its fixture attempt".to_owned(),
                    )),
                },
                Err(error) => Err(LegacyRuntimeError::from(error.to_string())),
            }
        } else {
            LegacyNodeSession::start_with_permit(
                sidecar_id,
                &entry.package_root,
                &entry.entry,
                self.node_runtime_selector.clone(),
                intent.cancelled.clone(),
                process_permit,
            )
            .await
            .map_err(|error| LegacyRuntimeError::from(error.to_string()))
        };
        #[cfg(not(feature = "legacy-node-smoke"))]
        let runtime = LegacyNodeSession::start_with_permit(
            sidecar_id,
            &entry.package_root,
            &entry.entry,
            self.node_runtime_selector.clone(),
            intent.cancelled.clone(),
            process_permit,
        )
        .await;
        #[cfg(not(feature = "legacy-node-smoke"))]
        let runtime = runtime.map_err(|error| LegacyRuntimeError::from(error.to_string()))?;
        #[cfg(feature = "legacy-node-smoke")]
        let runtime = runtime?;
        if self.opening_cancelled(&intent) {
            let _ = runtime.stop().await;
            return Err("Plugin opening was cancelled".into());
        }
        let session = Arc::new(Session {
            id: credential(),
            owner: intent.owner,
            document: intent.document,
            client: intent.client,
            plugin_id: plugin.id.clone(),
            plugin_path: plugin.path.clone(),
            version: plugin.version.clone(),
            token: credential(),
            tool,
            runtime,
            closing: std::sync::atomic::AtomicBool::new(false),
            native_image_engine: self.native_image_engine(),
            native_image_store: ImageSessionStore::default(),
        });
        let inserted = {
            let mut sessions = self.sessions.write();
            if session.document.as_ref().is_some_and(|d| !d.is_active()) {
                false
            } else {
                sessions.insert(session.id.clone(), session.clone());
                true
            }
        };
        if !inserted {
            session.native_image_store.close();
            let _ = session.runtime.stop().await;
            return Err("Plugin document closed".into());
        }
        if !opening.finish() {
            self.remove_strict(&session.id)
                .await
                .map_err(LegacyRuntimeError::from)?;
            return Err("Plugin opening was cancelled".into());
        }
        Ok(session)
    }
    pub fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .read()
            .get(id)
            .cloned()
            .ok_or_else(|| "Node session is closed; reopen the plugin".into())
    }
    fn try_drop_idle_transport(&self) {
        session_transport::try_drop_idle_transport(
            &self.sessions,
            &self.openings,
            &self.server,
            &self.transport_cleanup,
        );
    }

    async fn maybe_idle_transport(&self) {
        session_transport::maybe_idle_transport(&self.sessions, &self.openings, &self.server).await;
    }
    pub fn by_token(&self, token: &str) -> Option<Arc<Session>> {
        self.sessions
            .read()
            .values()
            .find(|s| {
                super::same_token(&s.token, token)
                    && s.document.as_ref().is_none_or(|d| d.is_active())
            })
            .cloned()
    }
    pub fn document_owners(&self, page_id: &str) -> std::collections::HashSet<(String, String)> {
        let mut owners: std::collections::HashSet<_> = self
            .sessions
            .read()
            .values()
            .filter(|s| s.document.as_ref().is_some_and(|d| d.id() == page_id))
            .map(|s| (s.owner.clone(), s.plugin_id.clone()))
            .collect();
        owners.extend(
            self.intents
                .lock()
                .values()
                .filter(|i| i.document.as_ref().is_some_and(|d| d.id() == page_id))
                .map(|i| (i.owner.clone(), i.plugin_id.clone())),
        );
        owners.extend(
            self.openings
                .lock()
                .iter()
                .filter(|(_, (_, _, d))| d.as_ref().is_some_and(|d| d.id() == page_id))
                .map(|(o, (p, _, _))| (o.clone(), p.clone())),
        );
        owners
    }
    pub async fn stop_all(&self) {
        self.stopping.store(true, Ordering::Release);
        for session in self.sessions.read().values() {
            session.mark_closing();
        }
        for intent in self.intents.lock().values() {
            intent.cancelled.store(true, Ordering::Release);
        }
        for (_, cancel, _) in self.openings.lock().values() {
            cancel.store(true, Ordering::Release);
        }
        let _transition = self.transition.lock().await;
        let ids: Vec<_> = self.sessions.read().keys().cloned().collect();
        for id in ids {
            self.remove(&id).await;
        }
        let server = self.server.lock().await.take();
        drop(server);
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "session_startup_cancellation_tests.rs"]
mod session_startup_cancellation_tests;

#[cfg(test)]
#[path = "session_transport_cleanup_tests.rs"]
mod session_transport_cleanup_tests;
