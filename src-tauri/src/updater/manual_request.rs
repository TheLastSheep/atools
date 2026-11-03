//! App-wide About request ownership, retained by the entire detached check/presentation worker.
use super::*;
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
};
pub(crate) struct ManualRequest(Arc<AtomicBool>);
impl ManualRequest {
    pub(crate) async fn hold<F: Future>(self, work: F) -> F::Output {
        let _owner = self;
        work.await
    }
}
impl Drop for ManualRequest {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl UpdateCoordinator {
    pub(crate) fn reserve_manual_request(&self) -> Result<ManualRequest, UpdateCommandError> {
        self.ensure_running()?;
        self.manual_request
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| failure("busy"))?;
        Ok(ManualRequest(self.manual_request.clone()))
    }
}
