//! Native-only About presentation principal. Admission shares all four revocation paths' inner lock.
use super::*;
#[derive(Clone)]
pub(crate) struct UpdaterGrant {
    runtime: Arc<SettingsViewRuntime>,
    session: SessionView,
    admitted: Arc<AtomicBool>,
}
impl UpdaterGrant {
    /// Linearization point transfers a live Child request to the global popup.
    /// Caller must invoke on the Native main thread immediately before show/focus.
    pub(crate) fn pending(&self) -> Result<(), String> {
        self.validate(false)
    }
    pub(crate) fn admit(&self) -> Result<(), String> {
        self.validate(true)
    }
    fn validate(&self, commit: bool) -> Result<(), String> {
        let inner = self
            .runtime
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable")?;
        let current = inner
            .session
            .as_ref()
            .ok_or("Settings view session is no longer active")?;
        if current.id != self.session.id
            || current.label != self.session.label
            || current.bundle_revision != self.session.bundle_revision
            || !Arc::ptr_eq(&current.revoked, &self.session.revoked)
            || current.revoked.load(Ordering::Acquire)
            || current.signals.borrow().phase == SessionPhase::Closing
            || current.started_count != 1
            || current.bundle.revision() != current.bundle_revision
            || self.admitted.load(Ordering::Acquire)
        {
            return Err("Settings view update display grant is revoked".into());
        }
        if commit {
            self.admitted.store(true, Ordering::Release);
        }
        Ok(())
    }
}
impl SettingsViewRuntime {
    pub(crate) fn updater_grant(
        self: &Arc<Self>,
        session: &SessionView,
    ) -> Result<UpdaterGrant, String> {
        let current = self.current_for_id(&session.id)?;
        if current.is_revoked()
            || !Arc::ptr_eq(&current.revoked, &session.revoked)
            || current.bundle_revision != session.bundle_revision
        {
            return Err("Settings view session is no longer active".into());
        }
        Ok(UpdaterGrant {
            runtime: self.clone(),
            session: session.clone(),
            admitted: Arc::new(AtomicBool::new(false)),
        })
    }
}

#[cfg(test)]
#[path = "session_runtime_updater_tests.rs"]
mod tests;
