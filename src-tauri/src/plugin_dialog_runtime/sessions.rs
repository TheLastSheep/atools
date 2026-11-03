//! Bounded, cancellable preparation and generation-bound dialog sessions.
use super::types::{credential, same_token, Binding, Intent, Invocation, Owner, Session};
use crate::plugin_loopback::BridgeServer;
use crate::plugin_page_runtime::DocumentBinding;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::Instant,
};

#[derive(Default)]
pub(super) struct Store {
    pub sessions: HashMap<String, Arc<Session>>,
    pub intents: HashMap<String, Intent>,
    pub invocations: HashMap<String, Arc<Invocation>>,
    preparations: HashMap<String, (Owner, Option<DocumentBinding>)>,
    successors: HashMap<OwnerKey, Owner>,
    stopped: bool,
}
type OwnerKey = (String, String, String);
fn key(owner: &Owner) -> OwnerKey {
    (
        owner.window.clone(),
        owner.plugin.clone(),
        owner.instance.clone(),
    )
}

pub(crate) struct Sessions {
    pub(super) store: Mutex<Store>,
    pub(super) server: tokio::sync::Mutex<Option<BridgeServer>>,
    pub(super) operations: Arc<tokio::sync::Semaphore>,
}
impl Default for Sessions {
    fn default() -> Self {
        Self {
            store: Mutex::new(Store::default()),
            server: tokio::sync::Mutex::new(None),
            operations: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}
pub(super) struct Preparation {
    id: String,
    owner: Owner,
    document: Option<DocumentBinding>,
    runtime: Weak<Sessions>,
}
impl Drop for Preparation {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.store.lock().preparations.remove(&self.id);
        }
    }
}
impl Sessions {
    #[cfg(test)]
    pub(super) fn begin(self: &Arc<Self>, owner: Owner) -> Result<Preparation, String> {
        self.begin_bound(owner, None)
    }
    pub(super) fn begin_bound(
        self: &Arc<Self>,
        owner: Owner,
        document: Option<DocumentBinding>,
    ) -> Result<Preparation, String> {
        if document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Plugin document closed".into());
        }
        let mut store = self.store.lock();
        if store.stopped
            || document.as_ref().is_some_and(|d| !d.is_active())
            || store.preparations.len() >= 32
            || store.successors.contains_key(&key(&owner))
        {
            return Err("Dialog preparation unavailable".into());
        }
        let id = credential();
        store
            .preparations
            .insert(id.clone(), (owner.clone(), document.clone()));
        Ok(Preparation {
            id,
            owner,
            document,
            runtime: Arc::downgrade(self),
        })
    }
    pub(super) fn intent(
        &self,
        preparation: Preparation,
        binding: Binding,
        access: super::registry::Access,
    ) -> Result<String, String> {
        let mut store = self.store.lock();
        if store
            .preparations
            .remove(&preparation.id)
            .map(|p| p.0)
            .as_ref()
            != Some(&preparation.owner)
            || preparation
                .document
                .as_ref()
                .is_some_and(|d| !d.is_active())
            || store.stopped
        {
            return Err("Dialog preparation was cancelled".into());
        }
        if store.intents.len() >= 32 {
            return Err("Too many pending dialog authorizations".into());
        }
        let id = credential();
        store.intents.insert(
            id.clone(),
            Intent {
                owner: preparation.owner.clone(),
                document: preparation.document.clone(),
                binding,
                access,
                created: Instant::now(),
                run: Arc::new(Mutex::new(None)),
            },
        );
        Ok(id)
    }
    pub(super) fn expire_intents(&self) -> Vec<String> {
        let mut store = self.store.lock();
        let mut runs = Vec::new();
        store.intents.retain(|_, intent| {
            if intent.created.elapsed().as_secs() < 600 {
                return true;
            }
            if let Some(run) = intent.run.lock().clone() {
                runs.push(run)
            }
            false
        });
        runs
    }
    pub(super) fn open(&self, intent_id: &str, binding: &Binding) -> Result<Arc<Session>, String> {
        let mut store = self.store.lock();
        let intent = store
            .intents
            .remove(intent_id)
            .ok_or("Dialog authorization expired or was consumed")?;
        if store.stopped
            || &intent.binding != binding
            || intent.created.elapsed().as_secs() >= 600
            || intent.document.as_ref().is_some_and(|d| !d.is_active())
        {
            return Err("Dialog authorization changed; reopen the plugin".into());
        }
        if store.sessions.len() >= 32
            || store
                .sessions
                .values()
                .filter(|s| s.owner.window == intent.owner.window)
                .count()
                >= 4
        {
            return Err("Too many active dialog sessions".into());
        }
        if store
            .sessions
            .values()
            .any(|s| s.owner == intent.owner && s.access == intent.access)
        {
            return Err("Dialog session already exists for this generation".into());
        }
        let session = Arc::new(Session {
            id: credential(),
            token: credential(),
            tool: super::registry::tool_name(&intent.owner.plugin, intent.access),
            access: intent.access,
            owner: intent.owner,
            document: intent.document,
            binding: binding.clone(),
            active: Mutex::new(true),
            opening_run: intent.run,
        });
        store.sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }
    pub(super) fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.store
            .lock()
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "Dialog session closed; explicitly reopen the plugin".into())
    }
    pub(super) fn by_token(&self, token: &str) -> Option<Arc<Session>> {
        self.store
            .lock()
            .sessions
            .values()
            .find(|s| {
                same_token(&s.token, token) && s.document.as_ref().is_none_or(|d| d.is_active())
            })
            .cloned()
    }
    pub(super) fn existing(
        &self,
        owner: &Owner,
        access: super::registry::Access,
    ) -> Option<Arc<Session>> {
        self.store
            .lock()
            .sessions
            .values()
            .find(|s| &s.owner == owner && s.access == access)
            .cloned()
    }
    pub(super) fn bind_run(&self, intent: &str, run: &str) -> bool {
        let store = self.store.lock();
        if let Some(intent) = store.intents.get(intent) {
            *intent.run.lock() = Some(run.into());
            true
        } else {
            false
        }
    }
    #[cfg(test)]
    pub(super) fn close(
        &self,
        owner: Option<&Owner>,
        plugin: Option<&str>,
        window: Option<&str>,
        stop: bool,
    ) -> Vec<String> {
        self.close_matching(owner, plugin, window, stop).0
    }
    pub(super) fn close_matching(
        &self,
        owner: Option<&Owner>,
        plugin: Option<&str>,
        window: Option<&str>,
        stop: bool,
    ) -> (Vec<String>, Vec<String>) {
        let mut store = self.store.lock();
        store.stopped |= stop;
        let mut owners = owner.cloned().into_iter().collect::<Vec<_>>();
        // Closing the newest generation also forgets its bounded predecessor
        // chain; old-generation closes still revoke every live successor.
        if owner.is_some() {
            for _ in 0..=32 {
                let before = owners.len();
                for ((window, plugin, instance), next) in &store.successors {
                    let previous = Owner {
                        window: window.clone(),
                        plugin: plugin.clone(),
                        instance: instance.clone(),
                    };
                    if owners.contains(&previous) || owners.contains(next) {
                        if !owners.contains(&previous) {
                            owners.push(previous);
                        }
                        if !owners.contains(next) {
                            owners.push(next.clone());
                        }
                    }
                }
                if owners.len() == before {
                    break;
                }
            }
        }
        let matches = |o: &Owner| {
            (owner.is_none() || owners.contains(o))
                && plugin.is_none_or(|p| p == o.plugin)
                && window.is_none_or(|w| w == o.window)
        };
        store
            .preparations
            .retain(|_, (pending, _)| !matches(pending));
        let mut runs = Vec::new();
        store.intents.retain(|_, intent| {
            if !matches(&intent.owner) {
                return true;
            }
            if let Some(run) = intent.run.lock().clone() {
                runs.push(run);
            }
            false
        });
        let ids: Vec<_> = store
            .sessions
            .values()
            .filter(|s| matches(&s.owner))
            .map(|s| s.id.clone())
            .collect();
        let sessions: Vec<_> = ids
            .iter()
            .filter_map(|id| store.sessions.remove(id))
            .collect();
        let native_ids = store
            .invocations
            .iter()
            .filter(|(_, i)| ids.contains(&i.session))
            .map(|(id, _)| id.clone())
            .collect();
        for invocation in store
            .invocations
            .values()
            .filter(|i| ids.contains(&i.session))
        {
            invocation.cancel.cancel();
            if let Some(run) = invocation.run.lock().clone() {
                runs.push(run);
            }
        }
        store
            .invocations
            .retain(|_, invocation| !ids.contains(&invocation.session));
        store.successors.retain(|(w, p, i), next| {
            !matches(&Owner {
                window: w.clone(),
                plugin: p.clone(),
                instance: i.clone(),
            }) && !matches(next)
        });
        drop(store);
        for session in sessions {
            if let Some(run) = session.opening_run.lock().clone() {
                runs.push(run);
            }
            *session.active.lock() = false;
        }
        (runs, native_ids)
    }
    #[cfg(test)]
    pub(super) fn rotate(&self, old: &Owner, next: Owner) -> Result<Vec<Arc<Session>>, String> {
        self.rotate_bound(old, next, None)
    }
    pub(super) fn rotate_bound(
        &self,
        old: &Owner,
        next: Owner,
        document: Option<DocumentBinding>,
    ) -> Result<Vec<Arc<Session>>, String> {
        let mut store = self.store.lock();
        let previous: Vec<_> = store
            .sessions
            .values()
            .filter(|s| &s.owner == old)
            .cloned()
            .collect();
        if store.stopped
            || old == &next
            || store.successors.len() >= 32
            || store.sessions.values().any(|s| s.owner == next)
            || store.preparations.values().any(|(o, _)| o == old)
            || store.intents.values().any(|i| &i.owner == old)
            || store
                .invocations
                .values()
                .any(|i| previous.iter().any(|s| s.id == i.session))
        {
            return Err("Dialog requests are still pending or generation changed".into());
        }
        if previous
            .iter()
            .any(|s| s.document.as_ref().is_some_and(|d| !d.is_active()))
            || document.as_ref().is_some_and(|d| !d.is_active())
            || (previous.iter().any(|s| s.document.is_some()) && document.is_none())
        {
            return Err("Native document binding required for reopen".into());
        }
        let mut sessions = Vec::new();
        for previous in previous {
            *previous.active.lock() = false;
            store.sessions.remove(&previous.id);
            let session = Arc::new(Session {
                id: credential(),
                token: credential(),
                owner: next.clone(),
                document: document.clone(),
                binding: previous.binding.clone(),
                tool: previous.tool.clone(),
                access: previous.access,
                active: Mutex::new(true),
                opening_run: previous.opening_run.clone(),
            });
            store.sessions.insert(session.id.clone(), session.clone());
            sessions.push(session);
        }
        store.successors.insert(key(old), next);
        Ok(sessions)
    }
    pub(super) fn document_owners(&self, page_id: &str) -> Vec<Owner> {
        let store = self.store.lock();
        let mut owners: Vec<Owner> = Vec::new();
        let candidates = store
            .sessions
            .values()
            .map(|s| (&s.owner, &s.document))
            .chain(store.intents.values().map(|i| (&i.owner, &i.document)))
            .chain(store.preparations.values().map(|(o, d)| (o, d)));
        for (owner, document) in candidates {
            if document.as_ref().is_some_and(|d| d.id() == page_id) && !owners.contains(owner) {
                owners.push(owner.clone());
            }
        }
        owners
    }
    pub(super) async fn idle(&self) {
        let mut server = self.server.lock().await;
        if self.store.lock().sessions.is_empty() {
            server.take();
        }
    }
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(super) fn counts(&self) -> (usize, usize, usize, usize) {
        let store = self.store.lock();
        (
            store.sessions.len(),
            store.intents.len(),
            store.invocations.len(),
            store.preparations.len(),
        )
    }
}
