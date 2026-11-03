//! Generation-bound authorization intents, independent of process startup.
use super::{
    node_selected_entry::SelectedPreload,
    sessions::{credential, Sessions},
    types::Intent,
};
use crate::plugin_page_runtime::DocumentBinding;
use parking_lot::Mutex;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

impl Sessions {
    #[cfg(test)]
    pub fn create_intent(
        &self,
        owner: String,
        client: String,
        plugin_id: String,
    ) -> Result<String, String> {
        self.create_bound_intent(owner, client, plugin_id, None)
    }
    #[cfg(test)]
    pub fn create_bound_intent(
        &self,
        owner: String,
        client: String,
        plugin_id: String,
        document: Option<DocumentBinding>,
    ) -> Result<String, String> {
        self.create_selected_intent(owner, client, plugin_id, document, None)
    }
    pub(super) fn create_selected_intent(
        &self,
        owner: String,
        client: String,
        plugin_id: String,
        document: Option<DocumentBinding>,
        selected: Option<SelectedPreload>,
    ) -> Result<String, String> {
        if document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Plugin document closed".into());
        }
        if self.stopping.load(Ordering::Acquire) {
            return Err("Node runtime is stopping".into());
        }
        let mut cancelled = self.cancelled_owners.lock();
        cancelled.retain(|_, at| at.elapsed().as_secs() < 600);
        if cancelled.contains_key(&owner) {
            return Err("Plugin opening was cancelled".into());
        }
        let mut intents = self.intents.lock();
        if document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Plugin document closed".into());
        }
        intents.retain(|_, intent| {
            !intent.cancelled.load(Ordering::Acquire) && intent.created.elapsed().as_secs() < 600
        });
        if intents.len() >= 32 {
            return Err("Too many pending plugin authorizations".into());
        }
        let id = credential();
        intents.insert(
            id.clone(),
            Intent {
                owner,
                document,
                client,
                plugin_id,
                cancelled: Arc::new(AtomicBool::new(false)),
                claimed: Arc::new(AtomicBool::new(false)),
                created: Instant::now(),
                run_id: Arc::new(Mutex::new(None)),
                selected,
                #[cfg(feature = "legacy-node-smoke")]
                startup_diagnostic: None,
            },
        );
        Ok(id)
    }
    pub fn take_intent(
        &self,
        id: Option<&str>,
        client: &str,
        plugin_id: &str,
    ) -> Result<Intent, String> {
        let intent = if let Some(id) = id {
            self.intents
                .lock()
                .get(id)
                .cloned()
                .ok_or("Plugin authorization expired; reopen the plugin")?
        } else {
            Intent {
                owner: format!("agent:{client}:{plugin_id}"),
                document: None,
                client: client.into(),
                plugin_id: plugin_id.into(),
                cancelled: Arc::new(AtomicBool::new(false)),
                claimed: Arc::new(AtomicBool::new(false)),
                created: Instant::now(),
                run_id: Arc::new(Mutex::new(None)),
                selected: None,
                #[cfg(feature = "legacy-node-smoke")]
                startup_diagnostic: None,
            }
        };
        if intent.document.as_ref().is_some_and(|d| !d.is_active())
            || intent.client != client
            || intent.plugin_id != plugin_id
            || intent.created.elapsed().as_secs() >= 600
            || intent.cancelled.load(Ordering::Acquire)
        {
            return Err("Plugin authorization does not match this request".into());
        }
        if intent.claimed.swap(true, Ordering::AcqRel) {
            return Err("Plugin authorization is already being processed".into());
        }
        Ok(intent)
    }

    #[cfg(feature = "legacy-node-smoke")]
    pub(crate) fn attach_startup_diagnostic(
        &self,
        id: &str,
        permit: super::native_node_startup_fixture::StartupDiagnosticPermit,
    ) -> Result<(), String> {
        let mut intents = self.intents.lock();
        let intent = intents.get_mut(id).ok_or("Plugin authorization expired")?;
        if intent.plugin_id != permit.plugin_id() || intent.owner != permit.owner() {
            return Err("Startup diagnostic permit does not match this plugin window".into());
        }
        if intent.startup_diagnostic.is_some() {
            return Err("Startup diagnostic permit is already attached".into());
        }
        intent.startup_diagnostic = Some(permit);
        Ok(())
    }
}
