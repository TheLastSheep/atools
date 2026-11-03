//! Session identity arbitration for requested-height candidates.
use super::{SessionPhase, SessionView, SettingsViewRuntime};
use std::sync::atomic::Ordering;

impl SettingsViewRuntime {
    pub(crate) fn stage_height(&self, view: &SessionView, default: f64) -> Result<f64, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable")?;
        let session = inner
            .session
            .as_ref()
            .filter(|session| {
                session.id == view.id && session.bundle_revision == view.bundle_revision
            })
            .filter(|session| {
                !session.revoked.load(Ordering::Acquire)
                    && session.signals.borrow().phase == SessionPhase::Opening
            })
            .ok_or("Settings view height session is no longer opening")?;
        let id = session.id.clone();
        let bundle = session.bundle_revision.clone();
        Ok(inner.heights.stage(&id, &bundle, default))
    }
}

#[cfg(test)]
#[path = "session_runtime_height_tests.rs"]
mod tests;
