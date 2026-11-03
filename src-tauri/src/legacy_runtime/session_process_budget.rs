use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const NODE_PROCESS_LIMIT: usize = 4;
const NODE_PROCESS_LIMIT_ERROR: &str =
    "Close an active Node plugin before opening another (limit 4)";

pub(super) struct NodeProcessBudget(Arc<Semaphore>);

impl Default for NodeProcessBudget {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(NODE_PROCESS_LIMIT)))
    }
}

impl NodeProcessBudget {
    pub(super) fn reserve(&self) -> Result<OwnedSemaphorePermit, String> {
        Arc::clone(&self.0)
            .try_acquire_owned()
            .map_err(|_| NODE_PROCESS_LIMIT_ERROR.to_owned())
    }

    #[cfg(test)]
    pub(super) fn available(&self) -> usize {
        self.0.available_permits()
    }
}
