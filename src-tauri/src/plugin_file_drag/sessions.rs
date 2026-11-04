//! Bounded, owner-bound file-drag sessions and one-shot requests.
use super::types::{
    credential, same_token, Binding, Intent, Invocation, Owner, Session,
    INVOCATION_CANCELLED_BEFORE_START, INVOCATION_FINISHED, MAX_INVOCATIONS, MAX_PENDING_INTENTS,
    MAX_SESSIONS, SESSION_TTL,
};
use crate::{plugin_loopback::BridgeServer, plugin_page_runtime::DocumentBinding};
use parking_lot::Mutex;
use std::{collections::HashMap, sync::Arc, time::Instant};
use tauri::AppHandle;

pub(super) type TimerHandle = tauri::async_runtime::JoinHandle<()>;

#[derive(Default)]
pub(super) struct Store {
    pub sessions: HashMap<String, Arc<Session>>,
    pub intents: HashMap<String, Intent>,
    pub invocations: HashMap<String, Arc<Invocation>>,
    pub preparations: HashMap<String, PreparationState>,
    pub intent_timers: HashMap<String, TimerHandle>,
    pub session_timers: HashMap<String, TimerHandle>,
    pub stopped: bool,
}

pub(super) struct PreparationState {
    pub owner: Owner,
    pub document_id: Option<String>,
}

pub(crate) struct Sessions {
    pub(super) store: Mutex<Store>,
    pub(super) server: tokio::sync::Mutex<Option<BridgeServer>>,
    /// Serializes listener and AppKit monitor setup/teardown. Preparation is
    /// registered before awaiting this lock, so idle teardown sees new owners.
    pub(super) control: tokio::sync::Mutex<()>,
}

impl Default for Sessions {
    fn default() -> Self {
        Self {
            store: Mutex::new(Store::default()),
            server: tokio::sync::Mutex::new(None),
            control: tokio::sync::Mutex::new(()),
        }
    }
}

pub(crate) struct Preparation {
    pub id: String,
    pub owner: Owner,
    runtime: std::sync::Weak<Sessions>,
    app: AppHandle,
}

impl Drop for Preparation {
    fn drop(&mut self) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        runtime.store.lock().preparations.remove(&self.id);
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move { runtime.idle(&app).await });
    }
}

impl Sessions {
    pub fn begin(
        self: &Arc<Self>,
        app: &AppHandle,
        owner: Owner,
        document: Option<&DocumentBinding>,
    ) -> Result<Preparation, String> {
        let document_id = document.map(|binding| binding.id().to_owned());
        if document.is_some_and(|binding| !binding.is_active()) {
            return Err("Plugin document closed".into());
        }
        let mut state = self.store.lock();
        let window_count = state
            .sessions
            .values()
            .filter(|session| session.owner.window == owner.window)
            .count()
            + state
                .intents
                .values()
                .filter(|intent| intent.owner.window == owner.window)
                .count()
            + state
                .preparations
                .values()
                .filter(|preparation| preparation.owner.window == owner.window)
                .count();
        if state.stopped
            || state.sessions.len() + state.intents.len() + state.preparations.len() >= MAX_SESSIONS
            || window_count >= MAX_SESSIONS
            || state
                .sessions
                .values()
                .any(|session| session.owner == owner)
            || state.intents.values().any(|intent| intent.owner == owner)
            || state
                .preparations
                .values()
                .any(|preparation| preparation.owner == owner)
        {
            return Err("File-drag preparation is unavailable for this plugin instance".into());
        }
        let id = credential();
        state.preparations.insert(
            id.clone(),
            PreparationState {
                owner: owner.clone(),
                document_id,
            },
        );
        Ok(Preparation {
            id,
            owner,
            runtime: Arc::downgrade(self),
            app: app.clone(),
        })
    }

    pub fn preparation_active(&self, preparation: &Preparation) -> bool {
        let state = self.store.lock();
        !state.stopped
            && state
                .preparations
                .get(&preparation.id)
                .is_some_and(|current| current.owner == preparation.owner)
    }

