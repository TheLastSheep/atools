use super::{
    registry,
    types::{credential, same_token, Binding, Intent, Invocation, Owner, Session},
};
use crate::{plugin_loopback::BridgeServer, plugin_page_runtime::DocumentBinding};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

#[derive(Default)]
pub(super) struct Store {
    pub(super) sessions: HashMap<String, Arc<Session>>,
    pub(super) intents: HashMap<String, Intent>,
    pub(super) invocations: HashMap<String, Arc<Invocation>>,
    pub(super) preparations: HashMap<String, PreparationState>,
    pub(super) stopped: bool,
}

pub(super) struct PreparationState {
    owner: Owner,
    document: Option<String>,
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
            operations: Arc::new(tokio::sync::Semaphore::new(8)),
        }
    }
}

pub(super) struct Preparation {
    id: String,
    owner: Owner,
    runtime: std::sync::Weak<Sessions>,
}

impl Drop for Preparation {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.store.lock().preparations.remove(&self.id);
        }
    }
}

impl Sessions {
    fn deactivate(session: &Session) {
        let mut active = session.active.lock();
        *active = false;
        *session.key.lock() = zeroize::Zeroizing::new([0; 32]);
    }

    fn close_active_operations(session: &Session, invocations: &[Arc<Invocation>]) -> Vec<String> {
        // Match finish_operation's active→result lock order so close cannot decide
        // cancellation from a stale result snapshot.
        let mut active = session.active.lock();
        *active = false;
        let mut runs = Vec::new();
        for invocation in invocations {
            if invocation.result.lock().is_none() {
                if let Some(run) = invocation.run.lock().clone() {
                    runs.push(run);
                }
            }
        }
        *session.key.lock() = zeroize::Zeroizing::new([0; 32]);
        runs
    }

    pub(super) fn begin(
        self: &Arc<Self>,
        owner: Owner,
        document: Option<String>,
    ) -> Result<Preparation, String> {
        let mut store = self.store.lock();
        let owner_count = store
            .preparations
            .values()
            .filter(|prep| prep.owner.window == owner.window)
            .count()
            + store
                .sessions
                .values()
                .filter(|session| session.owner.window == owner.window)
                .count();
        if store.stopped
            || store.sessions.len() + store.intents.len() + store.preparations.len()
                >= registry::MAX_SESSIONS
            || owner_count >= registry::MAX_PER_WINDOW
            || store.preparations.values().any(|prep| prep.owner == owner)
            || store
                .sessions
                .values()
                .any(|session| session.owner == owner)
        {
            return Err("Secret storage preparation unavailable".into());
        }
        let id = credential();
        store.preparations.insert(
            id.clone(),
            PreparationState {
                owner: owner.clone(),
                document,
            },
        );
        Ok(Preparation {
            id,
            owner,
            runtime: Arc::downgrade(self),
        })
    }

