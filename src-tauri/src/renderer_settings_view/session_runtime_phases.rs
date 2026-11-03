use super::super::super::phase::SessionPhase;
use super::{view_of, SessionView, SettingsViewRuntime};
use std::sync::{atomic::Ordering, Arc};

impl SettingsViewRuntime {
    pub(crate) fn mark_opened_with(
        &self,
        id: &str,
        emit: impl FnOnce(&SessionView) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        let current = session.signals.borrow().clone();
        if current.phase != SessionPhase::Opening || session.revoked.load(Ordering::Acquire) {
            return Err("Settings view session ended before its opened phase".into());
        }
        let view = view_of(session);
        let mut signal = session.signals.borrow().clone();
        signal.opened = true;
        session.signals.send_replace(signal);
        drop(inner);
        emit(&view)?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_ref()
            .filter(|session| session.id == id && Arc::ptr_eq(&session.revoked, &view.revoked))
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        if session.signals.borrow().phase != SessionPhase::Opening
            || session.revoked.load(Ordering::Acquire)
        {
            return Err("Settings view session ended during its opened phase".into());
        }
        Ok(())
    }

    pub(crate) fn mark_open_with(
        &self,
        id: &str,
        emit: impl FnOnce(&SessionView) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        let signal = session.signals.borrow().clone();
        if signal.phase != SessionPhase::Opening
            || !signal.opened
            || !signal.ready
            || session.revoked.load(Ordering::Acquire)
        {
            return Err("Settings view session ended before its loaded phase".into());
        }
        let view = view_of(session);
        drop(inner);
        emit(&view)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_mut()
            .filter(|session| session.id == id && Arc::ptr_eq(&session.revoked, &view.revoked))
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        let mut signal = session.signals.borrow().clone();
        if signal.phase != SessionPhase::Opening
            || !signal.opened
            || !signal.ready
            || session.revoked.load(Ordering::Acquire)
        {
            return Err("Settings view session ended during its loaded phase".into());
        }
        signal.phase = SessionPhase::Open;
        session.signals.send_replace(signal);
        inner.heights.confirm(&view.id, &view.bundle_revision);
        Ok(())
    }
    pub(crate) fn emit_close_phases(
        &self,
        id: &str,
        include_back: bool,
        mut emit: impl FnMut(&SessionView, &'static str) -> Result<(), String>,
    ) -> Result<(), String> {
        for phase in ["closed", "back-to-search"] {
            if phase == "back-to-search" && !include_back {
                continue;
            }
            let view = {
                let inner = self
                    .inner
                    .lock()
                    .map_err(|_| "Settings view runtime state is unavailable")?;
                let session = inner
                    .session
                    .as_ref()
                    .filter(|s| s.id == id)
                    .ok_or("Settings view session is no longer active")?;
                if session.signals.borrow().phase != SessionPhase::Closing
                    || !session.revoked.load(Ordering::Acquire)
                {
                    return Err("Settings view session is not fenced for closure".into());
                }
                if (phase == "closed" && session.closed_phase_emitted)
                    || (phase == "back-to-search" && session.back_phase_emitted)
                {
                    continue;
                }
                view_of(session)
            };
            emit(&view, phase)?;
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings view runtime state is unavailable")?;
            let session = inner
                .session
                .as_mut()
                .filter(|s| s.id == id && Arc::ptr_eq(&s.revoked, &view.revoked))
                .ok_or("Settings view session changed during close notification")?;
            if session.signals.borrow().phase != SessionPhase::Closing
                || !session.revoked.load(Ordering::Acquire)
            {
                return Err("Settings view session is not fenced for closure".into());
            }
            if phase == "closed" {
                session.closed_phase_emitted = true;
            } else {
                session.back_phase_emitted = true;
            }
        }
        Ok(())
    }
}