    pub fn create_intent(
        self: &Arc<Self>,
        preparation: Preparation,
        binding: Binding,
        document: Option<DocumentBinding>,
    ) -> Result<String, String> {
        let mut state = self.store.lock();
        let registered = state.preparations.remove(&preparation.id);
        let document_id = document.as_ref().map(|binding| binding.id().to_owned());
        if state.stopped
            || registered.as_ref().is_none_or(|registered| {
                registered.owner != preparation.owner || registered.document_id != document_id
            })
            || document
                .as_ref()
                .is_some_and(|binding| !binding.is_active())
        {
            return Err("File-drag preparation was cancelled".into());
        }
        if state.intents.len() >= MAX_PENDING_INTENTS
            || state
                .intents
                .values()
                .filter(|intent| intent.owner.window == preparation.owner.window)
                .count()
                >= MAX_SESSIONS
        {
            return Err("Too many pending file-drag approvals".into());
        }
        let id = credential();
        state.intents.insert(
            id.clone(),
            Intent {
                owner: preparation.owner.clone(),
                document,
                binding,
                created: Instant::now(),
                cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                run: Arc::new(Mutex::new(None)),
            },
        );
        drop(state);
        let remaining = SESSION_TTL;
        self.register_intent_timer(&preparation.app, &id, remaining);
        Ok(id)
    }

