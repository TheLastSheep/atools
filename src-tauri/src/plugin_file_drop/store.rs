use super::types::{Request, Selection};
use super::TimerHandle;
use parking_lot::Mutex;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Default)]
pub(super) struct Store {
    pub selections: HashMap<String, Selection>,
    pub requests: HashMap<String, Arc<Request>>,
    pub selection_timers: HashMap<String, TimerHandle>,
    pub request_timers: HashMap<String, TimerHandle>,
    pub stopped: bool,
}
pub(crate) struct Runtime {
    pub(super) store: Mutex<Store>,
    pub(super) reads: Arc<Semaphore>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            store: Mutex::new(Store::default()),
            reads: Arc::new(Semaphore::new(1)),
        }
    }
}
impl Runtime {
    pub fn read_permit(&self) -> Result<OwnedSemaphorePermit, String> {
        self.reads
            .clone()
            .try_acquire_owned()
            .map_err(|_| "File-drop read already active".into())
    }
}
