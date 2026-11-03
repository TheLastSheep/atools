use std::sync::atomic::Ordering;

use super::{ActiveSession, SessionView, SettingsViewRuntime};
use crate::{
    renderer_settings_view::phase::SessionPhase,
    renderer_window_material::{MaterialLease, MaterialReleaseToken},
};

impl SettingsViewRuntime {
    pub(crate) fn install_material_lease(
        &self,
        id: &str,
        lease: MaterialLease,
    ) -> Result<(), MaterialLease> {
        let Ok(mut inner) = self.inner.lock() else {
            return Err(lease);
        };
        let Some(session) = inner.session.as_mut().filter(|session| session.id == id) else {
            return Err(lease);
        };
        if !may_install_material(
            session.material_lease.is_some(),
            session.material_release_retry.is_some(),
            session.revoked.load(Ordering::Acquire),
            session.signals.borrow().phase,
        ) {
            return Err(lease);
        }
        session.material_lease = Some(lease);
        Ok(())
    }

    pub(crate) fn begin_material_release(
        &self,
        id: &str,
    ) -> Result<Option<MaterialReleaseToken>, String> {
        let (token, lease) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
            let session = inner
                .session
                .as_mut()
                .filter(|session| session.id == id)
                .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
            if let Some(token) = session.material_release_retry.as_ref() {
                (Some(token.clone()), None)
            } else if let Some(lease) = session.material_lease.take() {
                let token = lease.release_token();
                session.material_release_retry = Some(token.clone());
                (Some(token), Some(lease))
            } else {
                (None, None)
            }
        };
        // Dropping the lease schedules best-effort release for this exact id.
        // Keep the retry token in the session until a direct acknowledgement.
        drop(lease);
        Ok(token)
    }

    pub(crate) fn remember_rejected_material_release(
        &self,
        id: &str,
        lease: &MaterialLease,
    ) -> Option<MaterialReleaseToken> {
        let token = lease.release_token();
        let mut inner = self.inner.lock().ok()?;
        let session = inner.session.as_mut().filter(|session| session.id == id)?;
        if session.material_release_retry.is_some() {
            return None;
        }
        session.material_release_retry = Some(token.clone());
        Some(token)
    }

    pub(crate) fn finish_material_release(&self, id: &str, confirmed: bool) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let session = inner
            .session
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or_else(|| "Settings view session is no longer active".to_owned())?;
        let token = session
            .material_release_retry
            .take()
            .ok_or_else(|| "Settings window material has no pending release token".to_owned())?;
        session.material_release_retry = settle_release(token, confirmed);
        Ok(())
    }

    pub(crate) fn take_for_shutdown(&self, id: &str) -> Option<SessionView> {
        let current = self.current_for_id(id).ok()?;
        current.command_data.close();
        current.sub_input.close();
        let mut inner = self.inner.lock().ok()?;
        if !inner
            .session
            .as_ref()
            .is_some_and(|session| session.id == id)
        {
            return None;
        }
        let current = inner.session.as_ref()?;
        let key = super::super::super::open_claims::SessionKey {
            id: current.id.clone(),
            revoked_identity: std::sync::Arc::as_ptr(&current.revoked) as usize,
        };
        // A native stage may be re-entered by shutdown before its lease can be
        // installed. Keep the tombstone until that constructor exits and any
        // acquired material has a confirmed release.
        if inner.open_claims.busy(&key)
            || current.material_lease.is_some()
            || current.material_release_retry.is_some()
        {
            return None;
        }
        let mut session: ActiveSession = inner.session.take()?;
        session.revoked.store(true, Ordering::Release);
        let view = super::view_of(&session);
        let key = super::super::super::open_claims::SessionKey {
            id: view.id.clone(),
            revoked_identity: std::sync::Arc::as_ptr(&view.revoked) as usize,
        };
        inner.open_claims.invalidate_session(&key);
        let pending = super::intent::cancel_invalid_intent(&mut inner);
        let material_lease = session.material_lease.take();
        drop(session.layout_lease.take());
        drop(inner);
        drop(pending);
        drop(material_lease);
        session.command_data.close();
        Some(view)
    }
}

fn may_install_material(
    has_lease: bool,
    has_retry: bool,
    revoked: bool,
    phase: SessionPhase,
) -> bool {
    !has_lease && !has_retry && !revoked && phase == SessionPhase::Opening
}

fn settle_release<T>(token: T, confirmed: bool) -> Option<T> {
    (!confirmed).then_some(token)
}

pub(super) fn may_take_for_close(has_lease: bool, has_retry: bool) -> bool {
    !has_lease && !has_retry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer_settings_view::phase::SessionPhase;

    #[test]
    fn material_lease_installs_only_once_into_live_opening_sessions() {
        assert!(may_install_material(
            false,
            false,
            false,
            SessionPhase::Opening
        ));
        assert!(!may_install_material(
            true,
            false,
            false,
            SessionPhase::Opening
        ));
        assert!(!may_install_material(
            false,
            true,
            false,
            SessionPhase::Opening
        ));
        assert!(!may_install_material(
            false,
            false,
            true,
            SessionPhase::Opening
        ));
        assert!(!may_install_material(
            false,
            false,
            false,
            SessionPhase::Closing
        ));
    }

    #[test]
    fn failed_or_cancelled_release_keeps_the_same_token_for_retry() {
        #[derive(Clone, Debug, Eq, PartialEq)]
        struct LeaseId(u64);

        let settings_retry = LeaseId(7);
        let main_owner = Some(LeaseId(3));
        let after_failure = settle_release(settings_retry.clone(), false);
        assert_eq!(after_failure, Some(settings_retry.clone()));
        // Cancellation has no settle call, so the session retains the same id.
        let after_cancellation = after_failure.clone();
        assert_eq!(after_cancellation, Some(settings_retry.clone()));
        assert_eq!(main_owner, Some(LeaseId(3)));
        assert_ne!(after_cancellation, main_owner);
        assert_eq!(settle_release(settings_retry, true), None);
    }

    #[test]
    fn close_requires_no_active_lease_or_retry_token() {
        assert!(may_take_for_close(false, false));
        assert!(!may_take_for_close(true, false));
        assert!(!may_take_for_close(false, true));
        assert!(!may_take_for_close(true, true));
    }

    #[test]
    fn release_token_blocks_replacement_material_install() {
        assert!(may_install_material(
            false,
            false,
            false,
            SessionPhase::Opening
        ));
        assert!(!may_install_material(
            false,
            true,
            false,
            SessionPhase::Opening
        ));
    }
}