    pub fn register_intent_timer(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        delay: std::time::Duration,
    ) {
        let runtime = self.clone();
        let app = app.clone();
        let id_owned = id.to_owned();
        let timer = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            super::lifecycle::expire_intent(&app, &runtime, &id_owned);
        });
        let mut state = self.store.lock();
        if state.intents.contains_key(id) {
            if let Some(old) = state.intent_timers.insert(id.to_owned(), timer) {
                old.abort();
            }
        } else {
            timer.abort();
        }
    }

    pub fn bind_intent_run(&self, intent_id: &str, run_id: &str) -> Result<(), String> {
        let state = self.store.lock();
        let intent = state
            .intents
            .get(intent_id)
            .ok_or("File-drag authorization expired")?;
        bind_once(&intent.run, run_id)
    }

    pub fn bind_invocation_run(&self, invocation_id: &str, run_id: &str) -> Result<(), String> {
        let state = self.store.lock();
        let invocation = state
            .invocations
            .get(invocation_id)
            .ok_or("File-drag invocation expired")?;
        bind_once(&invocation.run, run_id)
    }

    pub fn get_intent(&self, id: &str) -> Result<Intent, String> {
        self.store
            .lock()
            .intents
            .get(id)
            .cloned()
            .ok_or_else(|| "File-drag authorization expired".into())
    }

    pub fn open(
        &self,
        intent_id: &str,
        binding: &Binding,
        tool: &str,
        mut once_authorization: Option<super::authorization::OnceAuthorization>,
    ) -> Result<Arc<Session>, String> {
        let mut state = self.store.lock();
        let intent = state
            .intents
            .remove(intent_id)
            .ok_or("File-drag authorization expired or was consumed")?;
        if let Some(timer) = state.intent_timers.remove(intent_id) {
            timer.abort();
        }
        if state.stopped
            || intent.binding != *binding
            || intent.created.elapsed() >= SESSION_TTL
            || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
            || intent
                .document
                .as_ref()
                .is_some_and(|document| !document.is_active())
        {
            return Err("File-drag authorization changed; reopen the plugin".into());
        }
        let per_window = state
            .sessions
            .values()
            .filter(|session| session.owner.window == intent.owner.window)
            .count();
        if state.sessions.len() >= MAX_SESSIONS
            || per_window >= MAX_SESSIONS
            || state
                .sessions
                .values()
                .any(|session| session.owner == intent.owner)
        {
            return Err("File-drag session capacity reached".into());
        }
        let id = credential();
        let now = Instant::now();
        let expires_at = once_authorization
            .as_ref()
            .map(|proof| now + std::time::Duration::from_millis(proof.remaining_ms()))
            .unwrap_or(now + SESSION_TTL)
            .min(now + SESSION_TTL);
        if let Some(proof) = once_authorization.as_mut() {
            proof.bind_session(&id);
        }
        let session = Arc::new(Session {
            id: id.clone(),
            token: credential(),
            owner: intent.owner,
            document: intent.document,
            binding: binding.clone(),
            tool: tool.to_owned(),
            once_authorization,
            created: now,
            expires_at,
            active: std::sync::atomic::AtomicBool::new(true),
        });
        state.sessions.insert(id, session.clone());
        Ok(session)
    }

    pub fn register_session_timer(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        delay: std::time::Duration,
    ) {
        let runtime = self.clone();
        let app = app.clone();
        let id_owned = id.to_owned();
        let timer = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            super::lifecycle::expire_session(&app, &runtime, &id_owned);
        });
        let mut state = self.store.lock();
        if state.sessions.contains_key(id) {
            if let Some(old) = state.session_timers.insert(id.to_owned(), timer) {
                old.abort();
            }
        } else {
            timer.abort();
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.store
            .lock()
            .sessions
            .get(id)
            .cloned()
            .filter(|session| session.valid())
            .ok_or_else(|| "File-drag session closed; reopen the plugin".into())
    }

    pub fn by_token(&self, token: &str) -> Option<Arc<Session>> {
        self.store
            .lock()
            .sessions
            .values()
            .find(|session| same_token(&session.token, token) && session.valid())
            .cloned()
    }

    pub fn existing(&self, owner: &Owner) -> Option<Arc<Session>> {
        self.store
            .lock()
            .sessions
            .values()
            .find(|session| &session.owner == owner && session.valid())
            .cloned()
    }

    pub fn insert_invocation(&self, invocation: Arc<Invocation>) -> Result<(), String> {
        let mut state = self.store.lock();
        let Some(session) = state.sessions.get(&invocation.session) else {
            return Err("File-drag session closed".into());
        };
        let session_valid = session.valid();
        if state.stopped
            || !session_valid
            || state.invocations.len() >= MAX_INVOCATIONS
            || state.invocations.values().any(|current| {
                current.owner.window == invocation.owner.window
                    && !matches!(
                        current.phase(),
                        INVOCATION_FINISHED | INVOCATION_CANCELLED_BEFORE_START
                    )
            })
            || state.invocations.contains_key(&invocation.id)
        {
            return Err("A native file-drag request is already active for this window".into());
        }
        state.invocations.insert(invocation.id.clone(), invocation);
        Ok(())
    }

    pub fn invocation(&self, id: &str) -> Result<Arc<Invocation>, String> {
        self.store
            .lock()
            .invocations
            .get(id)
            .cloned()
            .ok_or_else(|| "File-drag invocation expired".into())
    }

    pub fn remove_intent(&self, id: &str) -> Option<Intent> {
        let mut state = self.store.lock();
        if let Some(timer) = state.intent_timers.remove(id) {
            timer.abort();
        }
        state.intents.remove(id)
    }

    pub fn remove_invocation(&self, id: &str) -> Option<Arc<Invocation>> {
        let invocation = {
            let mut state = self.store.lock();
            state.invocations.remove(id)
        };
        if let Some(invocation) = &invocation {
            invocation.paths.lock().take();
        }
        invocation
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn remove_session(&self, id: &str) -> Option<Arc<Session>> {
        let mut state = self.store.lock();
        if let Some(timer) = state.session_timers.remove(id) {
            timer.abort();
        }
        state.sessions.remove(id)
    }
}

fn bind_once(slot: &Mutex<Option<String>>, run_id: &str) -> Result<(), String> {
    let mut existing = slot.lock();
    if existing.as_deref().is_some_and(|value| value != run_id) {
        return Err("File-drag ticket already belongs to another TaskRun".into());
    }
    *existing = Some(run_id.to_owned());
    Ok(())
}
