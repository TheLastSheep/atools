use crate::plugin_loopback::OriginPolicy;
use parking_lot::Mutex;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

/// Origin authority is created by Rust, never reconstructed from request data.
/// Clones share immediate revocation, including sessions already opened.
#[derive(Clone)]
pub(crate) struct DocumentBinding {
    id: Arc<str>,
    origin: OriginPolicy,
    active: Arc<AtomicBool>,
    deadline: Arc<Mutex<Option<Instant>>>,
}

impl DocumentBinding {
    pub(super) fn new(id: &str, origin: &str) -> Result<Self, String> {
        Ok(Self {
            id: id.into(),
            origin: OriginPolicy::exact(origin)?,
            active: Arc::new(AtomicBool::new(true)),
            // User approval may take arbitrarily long before a URL is loaded.
            // Only the active bootstrap handoff starts a deadline.
            deadline: Arc::new(Mutex::new(None)),
        })
    }
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn origin_policy(&self) -> OriginPolicy {
        self.origin.clone()
    }
    pub(crate) fn is_active(&self) -> bool {
        if self
            .deadline
            .lock()
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.revoke();
        }
        self.active.load(Ordering::Acquire)
    }
    pub(super) fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }
    pub(super) fn begin_handoff(&self) {
        *self.deadline.lock() = Some(Instant::now() + Duration::from_secs(5));
    }
    pub(super) fn finish_handoff(&self) {
        *self.deadline.lock() = None;
    }
    pub(super) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.active, &other.active)
    }
    #[cfg(test)]
    pub(super) fn expire(&self) {
        *self.deadline.lock() = Some(Instant::now());
    }
}

#[cfg(test)]
pub(crate) fn test_binding() -> (DocumentBinding, Arc<AtomicBool>) {
    let id = uuid::Uuid::new_v4();
    let binding = DocumentBinding::new(
        &id.to_string(),
        &format!("atools-page://{}.localhost", id.simple()),
    )
    .unwrap();
    binding.finish_handoff();
    let active = binding.active.clone();
    (binding, active)
}
