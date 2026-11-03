use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ActivitySnapshot {
    pub(crate) pending_calls: usize,
    pub(crate) pending_writes: usize,
}

pub(crate) struct RuntimeAccounting {
    counts: Mutex<ActivitySnapshot>,
    writes_changed: watch::Sender<usize>,
}

impl Default for RuntimeAccounting {
    fn default() -> Self {
        let (writes_changed, _) = watch::channel(0);
        Self {
            counts: Mutex::new(ActivitySnapshot::default()),
            writes_changed,
        }
    }
}

impl RuntimeAccounting {
    pub(crate) fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub(crate) fn track_call(self: &Arc<Self>) -> RuntimeActivityGuard {
        self.with_counts(|counts| {
            counts.pending_calls = counts.pending_calls.saturating_add(1);
        });
        RuntimeActivityGuard {
            accounting: Arc::clone(self),
            activity: ActivityKind::Call,
        }
    }

    pub(crate) fn track_write(self: &Arc<Self>) -> RuntimeActivityGuard {
        self.with_counts(|counts| {
            counts.pending_writes = counts.pending_writes.saturating_add(1);
            self.writes_changed.send_replace(counts.pending_writes);
        });
        RuntimeActivityGuard {
            accounting: Arc::clone(self),
            activity: ActivityKind::Write,
        }
    }

    pub(crate) fn snapshot(&self) -> ActivitySnapshot {
        *self.lock_counts()
    }

    pub(crate) async fn wait_for_writes_to_finish(&self) {
        let mut changed = self.writes_changed.subscribe();
        loop {
            if *changed.borrow_and_update() == 0 {
                return;
            }
            if changed.changed().await.is_err() {
                return;
            }
        }
    }

    fn with_counts(&self, update: impl FnOnce(&mut ActivitySnapshot)) {
        let mut counts = self.lock_counts();
        update(&mut counts);
    }

    fn lock_counts(&self) -> MutexGuard<'_, ActivitySnapshot> {
        self.counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Clone, Copy)]
enum ActivityKind {
    Call,
    Write,
}

pub(crate) struct RuntimeActivityGuard {
    accounting: Arc<RuntimeAccounting>,
    activity: ActivityKind,
}

impl Drop for RuntimeActivityGuard {
    fn drop(&mut self) {
        self.accounting.with_counts(|counts| match self.activity {
            ActivityKind::Call => {
                debug_assert!(counts.pending_calls > 0);
                counts.pending_calls = counts.pending_calls.saturating_sub(1);
            }
            ActivityKind::Write => {
                debug_assert!(counts.pending_writes > 0);
                counts.pending_writes = counts.pending_writes.saturating_sub(1);
                self.accounting
                    .writes_changed
                    .send_replace(counts.pending_writes);
            }
        });
    }
}

#[cfg(test)]
#[path = "accounting_tests.rs"]
mod tests;
