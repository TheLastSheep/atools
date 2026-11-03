use super::NativeImageError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone, Default)]
pub(crate) struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Default)]
pub(crate) struct WorkerGate(Arc<AtomicBool>);

impl WorkerGate {
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(super) fn is_busy(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub(crate) fn try_acquire(&self) -> Result<WorkerPermit, NativeImageError> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| NativeImageError::WorkerBusy)?;
        Ok(WorkerPermit(Arc::new(WorkerLease(Arc::clone(&self.0)))))
    }
}

/// A shared worker admission lease. The gate is released only after the last
/// permit or retained closure lease has gone away.
pub(crate) struct WorkerPermit(Arc<WorkerLease>);

impl WorkerPermit {
    pub(crate) fn retain(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

struct WorkerLease(Arc<AtomicBool>);

impl Drop for WorkerLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
