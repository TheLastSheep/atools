//! Bounded per-window generations; opening never reads native display metadata.

use crate::plugin_loopback::BridgeServer;
use crate::plugin_page_runtime::DocumentBinding;
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

pub(super) const MAX_SUCCESSOR_LINKS: usize = 512;
pub(super) const MAX_CLOSED_OWNERS: usize = 512;

/// Remember a closed generation without allowing a tombstone map to grow.
/// Owners that still participate in a successor lineage are protected because
/// that lineage independently prevents them from being opened again.
pub(super) fn remember_closed(state: &mut Store, owner: &str, protected: &HashSet<String>) -> bool {
    if let Some(closed_at) = state.closed.get_mut(owner) {
        *closed_at = Instant::now();
        return true;
    }
    if state.closed.len() >= MAX_CLOSED_OWNERS {
        let oldest_evictable = state
            .closed
            .iter()
            .filter(|(candidate, _)| {
                (!protected.contains(*candidate) || state.successors.contains_key(*candidate))
                    && !state
                        .sessions
                        .values()
                        .any(|session| session.owner.as_str() == candidate.as_str())
                    && !state
                        .intents
                        .values()
                        .any(|intent| intent.owner.as_str() == candidate.as_str())
                    && state.successors.contains_key(*candidate)
            })
            .min_by_key(|(_, closed_at)| **closed_at)
            .map(|(candidate, _)| candidate.clone());
        let Some(oldest_evictable) = oldest_evictable else {
            return false;
        };
        state.closed.remove(&oldest_evictable);
    }
    state.closed.insert(owner.into(), Instant::now());
    true
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    path: String,
    version: String,
    revision: Option<String>,
}
impl Binding {
    pub fn current(
        db: &atools_core::Database,
        plugin: &atools_core::Plugin,
    ) -> Result<Self, String> {
        if !plugin.enabled {
            return Err("Plugin is disabled".into());
        }
        Ok(Self {
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            revision: crate::plugin_code_revision::current(db, &plugin.id)?,
        })
    }
    pub fn validate(&self, db: &atools_core::Database, plugin: &str) -> Result<(), String> {
        let current = db.get_plugin(plugin).map_err(|_| "Plugin unavailable")?;
        if *self != Self::current(db, &current)? {
            return Err("Plugin changed; reopen it".into());
        }
        Ok(())
    }
}
pub fn credential() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
#[derive(Clone)]
pub struct Intent {
    pub owner: String,
    pub document: Option<DocumentBinding>,
    pub plugin: String,
    pub cancelled: Arc<AtomicBool>,
    pub claimed: Arc<AtomicBool>,
    pub created: Instant,
    pub binding: Binding,
    pub run: Arc<Mutex<Option<String>>>,
}
pub struct Session {
    pub id: String,
    pub token: String,
    pub owner: String,
    pub document: Option<DocumentBinding>,
    pub plugin: String,
    pub path: String,
    pub version: String,
    pub binding: Binding,
    pub tool: String,
    /// One exact authorization opens this session lineage; rotation carries its
    /// single run ID rather than accumulating completed opens indefinitely.
    pub opening_intent: Mutex<Option<String>>,
    pub opener_run: Arc<Mutex<Option<String>>>,
    // Closing and native I/O are linearized. A close cannot revoke an operation
    // whose native side effect already completed, nor can it start a later one.
    pub active: Mutex<bool>,
}
pub struct Invocation {
    pub session: String,
    pub claimed: AtomicBool,
    pub run: Mutex<Option<String>>,
    pub result: Mutex<Option<Result<Value, String>>>,
}
#[derive(Default)]
pub struct Store {
    pub sessions: HashMap<String, Arc<Session>>,
    pub intents: HashMap<String, Intent>,
    pub invocations: HashMap<String, Arc<Invocation>>,
    pub(super) closed: HashMap<String, Instant>,
    pub(super) successors: HashMap<String, String>,
    pub(super) stopped: bool,
}
pub struct Sessions {
    pub store: Mutex<Store>,
    pub server: tokio::sync::Mutex<Option<BridgeServer>>,
}
impl Sessions {
    pub fn new() -> Self {
        Self {
            store: Mutex::new(Store::default()),
            server: tokio::sync::Mutex::new(None),
        }
    }
    pub fn intent_with_document(
        &self,
        owner: String,
        plugin: String,
        binding: Binding,
        document: Option<DocumentBinding>,
    ) -> Result<String, String> {
        if document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Plugin document closed".into());
        }
        let mut state = self.store.lock();
        state.closed.retain(|_, t| t.elapsed().as_secs() < 600);
        if state.stopped
            || state.closed.contains_key(&owner)
            || state.successors.contains_key(&owner)
            || document.as_ref().is_some_and(|d| !d.is_active())
        {
            return Err("Display opening was cancelled; reopen the plugin".into());
        }
        if state.intents.len() >= 32 {
            return Err("Too many pending display authorizations".into());
        }
        // One live authorization per exact generation, plugin and document.
        if let Some((id, _)) = state.intents.iter().find(|(_, i)| {
            i.owner == owner
                && i.plugin == plugin
                && i.binding == binding
                && i.document.as_ref().map(|d| d.id()) == document.as_ref().map(|d| d.id())
        }) {
            return Ok(id.clone());
        }
        let id = credential();
        state.intents.insert(
            id.clone(),
            Intent {
                owner,
                document,
                plugin,
                binding,
                created: Instant::now(),
                cancelled: Arc::new(AtomicBool::new(false)),
                claimed: Arc::new(AtomicBool::new(false)),
                run: Arc::new(Mutex::new(None)),
            },
        );
        Ok(id)
    }
    pub fn expire(&self) -> Vec<String> {
        let mut runs = Vec::new();
        self.store.lock().intents.retain(|_, i| {
            if i.created.elapsed().as_secs() < 600 && !i.cancelled.load(Ordering::Acquire) {
                return true;
            }
            i.cancelled.store(true, Ordering::Release);
            if let Some(run) = i.run.lock().clone() {
                runs.push(run);
            }
            false
        });
        runs
    }
    pub fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.store
            .lock()
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "Display session closed; reopen the plugin".into())
    }
    /// Publish credentials only while this exact session is still the live map entry.
    /// Call after awaiting the server mutex, preserving server -> store -> active order.
    pub fn with_live_session<T>(
        &self,
        expected: &Arc<Session>,
        publish: impl FnOnce(&Session) -> Result<T, String>,
    ) -> Result<T, String> {
        let store = self.store.lock();
        let current = store
            .sessions
            .get(&expected.id)
            .ok_or("Display session closed")?;
        if !Arc::ptr_eq(current, expected) {
            return Err("Display session changed".into());
        }
        let active = current.active.lock();
        if !*active || current.document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Display session closed".into());
        }
        publish(current)
    }
    pub async fn remove(&self, id: &str) {
        let session = self.store.lock().sessions.remove(id);
        if let Some(session) = session {
            *session.active.lock() = false;
        }
        self.idle().await;
    }
    #[cfg(test)]
    pub fn rotate(
        &self,
        old_owner: &str,
        new_owner: &str,
        plugin: &str,
        expected: &[String],
    ) -> Result<Vec<String>, String> {
        self.rotate_bound(old_owner, new_owner, plugin, expected, None)
    }
    pub fn rotate_bound(
        &self,
        old_owner: &str,
        new_owner: &str,
        plugin: &str,
        expected: &[String],
        document: Option<DocumentBinding>,
    ) -> Result<Vec<String>, String> {
        let mut state = self.store.lock();
        if state.successors.len() >= MAX_SUCCESSOR_LINKS {
            return Err(
                "Display rotation budget reached; restart ATools to create a new display session"
                    .into(),
            );
        }
        if state.stopped
            || state.closed.contains_key(old_owner)
            || state.closed.contains_key(new_owner)
            || state.successors.contains_key(old_owner)
            || state.successors.contains_key(new_owner)
            || state
                .successors
                .values()
                .any(|owner| owner.as_str() == new_owner)
            || state
                .sessions
                .values()
                .any(|session| session.owner.as_str() == new_owner)
            || state
                .intents
                .values()
                .any(|intent| intent.owner.as_str() == new_owner)
            || old_owner == new_owner
            || expected.is_empty()
        {
            return Err("Display reopen was cancelled".into());
        }
        let originals: Vec<_> = state
            .sessions
            .values()
            .filter(|s| s.owner == old_owner && s.plugin == plugin)
            .cloned()
            .collect();
        if originals.len() != expected.len()
            || originals.iter().any(|s| {
                !expected.contains(&s.id) || !*s.active.lock() || s.opening_intent.lock().is_some()
            })
        {
            return Err("Display generation changed before reopen".into());
        }
        if document.as_ref().is_some_and(|d| !d.is_active())
            || originals.iter().any(|s| {
                s.document.as_ref().is_some_and(|d| !d.is_active())
                    || (s.document.is_some() && document.is_none())
            })
        {
            return Err("Native document binding required for reopen".into());
        }
        let protected = HashSet::from([old_owner.to_string(), new_owner.to_string()]);
        if !remember_closed(&mut state, old_owner, &protected) {
            return Err("Display owner tombstone capacity reached".into());
        }
        let mut runs = Vec::new();
        state.intents.retain(|_, intent| {
            if intent.owner != old_owner || intent.plugin != plugin {
                return true;
            }
            intent.cancelled.store(true, Ordering::Release);
            if let Some(id) = intent.run.lock().clone() {
                runs.push(id);
            }
            false
        });
        let old_ids: Vec<_> = originals.iter().map(|s| s.id.clone()).collect();
        for invocation in state
            .invocations
            .values()
            .filter(|i| old_ids.contains(&i.session))
        {
            if let Some(id) = invocation.run.lock().clone() {
                runs.push(id);
            }
        }
        for old in originals {
            *old.active.lock() = false;
            state.sessions.remove(&old.id);
            let session = Arc::new(Session {
                id: credential(),
                token: credential(),
                owner: new_owner.into(),
                document: document.clone(),
                plugin: old.plugin.clone(),
                path: old.path.clone(),
                version: old.version.clone(),
                binding: old.binding.clone(),
                tool: old.tool.clone(),
                opening_intent: Mutex::new(None),
                opener_run: old.opener_run.clone(),
                active: Mutex::new(true),
            });
            state.sessions.insert(session.id.clone(), session);
        }
        state.successors.insert(old_owner.into(), new_owner.into());
        Ok(runs)
    }
    pub fn by_token(&self, token: &str) -> Option<Arc<Session>> {
        self.store
            .lock()
            .sessions
            .values()
            .find(|s| {
                super::same_token(&s.token, token)
                    && s.document.as_ref().is_none_or(|d| d.is_active())
            })
            .cloned()
    }
    pub fn document_owners(&self, page_id: &str) -> std::collections::HashSet<(String, String)> {
        let store = self.store.lock();
        store
            .sessions
            .values()
            .map(|s| (&s.owner, &s.plugin, &s.document))
            .chain(
                store
                    .intents
                    .values()
                    .map(|i| (&i.owner, &i.plugin, &i.document)),
            )
            .filter(|(_, _, d)| d.as_ref().is_some_and(|d| d.id() == page_id))
            .map(|(o, p, _)| (o.clone(), p.clone()))
            .collect()
    }
    pub async fn idle(&self) {
        let removed = {
            let mut server = self.server.lock().await;
            if self.store.lock().sessions.is_empty() {
                server.take()
            } else {
                None
            }
        };
        drop(removed);
    }
}
