use super::Sessions;
use crate::plugin_page_runtime::DocumentBinding;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Tracks an in-flight open so owner and document shutdown can cancel it
/// while it awaits source inspection or Node startup.
pub(super) struct OpeningLease<'a> {
    sessions: &'a Sessions,
    owner: String,
    plugin_id: String,
    cancelled: Arc<AtomicBool>,
    document: Option<DocumentBinding>,
    finished: bool,
}

impl<'a> OpeningLease<'a> {
    pub(super) fn begin(
        sessions: &'a Sessions,
        owner: &str,
        plugin_id: &str,
        cancelled: Arc<AtomicBool>,
        document: Option<DocumentBinding>,
    ) -> Self {
        sessions.openings.lock().insert(
            owner.to_owned(),
            (
                plugin_id.to_owned(),
                Arc::clone(&cancelled),
                document.clone(),
            ),
        );
        Self {
            sessions,
            owner: owner.to_owned(),
            plugin_id: plugin_id.to_owned(),
            cancelled,
            document,
            finished: false,
        }
    }

    /// Finish only after an existing session is reused or a new session has
    /// been published. Owner tombstones and lease cancellation share the
    /// openings transition so shutdown cannot slip between check and removal.
    pub(super) fn finish(mut self) -> bool {
        let allowed = {
            let cancelled_owners = self.sessions.cancelled_owners.lock();
            let mut openings = self.sessions.openings.lock();
            let current = openings
                .get(&self.owner)
                .is_some_and(|(plugin, cancel, _)| {
                    plugin == &self.plugin_id && Arc::ptr_eq(cancel, &self.cancelled)
                });
            let allowed = current
                && !self.sessions.stopping.load(Ordering::Acquire)
                && !self.cancelled.load(Ordering::Acquire)
                && !self
                    .document
                    .as_ref()
                    .is_some_and(|document| !document.is_active())
                && !cancelled_owners.contains_key(&self.owner);
            if current {
                openings.remove(&self.owner);
            }
            if !allowed {
                self.cancelled.store(true, Ordering::Release);
            }
            allowed
        };
        // Drop runs after the locks above are released and performs idle
        // transport cleanup for both success and cancellation paths.
        self.finished = true;
        allowed
    }
}

impl Drop for OpeningLease<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.cancelled.store(true, Ordering::Release);
            {
                let mut openings = self.sessions.openings.lock();
                let current = openings
                    .get(&self.owner)
                    .is_some_and(|(plugin, cancel, _)| {
                        plugin == &self.plugin_id && Arc::ptr_eq(cancel, &self.cancelled)
                    });
                if current {
                    openings.remove(&self.owner);
                }
            }
        }
        self.sessions.try_drop_idle_transport();
    }
}