    pub(super) fn intent(
        &self,
        prep: Preparation,
        binding: Binding,
        document: Option<DocumentBinding>,
    ) -> Result<String, String> {
        let mut store = self.store.lock();
        let prepared = store.preparations.remove(&prep.id);
        let document_id = document.as_ref().map(|binding| binding.id().to_owned());
        if prepared
            .as_ref()
            .is_none_or(|state| state.owner != prep.owner || state.document != document_id)
            || store.stopped
            || document
                .as_ref()
                .is_some_and(|binding| !binding.is_active())
        {
            return Err("Secret storage preparation cancelled".into());
        }
        let owner_count = store
            .intents
            .values()
            .filter(|intent| intent.owner.window == prep.owner.window)
            .count();
        if store.intents.len() >= registry::MAX_INTENTS || owner_count >= registry::MAX_PER_WINDOW {
            return Err("Too many pending secret storage approvals".into());
        }
        let id = credential();
        store.intents.insert(
            id.clone(),
            Intent {
                owner: prep.owner.clone(),
                document,
                binding,
                created: Instant::now(),
                run: Arc::new(Mutex::new(None)),
                cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        );
        Ok(id)
    }

    pub(super) fn bind_run(&self, id: &str, run: &str) -> bool {
        self.store.lock().intents.get(id).is_some_and(|intent| {
            *intent.run.lock() = Some(run.into());
            true
        })
    }

    pub(super) fn bind_invocation(&self, id: &str, run: &str) -> bool {
        self.store
            .lock()
            .invocations
            .get(id)
            .is_some_and(|invocation| {
                *invocation.run.lock() = Some(run.into());
                true
            })
    }

    pub(super) fn expire_intent(&self, id: &str) -> Option<String> {
        let mut store = self.store.lock();
        if !store
            .intents
            .get(id)
            .is_some_and(|intent| intent.created.elapsed() >= Duration::from_secs(600))
        {
            return None;
        }
        store
            .intents
            .remove(id)
            .and_then(|intent| intent.run.lock().clone())
    }

    pub(super) fn expire_intents(&self) -> Vec<String> {
        let mut store = self.store.lock();
        let mut expired_runs = Vec::new();
        store.intents.retain(|_, intent| {
            let keep = intent.created.elapsed() < Duration::from_secs(600)
                && !intent.cancelled.load(Ordering::Acquire);
            if !keep {
                if let Some(run) = intent.run.lock().clone() {
                    expired_runs.push(run);
                }
            }
            keep
        });
        expired_runs
    }

    pub(super) fn open(
        &self,
        intent_id: &str,
        binding: &Binding,
        key: zeroize::Zeroizing<[u8; 32]>,
        mut once: Option<super::once_authorization::OnceAuthorization>,
    ) -> Result<Arc<Session>, String> {
        let mut store = self.store.lock();
        let intent = store
            .intents
            .remove(intent_id)
            .ok_or("Secret storage authorization expired")?;
        if store.stopped
            || intent.cancelled.load(Ordering::Acquire)
            || intent.created.elapsed() >= Duration::from_secs(600)
            || intent
                .document
                .as_ref()
                .is_some_and(|document| !document.is_active())
            || &intent.binding != binding
        {
            return Err("Secret storage authorization changed".into());
        }
        let window_sessions = store
            .sessions
            .values()
            .filter(|session| session.owner.window == intent.owner.window)
            .count();
        if store.sessions.len() >= registry::MAX_SESSIONS
            || window_sessions >= registry::MAX_PER_WINDOW
            || store
                .sessions
                .values()
                .any(|session| session.owner == intent.owner)
        {
            return Err("Secret storage session capacity reached".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(proof) = once.as_mut() {
            proof.bind_session(&id);
        }
        let tool = registry::tool_name(&intent.owner.plugin);
        let session = Arc::new(Session {
            id: id.clone(),
            token: credential(),
            owner: intent.owner,
            document: intent.document,
            binding: binding.clone(),
            tool,
            key: Mutex::new(key),
            once,
            active: Mutex::new(true),
        });
        store.sessions.insert(id, session.clone());
        Ok(session)
    }

    pub(super) fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.store
            .lock()
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "Secret storage session closed".into())
    }

    pub(super) fn by_token(&self, token: &str) -> Option<Arc<Session>> {
        self.store
            .lock()
            .sessions
            .values()
            .find(|session| {
                same_token(&session.token, token)
                    && *session.active.lock()
                    && session
                        .document
                        .as_ref()
                        .is_none_or(DocumentBinding::is_active)
            })
            .cloned()
    }

    pub(super) fn existing(&self, owner: &Owner) -> Option<Arc<Session>> {
        self.store
            .lock()
            .sessions
            .values()
            .find(|session| &session.owner == owner)
            .cloned()
    }

    pub(super) fn invoke(
        &self,
        session: &Arc<Session>,
        request: serde_json::Value,
    ) -> Result<(String, Arc<Invocation>), String> {
        let mut store = self.store.lock();
        if store.invocations.len() >= registry::MAX_INFLIGHT {
            return Err("Secret storage is busy".into());
        }
        if !store.sessions.contains_key(&session.id) {
            return Err("Secret storage session closed".into());
        }
        let id = credential();
        let invocation = Arc::new(Invocation {
            session: session.id.clone(),
            request,
            run: Mutex::new(None),
            claimed: std::sync::atomic::AtomicBool::new(false),
            result: Mutex::new(None),
        });
        store.invocations.insert(id.clone(), invocation.clone());
        Ok((id, invocation))
    }

    pub(super) fn invocation(&self, id: &str) -> Option<Arc<Invocation>> {
        self.store.lock().invocations.get(id).cloned()
    }

    pub(super) fn finish_invocation(&self, id: &str) {
        self.store.lock().invocations.remove(id);
    }

    /// Linearization point for crypto completion versus session close. Close winning first
    /// records a private failure; a committed result is allowed to finish its audited TaskRun.
    pub(super) fn finish_operation(
        &self,
        session: &Session,
        invocation: &Invocation,
        result: Result<serde_json::Value, String>,
    ) -> Result<serde_json::Value, String> {
        let active = session.active.lock();
        let outcome = if *active
            && session
                .document
                .as_ref()
                .is_none_or(DocumentBinding::is_active)
        {
            result
        } else {
            Err("SESSION_UNAVAILABLE".into())
        };
        *invocation.result.lock() = Some(outcome.clone());
        outcome
    }

    pub(super) fn close(
        &self,
        owner: Option<&Owner>,
        plugin: Option<&str>,
        window: Option<&str>,
        stop: bool,
    ) -> Vec<String> {
        let mut store = self.store.lock();
        if stop {
            store.stopped = true;
        }
        let closing: HashSet<String> = store
            .sessions
            .iter()
            .filter(|(_, session)| {
                owner.is_some_and(|wanted| wanted == &session.owner)
                    || plugin.is_some_and(|wanted| wanted == session.owner.plugin)
                    || window.is_some_and(|wanted| wanted == session.owner.window)
                    || stop
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut runs = Vec::new();
        store.intents.retain(|_, intent| {
            let hit = owner.is_some_and(|wanted| wanted == &intent.owner)
                || plugin.is_some_and(|wanted| wanted == intent.owner.plugin)
                || window.is_some_and(|wanted| wanted == intent.owner.window)
                || stop;
            if hit {
                intent.cancelled.store(true, Ordering::Release);
                if let Some(run) = intent.run.lock().clone() {
                    runs.push(run);
                }
            }
            !hit
        });
        store.preparations.retain(|_, preparation| {
            !(owner.is_some_and(|wanted| wanted == &preparation.owner)
                || plugin.is_some_and(|wanted| wanted == preparation.owner.plugin)
                || window.is_some_and(|wanted| wanted == preparation.owner.window)
                || stop)
        });
        let closing_sessions: Vec<Arc<Session>> = store
            .sessions
            .iter()
            .filter(|(id, _)| closing.contains(*id))
            .map(|(_, session)| session.clone())
            .collect();
        for session in &closing_sessions {
            let invocations: Vec<Arc<Invocation>> = store
                .invocations
                .values()
                .filter(|invocation| invocation.session == session.id)
                .cloned()
                .collect();
            runs.extend(Self::close_active_operations(session, &invocations));
        }
        store.invocations.retain(|_, invocation| {
            let hit = closing.contains(&invocation.session);
            !hit
        });
        store.sessions.retain(|_, session| {
            let hit = owner.is_some_and(|wanted| wanted == &session.owner)
                || plugin.is_some_and(|wanted| wanted == session.owner.plugin)
                || window.is_some_and(|wanted| wanted == session.owner.window)
                || stop;
            !hit
        });
        runs
    }

    pub(super) fn close_document(&self, document_id: &str) -> Vec<String> {
        let mut store = self.store.lock();
        let closing: HashSet<String> = store
            .sessions
            .iter()
            .filter(|(_, session)| {
                session
                    .document
                    .as_ref()
                    .is_some_and(|document| document.id() == document_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut runs = HashSet::new();
        store
            .preparations
            .retain(|_, preparation| preparation.document.as_deref() != Some(document_id));
        store.intents.retain(|_, intent| {
            let hit = intent
                .document
                .as_ref()
                .is_some_and(|document| document.id() == document_id);
            if hit {
                intent.cancelled.store(true, Ordering::Release);
                if let Some(run) = intent.run.lock().clone() {
                    runs.insert(run);
                }
            }
            !hit
        });
        let closing_sessions: Vec<Arc<Session>> = store
            .sessions
            .iter()
            .filter(|(id, _)| closing.contains(*id))
            .map(|(_, session)| session.clone())
            .collect();
        for session in &closing_sessions {
            let invocations: Vec<Arc<Invocation>> = store
                .invocations
                .values()
                .filter(|invocation| invocation.session == session.id)
                .cloned()
                .collect();
            runs.extend(Self::close_active_operations(session, &invocations));
        }
        store.invocations.retain(|_, invocation| {
            let hit = closing.contains(&invocation.session);
            !hit
        });
        store.sessions.retain(|_, session| {
            let hit = closing.contains(&session.id);
            !hit
        });
        runs.into_iter().collect()
    }

    pub(super) fn counts(&self) -> (usize, usize, usize) {
        let store = self.store.lock();
        (
            store.sessions.len(),
            store.intents.len(),
            store.invocations.len(),
        )
    }

    pub(super) fn close_session(&self, id: &str) -> Option<Owner> {
        let mut store = self.store.lock();
        let session = store.sessions.remove(id)?;
        Self::deactivate(&session);
        let owner = session.owner.clone();
        store
            .invocations
            .retain(|_, invocation| invocation.session != id);
        Some(owner)
    }

    pub(super) async fn idle(&self) {
        if self.store.lock().sessions.is_empty() {
            self.server.lock().await.take();
        }
    }
}
