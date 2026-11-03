//! One-shot authorization to session handoff for the display runtime.
use super::sessions::credential;
use super::sessions::{Binding, Session, Sessions};
use parking_lot::Mutex;
use std::sync::atomic::Ordering;
use std::sync::Arc;

impl Sessions {
    pub fn open(
        &self,
        id: &str,
        plugin: &atools_core::Plugin,
        binding: &Binding,
    ) -> Result<Arc<Session>, String> {
        let mut state = self.store.lock();
        let intent = state
            .intents
            .get(id)
            .cloned()
            .ok_or("Display authorization expired")?;
        if state.stopped
            || state.closed.contains_key(&intent.owner)
            || state.successors.contains_key(&intent.owner)
            || intent.plugin != plugin.id
            || &intent.binding != binding
            || intent.created.elapsed().as_secs() >= 600
            || intent.cancelled.load(Ordering::Acquire)
            || intent.document.as_ref().is_some_and(|d| !d.is_active())
            || intent.claimed.load(Ordering::Acquire)
        {
            return Err("Display authorization was cancelled or already consumed".into());
        }
        if state.sessions.values().any(|session| {
            session.owner == intent.owner
                && session.plugin == plugin.id
                && session.document.as_ref().map(|d| d.id())
                    == intent.document.as_ref().map(|d| d.id())
                && &session.binding == binding
                && session.path == plugin.path
                && session.version == plugin.version
        }) {
            return Err("Display session already opened".into());
        }
        if state.sessions.len() >= 32 {
            return Err("Too many active display sessions".into());
        }
        if intent
            .claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("Display authorization was cancelled or already consumed".into());
        }
        let session = Arc::new(Session {
            id: credential(),
            token: credential(),
            owner: intent.owner,
            document: intent.document,
            plugin: plugin.id.clone(),
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            binding: binding.clone(),
            tool: super::registry::tool_name(&plugin.id),
            opening_intent: Mutex::new(Some(id.into())),
            opener_run: intent.run.clone(),
            active: Mutex::new(true),
        });
        state.sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }

    /// Retire the authorization only after transport startup succeeded. The
    /// session must be the one created by this exact intent, not a same-owner
    /// session with matching plugin metadata.
    pub fn complete_open(&self, intent_id: &str, session_id: &str) -> Result<(), String> {
        let mut state = self.store.lock();
        let intent = state
            .intents
            .get(intent_id)
            .cloned()
            .ok_or("Display authorization was cancelled")?;
        let session = state
            .sessions
            .get(session_id)
            .cloned()
            .ok_or("Display session closed during opening")?;
        if state.stopped
            || intent.cancelled.load(Ordering::Acquire)
            || !intent.claimed.load(Ordering::Acquire)
            || intent.created.elapsed().as_secs() >= 600
            || intent.owner != session.owner
            || intent.plugin != session.plugin
            || intent.binding != session.binding
            || intent.document.as_ref().map(|d| d.id()) != session.document.as_ref().map(|d| d.id())
            || session.opening_intent.lock().as_deref() != Some(intent_id)
            || !Arc::ptr_eq(&intent.run, &session.opener_run)
            || !*session.active.lock()
            || session.document.as_ref().is_some_and(|d| !d.is_active())
        {
            return Err("Display opening was cancelled".into());
        }
        *session.opening_intent.lock() = None;
        state.intents.remove(intent_id);
        Ok(())
    }

    /// Retire only the exact claimed intent/session pair when opening fails.
    /// Owner close may win while transport startup is awaiting; in that case
    /// close already removed and cancelled the intent, so this is a no-op.
    pub async fn abort_open(&self, intent_id: &str, session_id: &str) -> bool {
        let removed = {
            let mut state = self.store.lock();
            let Some(intent) = state.intents.get(intent_id) else {
                return false;
            };
            let Some(session) = state.sessions.get(session_id).cloned() else {
                return false;
            };
            let exact_pair = intent.claimed.load(Ordering::Acquire)
                && intent.owner == session.owner
                && intent.plugin == session.plugin
                && intent.binding == session.binding
                && intent.document.as_ref().map(|document| document.id())
                    == session.document.as_ref().map(|document| document.id())
                && Arc::ptr_eq(&intent.run, &session.opener_run)
                && session.opening_intent.lock().as_deref() == Some(intent_id);
            if !exact_pair {
                return false;
            }
            let Some(intent) = state.intents.remove(intent_id) else {
                return false;
            };
            let Some(session) = state.sessions.remove(session_id) else {
                state.intents.insert(intent_id.to_string(), intent);
                return false;
            };
            intent.cancelled.store(true, Ordering::Release);
            Some(session)
        };
        if let Some(session) = removed {
            *session.active.lock() = false;
            self.idle().await;
            true
        } else {
            false
        }
    }
}
