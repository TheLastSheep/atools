//! Pending intent and native binding mutations share the open-claim mutex.
use crate::renderer_settings_view as settings;
use super::{RuntimeInner, SettingsViewRuntime};
use settings::{
    intent_protocol::{IntentAck, PendingIntent},
    main_authority::{same_webview, same_window, MainBinding},
    open_claims::{Adoption, ClaimId, ClosingTicket, MainKey, SessionKey},
    session::SessionView,
};
use std::sync::Arc;
use tauri::{Webview, Window, Wry};
use tokio::sync::oneshot;

pub(super) fn cancel_invalid_intent(inner: &mut RuntimeInner) -> Option<PendingIntent> {
    let pending = inner.pending_intent.as_ref()?;
    let valid = inner.open_claims.matches_intent(
        pending.claim,
        pending.main,
        pending.sequence,
        &pending.session,
    ) && inner.session.as_ref().is_some_and(|s| {
        s.id == pending.session.id
            && Arc::as_ptr(&s.revoked) as usize == pending.session.revoked_identity
            && !s.revoked.load(std::sync::atomic::Ordering::Acquire)
            && s.signals.borrow().ready
            && s.signals.borrow().phase != settings::phase::SessionPhase::Closing
    });
    if valid {
        return None;
    }
    let pending = inner.pending_intent.take()?;
    // The existing close/revoke path owns cleanup when the document is gone.
    inner.open_claims.abandon(pending.claim);
    Some(pending)
}

pub(crate) fn session_key(session: &SessionView) -> SessionKey {
    SessionKey {
        id: session.id.clone(),
        revoked_identity: Arc::as_ptr(&session.revoked) as usize,
    }
}

impl SettingsViewRuntime {
    pub(crate) fn bind_main_handles(&self, key: MainKey, view: &Webview<Wry>) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.open_claims.current_key() == Some(key) {
                inner.main_binding = Some(MainBinding {
                    key,
                    webview: view.clone(),
                    window: view.window(),
                });
            }
        }
    }
    pub(crate) fn bound_main_key(&self, instance: u64, view: &Webview<Wry>) -> Option<MainKey> {
        let inner = self.inner.lock().ok()?;
        let binding = inner.main_binding.as_ref()?;
        (binding.key.window_instance == instance
            && inner.open_claims.current_key() == Some(binding.key)
            && same_webview(&binding.webview, view)
            && same_window(&binding.window, &view.window()))
        .then_some(binding.key)
    }
    pub(crate) fn capture_main_binding(
        &self,
        view: &Webview<Wry>,
        window: &Window<Wry>,
    ) -> Option<MainKey> {
        let inner = self.inner.lock().ok()?;
        let binding = inner.main_binding.as_ref()?;
        (inner.open_claims.finished_main() == Some(binding.key)
            && same_webview(&binding.webview, view)
            && same_window(&binding.window, window))
        .then_some(binding.key)
    }
    pub(crate) fn main_instance_for_window(&self, window: &Window<Wry>) -> Option<u64> {
        let inner = self.inner.lock().ok()?;
        let binding = inner.main_binding.as_ref()?;
        same_window(&binding.window, window).then_some(binding.key.window_instance)
    }

    pub(crate) fn reserve_intent(
        &self,
        id: String,
        sequence: u64,
        session: &SessionView,
        claim: ClaimId,
        main: MainKey,
    ) -> Result<oneshot::Receiver<bool>, String> {
        let key = session_key(session);
        let (reply, receiver) = oneshot::channel();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings state unavailable")?;
        if !inner
            .open_claims
            .matches_intent(claim, main, sequence, &key)
            || inner.pending_intent.is_some()
            || inner.session.as_ref().is_none_or(|s| {
                s.id != key.id
                    || Arc::as_ptr(&s.revoked) as usize != key.revoked_identity
                    || s.revoked.load(std::sync::atomic::Ordering::Acquire)
                    || !s.signals.borrow().ready
                    || s.signals.borrow().phase != settings::phase::SessionPhase::Open
            })
        {
            return Err("Settings intent is no longer current".into());
        }
        inner.pending_intent = Some(PendingIntent {
            id,
            sequence,
            session: key,
            claim,
            main,
            reply,
        });
        Ok(receiver)
    }

    pub(crate) fn intent_pending(
        &self,
        id: &str,
        sequence: u64,
        claim: ClaimId,
        session: &SessionView,
    ) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            inner.pending_intent.as_ref().is_some_and(|p| {
                p.id == id
                    && p.sequence == sequence
                    && p.claim == claim
                    && p.session == session_key(session)
                    && inner
                        .open_claims
                        .matches_intent(p.claim, p.main, p.sequence, &p.session)
            })
        })
    }

    pub(crate) fn acknowledge_intent(
        &self,
        session: &SessionView,
        ack: IntentAck,
    ) -> Result<Option<ClosingTicket>, String> {
        let (pending, ticket) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings state unavailable")?;
            let key = session_key(session);
            let pending = inner
                .pending_intent
                .as_ref()
                .filter(|p| p.id == ack.id && p.sequence == ack.sequence && p.session == key)
                .ok_or("Settings intent acknowledgement is stale")?;
            if !inner.open_claims.matches_intent(
                pending.claim,
                pending.main,
                pending.sequence,
                &key,
            ) || inner.session.as_ref().is_none_or(|s| {
                s.id != key.id
                    || Arc::as_ptr(&s.revoked) as usize != key.revoked_identity
                    || s.revoked.load(std::sync::atomic::Ordering::Acquire)
                    || !s.signals.borrow().ready
                    || s.signals.borrow().phase != settings::phase::SessionPhase::Open
            }) {
                return Err("Settings intent acknowledgement is inactive".into());
            }
            let claim = pending.claim;
            let ticket = if ack.accepted {
                inner
                    .open_claims
                    .adopt(claim, Adoption::IntentAckAccepted)?;
                None
            } else {
                inner.open_claims.abandon(claim)
            };
            (
                inner.pending_intent.take().expect("matched pending"),
                ticket,
            )
        };
        let _ = pending.reply.send(ack.accepted);
        Ok(ticket)
    }

    pub(crate) fn cancel_intent(
        &self,
        id: &str,
        sequence: u64,
        claim: ClaimId,
    ) -> Option<ClosingTicket> {
        let (pending, ticket) = {
            let mut inner = self.inner.lock().ok()?;
            let matches = inner
                .pending_intent
                .as_ref()
                .is_some_and(|p| p.id == id && p.sequence == sequence && p.claim == claim);
            if !matches {
                return None;
            }
            let pending = inner.pending_intent.take();
            (pending, inner.open_claims.abandon(claim))
        };
        drop(pending);
        ticket
    }
}

#[cfg(test)]
#[path = "session_runtime_intent_tests.rs"]
mod tests;
