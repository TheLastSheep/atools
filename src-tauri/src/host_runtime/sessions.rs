//! Bounded per-window generations; opening never reads or writes the clipboard.
use super::once_authorization::OnceAuthorization;
use super::{clipboard::ClipboardAccess, registry::Access};
use crate::plugin_loopback::BridgeServer;
use crate::plugin_page_runtime::DocumentBinding;
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

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
    pub access: Access,
    pub cancelled: Arc<AtomicBool>,
    pub claimed: Arc<AtomicBool>,
    pub created: Instant,
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
    pub access: Access,
    pub tool: String,
    pub(super) once_authorization: Option<OnceAuthorization>,
    // Closing and native I/O are linearized. A close cannot revoke an operation
    // whose native side effect already completed, nor can it start a later one.
    pub active: Mutex<bool>,
}
pub struct Invocation {
    pub session: String,
    pub request: Mutex<Option<super::request::ClipboardRequest>>,
    pub claimed: AtomicBool,
    pub run: Mutex<Option<String>>,
    pub result: Mutex<Option<Result<Value, String>>>,
}
#[derive(Default)]
pub struct Store {
    pub sessions: HashMap<String, Arc<Session>>,
    pub intents: HashMap<String, Intent>,
    pub invocations: HashMap<String, Arc<Invocation>>,
    closed: HashMap<String, Instant>,
    successors: HashMap<String, String>,
    stopped: bool,
}
pub struct Sessions {
    pub store: Mutex<Store>,
    pub server: tokio::sync::Mutex<Option<BridgeServer>>,
    pub clipboard: Arc<dyn ClipboardAccess>,
}
impl Sessions {
    pub fn new(clipboard: Arc<dyn ClipboardAccess>) -> Self {
        Self {
            store: Mutex::new(Store::default()),
            server: tokio::sync::Mutex::new(None),
            clipboard,
        }
    }
    #[cfg(test)]
    pub fn intent(&self, owner: String, plugin: String, access: Access) -> Result<String, String> {
        self.intent_with_document(owner, plugin, access, None)
    }
    pub fn intent_with_document(
        &self,
        owner: String,
        plugin: String,
        access: Access,
        document: Option<DocumentBinding>,
    ) -> Result<String, String> {
        if document.as_ref().is_some_and(|d| !d.is_active()) {
            return Err("Plugin document closed".into());
        }
        let mut state = self.store.lock();
        state.closed.retain(|_, t| t.elapsed().as_secs() < 600);
        state.intents.retain(|_, i| {
            i.created.elapsed().as_secs() < 600 && !i.cancelled.load(Ordering::Acquire)
        });
        if state.stopped
            || state.closed.contains_key(&owner)
            || document.as_ref().is_some_and(|d| !d.is_active())
        {
            return Err("Clipboard opening was cancelled; reopen the plugin".into());
        }
        if state.intents.len() >= 32 {
            return Err("Too many pending clipboard authorizations".into());
        }
        // One live authorization per direction, generation and plugin.
        if let Some((id, _)) = state.intents.iter().find(|(_, i)| {
            i.owner == owner
                && i.plugin == plugin
                && i.access == access
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
                access,
                created: Instant::now(),
                cancelled: Arc::new(AtomicBool::new(false)),
                claimed: Arc::new(AtomicBool::new(false)),
                run: Arc::new(Mutex::new(None)),
            },
        );
        Ok(id)
    }
    pub fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.store
            .lock()
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "Clipboard session closed; reopen the plugin".into())
    }
    pub fn open(
        &self,
        id: &str,
        plugin: &atools_core::Plugin,
        access: Access,
    ) -> Result<Arc<Session>, String> {
        self.open_with_once_authorization(id, plugin, access, None)
    }
    pub(super) fn open_with_once_authorization(
        &self,
        id: &str,
        plugin: &atools_core::Plugin,
        access: Access,
        mut once_authorization: Option<OnceAuthorization>,
    ) -> Result<Arc<Session>, String> {
        let mut state = self.store.lock();
        let intent = state
            .intents
            .get(id)
            .cloned()
            .ok_or("Clipboard authorization expired")?;
        if state.stopped
            || state.closed.contains_key(&intent.owner)
            || intent.plugin != plugin.id
            || intent.access != access
            || intent.created.elapsed().as_secs() >= 600
            || intent.cancelled.load(Ordering::Acquire)
            || intent.document.as_ref().is_some_and(|d| !d.is_active())
            || intent.claimed.swap(true, Ordering::AcqRel)
        {
            return Err("Clipboard authorization was cancelled or already consumed".into());
        }
        if let Some(existing) = state
            .sessions
            .values()
            .find(|s| {
                s.owner == intent.owner
                    && s.plugin == plugin.id
                    && s.document.as_ref().map(|d| d.id())
                        == intent.document.as_ref().map(|d| d.id())
                    && s.access == access
                    && s.path == plugin.path
                    && s.version == plugin.version
            })
            .cloned()
        {
            if once_authorization.is_none() && existing.once_authorization.is_none() {
                return Ok(existing);
            }
        }
        if state.sessions.len() >= 16 {
            return Err("Too many active clipboard sessions".into());
        }
        let session_id = credential();
        if let Some(authorization) = once_authorization.as_mut() {
            authorization.bind_session(&session_id);
        }
        let session = Arc::new(Session {
            id: session_id,
            token: credential(),
            owner: intent.owner,
            document: intent.document,
            plugin: plugin.id.clone(),
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            access,
            tool: super::registry::tool_name(&plugin.id, access),
            once_authorization,
            active: Mutex::new(true),
        });
        state.sessions.insert(session.id.clone(), session.clone());
        Ok(session)
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
        if state.stopped
            || state.successors.len() >= 512
            || state.closed.contains_key(old_owner)
            || state.closed.contains_key(new_owner)
            || old_owner == new_owner
            || expected.is_empty()
        {
            return Err("Clipboard reopen was cancelled".into());
        }
        let originals: Vec<_> = state
            .sessions
            .values()
            .filter(|s| s.owner == old_owner && s.plugin == plugin)
            .cloned()
            .collect();
        if originals.len() != expected.len()
            || originals
                .iter()
                .any(|s| !expected.contains(&s.id) || !*s.active.lock())
        {
            return Err("Clipboard generation changed before reopen".into());
        }
        if document.as_ref().is_some_and(|d| !d.is_active())
            || originals.iter().any(|s| {
                s.document.as_ref().is_some_and(|d| !d.is_active())
                    || (s.document.is_some() && document.is_none())
            })
        {
            return Err("Native document binding required for reopen".into());
        }
        let mut runs = Vec::new();
        state.intents.retain(|_, intent| {
            if intent.owner != old_owner {
                return true;
            }
            intent.cancelled.store(true, Ordering::Release);
            if let Some(id) = intent.run.lock().clone() {
                runs.push(id);
            }
            false
        });
        for old in originals {
            *old.active.lock() = false;
            state.sessions.remove(&old.id);
            // Image-write and Allow Once sessions must be re-authorized after
            // rotation; never transfer a one-time proof to a new document.
            if old.access == Access::ImageWrite || old.once_authorization.is_some() {
                continue;
            }
            let session = Arc::new(Session {
                id: credential(),
                token: credential(),
                owner: new_owner.into(),
                document: document.clone(),
                plugin: old.plugin.clone(),
                path: old.path.clone(),
                version: old.version.clone(),
                access: old.access,
                tool: old.tool.clone(),
                once_authorization: None,
                active: Mutex::new(true),
            });
            state.sessions.insert(session.id.clone(), session);
        }
        state.closed.insert(old_owner.into(), Instant::now());
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
    pub async fn close(
        &self,
        owner: Option<&str>,
        plugin: Option<&str>,
        stop: bool,
    ) -> Vec<String> {
        self.close_inner(owner, plugin, stop, None).await
    }
    pub async fn close_document_owner(
        &self,
        owner: &str,
        plugin: &str,
        page_id: &str,
    ) -> Vec<String> {
        // Native document revocation prevents late opens without a whole-owner
        // tombstone or a successor walk into a different document.
        self.close_inner(Some(owner), Some(plugin), false, Some(page_id))
            .await
    }
    async fn close_inner(
        &self,
        owner: Option<&str>,
        plugin: Option<&str>,
        stop: bool,
        page_id: Option<&str>,
    ) -> Vec<String> {
        let (sessions, runs) = {
            let mut state = self.store.lock();
            state.stopped |= stop;
            let mut owners = Vec::new();
            if let Some(owner) = owner {
                owners.push(owner.to_string());
                if page_id.is_none() {
                    while let Some(next) =
                        owners.last().and_then(|o| state.successors.get(o)).cloned()
                    {
                        if owners.contains(&next) || owners.len() >= 512 {
                            break;
                        }
                        owners.push(next);
                    }
                    if state.closed.len() >= 512 {
                        if let Some(oldest) = state
                            .closed
                            .iter()
                            .min_by_key(|(_, t)| **t)
                            .map(|(k, _)| k.clone())
                        {
                            state.closed.remove(&oldest);
                        }
                    }
                    for owner in &owners {
                        state.closed.insert(owner.clone(), Instant::now());
                    }
                    state
                        .successors
                        .retain(|old, new| !owners.contains(old) && !owners.contains(new));
                }
            }
            let matches = |o: &str, p: &str, d: &Option<DocumentBinding>| {
                (owner.is_none() || owners.iter().any(|v| v == o))
                    && plugin.is_none_or(|v| v == p)
                    && page_id.is_none_or(|id| d.as_ref().is_some_and(|d| d.id() == id))
            };
            let mut runs = Vec::new();
            state.intents.retain(|_, i| {
                if !matches(&i.owner, &i.plugin, &i.document) {
                    return true;
                }
                i.cancelled.store(true, Ordering::Release);
                if let Some(run) = i.run.lock().clone() {
                    runs.push(run);
                }
                false
            });
            let ids: Vec<_> = state
                .sessions
                .values()
                .filter(|s| matches(&s.owner, &s.plugin, &s.document))
                .map(|s| s.id.clone())
                .collect();
            let sessions: Vec<_> = ids
                .iter()
                .filter_map(|id| state.sessions.remove(id))
                .collect();
            for invocation in state
                .invocations
                .values()
                .filter(|i| ids.contains(&i.session))
            {
                if let Some(run) = invocation.run.lock().clone() {
                    runs.push(run);
                }
            }
            (sessions, runs)
        };
        for session in sessions {
            *session.active.lock() = false;
        }
        self.idle().await;
        runs
    }
}
