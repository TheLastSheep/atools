//! A displayed candidate cannot be silently replaced until real Native destruction.
use super::*;
#[derive(Clone)]
pub(crate) struct PresentationLease(Arc<Lease>);
struct Lease {
    state: UpdateCoordinator,
    window: String,
    candidate: String,
}
impl PresentationLease {
    pub(crate) fn release(&self) {
        self.0.release();
    }
}
impl Lease {
    fn release(&self) {
        if let Ok(mut s) = self.state.lock_snapshot() {
            if s.presentation.as_ref() == Some(&(self.window.clone(), self.candidate.clone())) {
                s.presentation = None;
            }
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.release();
    }
}
impl UpdateCoordinator {
    #[cfg(test)]
    pub(crate) fn uncached_for_presentation_test() -> Self {
        let mut state = Self::default();
        state.cache_ttl = Duration::ZERO;
        state
    }
    pub(crate) async fn reserve_about_presentation(
        &self,
        window: &str,
        candidate: &str,
    ) -> Result<PresentationLease, UpdateCommandError> {
        let permit = self
            .operation_gate
            .try_lock()
            .map_err(|_| failure("busy"))?;
        self.pin_admitted(window, candidate, &permit)
    }

    pub(crate) async fn reserve_presentation(
        &self,
        window: &str,
        candidate: &str,
    ) -> Result<PresentationLease, UpdateCommandError> {
        let permit = self.operation_gate.lock().await;
        self.pin_admitted(window, candidate, &permit)
    }
    fn pin_admitted(
        &self,
        window: &str,
        candidate: &str,
        _permit: &tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<PresentationLease, UpdateCommandError> {
        self.ensure_running()?;
        let mut s = self.lock_snapshot()?;
        let current = s
            .cached
            .as_ref()
            .and_then(|v| v.as_ref())
            .map(|v| v.candidate_id.as_str());
        if current != Some(candidate) {
            return Err(failure("stale_candidate"));
        }
        if s.presentation.is_some() {
            return Err(failure("busy"));
        }
        s.presentation = Some((window.to_owned(), candidate.to_owned()));
        Ok(PresentationLease(Arc::new(Lease {
            state: self.clone(),
            window: window.into(),
            candidate: candidate.into(),
        })))
    }
}
