//! Confirmation ownership ends with the real worker, after its resources/permit retire.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
pub(super) fn next_sequence(s: &CoordinatorSnapshot) -> Result<u64, UpdateCommandError> {
    // An active owner reserves the final sequence for its mandatory release observation.
    let limit = MAX_SEQUENCE - u64::from(s.operation_id.is_some());
    s.sequence
        .checked_add(1)
        .filter(|n| *n <= limit)
        .ok_or_else(|| failure("internal"))
}

pub(super) struct Confirmation<'a> {
    coordinator: &'a UpdateCoordinator,
    id: String,
    permit: Option<tokio::sync::MutexGuard<'a, ()>>,
    finished: bool,
}
impl<'a> Confirmation<'a> {
    pub(super) fn begin(
        coordinator: &'a UpdateCoordinator,
        permit: tokio::sync::MutexGuard<'a, ()>,
        restart: bool,
    ) -> Result<Self, UpdateCommandError> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut s = coordinator.lock_snapshot()?;
        if s.sequence >= MAX_SEQUENCE - 1 {
            return Err(failure("internal"));
        }
        s.last_error = None;
        s.operation_id = Some(id.clone());
        s.operation = if restart {
            UpdateOperation::Restarting
        } else {
            UpdateOperation::Installing
        };
        drop(s);
        Ok(Self {
            coordinator,
            id,
            permit: Some(permit),
            finished: false,
        })
    }
    pub(super) fn id(&self) -> &str {
        &self.id
    }
    pub(super) fn finish(mut self) {
        self.finished = true;
    }
}
impl Drop for Confirmation<'_> {
    fn drop(&mut self) {
        let changed = if let Ok(mut s) = self.coordinator.lock_snapshot() {
            if s.operation_id.as_deref() != Some(&self.id) {
                false
            } else {
                // Ordinary errors already carry their canonical outcome. Unexpected unwinds
                // distinguish installation uncertainty and restart-only recovery.
                let unfinished = matches!(
                    s.phase,
                    Phase::Downloading | Phase::Downloaded | Phase::Installing
                ) || (!self.finished && s.phase == Phase::Restarting);
                if unfinished {
                    let error = if let Some(error) = s.last_error.as_ref() {
                        error.as_ref().clone()
                    } else if s.operation == UpdateOperation::Restarting {
                        failure("restart_pending")
                    } else if s.phase == Phase::Installing {
                        failure("install_unknown")
                    } else {
                        failure("operation_interrupted")
                    };
                    s.phase = match error.code.as_str() {
                        "install_unknown" => Phase::InstallUnknown,
                        "restart_pending" => Phase::RestartPending,
                        _ => Phase::Error,
                    };
                    s.operation = UpdateOperation::Idle;
                    s.last_error = Some(Arc::new(error));
                }
                s.operation_id = None;
                s.sequence = s.sequence.saturating_add(1).min(MAX_SEQUENCE);
                true
            }
        } else {
            false
        };
        // Final state is committed while owned; release the actual permit before notifying.
        // A new worker may start here. The old guard never writes state after this point.
        drop(self.permit.take());
        if changed {
            self.coordinator.notify(false);
        }
    }
}

pub(super) fn progress<F>(
    coordinator: UpdateCoordinator,
    owner: String,
    progress: F,
) -> (Arc<AtomicBool>, Box<dyn Fn(UpdateProgress) + Send + Sync>)
where
    F: Fn(UpdateProgress) + Send + Sync + 'static,
{
    let invalid = Arc::new(AtomicBool::new(false));
    let invalid_count = invalid.clone();
    let throttle = Mutex::new(None::<Instant>);
    let handler = Box::new(move |p: UpdateProgress| {
        if coordinator.ensure_running().is_err() {
            return;
        }
        let Ok(mut s) = coordinator.lock_snapshot() else {
            return;
        };
        if s.operation_id.as_deref() != Some(&owner) {
            return;
        }
        if p.downloaded > MAX_SEQUENCE {
            invalid_count.store(true, Ordering::Release);
            return;
        }
        let now = Instant::now();
        let emit = {
            let Ok(mut last) = throttle.lock() else {
                return;
            };
            if last.is_none_or(|t| now.duration_since(t) >= Duration::from_millis(100)) {
                *last = Some(now);
                true
            } else {
                false
            }
        };
        s.progress = Progress {
            downloaded: p.downloaded,
            total: p.total.filter(|n| *n <= MAX_SEQUENCE),
        };
        if emit {
            s.sequence = s.sequence.saturating_add(1).min(MAX_SEQUENCE - 1);
        }
        drop(s);
        if emit {
            progress(UpdateProgress {
                event: "downloading".into(),
                downloaded: p.downloaded,
                total: p.total.filter(|n| *n <= MAX_SEQUENCE),
            });
            coordinator.notify(true);
        }
    });
    (invalid, handler)
}

#[cfg(test)]
#[path = "confirmation_lifecycle_tests.rs"]
mod tests;
