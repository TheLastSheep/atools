//! One explicit build per process. An abandoned waiter never releases a live worker.
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    Preparing,
    Fetching,
    Materializing,
    Publishing,
    Building,
    Installing,
}

struct Job {
    id: String,
    phase: Phase,
    cancel: Arc<AtomicBool>,
    /// Whole TaskRun operation completion; serialized with cancel acceptance.
    finished: Arc<AtomicBool>,
    /// Worker/quiescence observation used only to gate cleanup and quarantine.
    worker_finished: Arc<AtomicBool>,
    cleanup_unconfirmed: Arc<AtomicBool>,
    waiter: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    job: Option<Job>,
    quarantined: bool,
}

#[derive(Default)]
pub(super) struct BuildManager(Mutex<State>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildState {
    pub active: bool,
    pub stage: &'static str,
    pub cancellable: bool,
    pub cancel_requested: bool,
    pub recovery_required: bool,
}

pub(super) struct Lease {
    manager: Arc<BuildManager>,
    id: String,
    pub cancel: Arc<AtomicBool>,
    pub finished: Arc<AtomicBool>,
    pub worker_finished: Arc<AtomicBool>,
    pub cleanup_unconfirmed: Arc<AtomicBool>,
    waiter: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(super) struct PhaseGate {
    manager: Arc<BuildManager>,
    id: String,
}

pub(super) fn global() -> Arc<BuildManager> {
    static MANAGER: OnceLock<Arc<BuildManager>> = OnceLock::new();
    MANAGER
        .get_or_init(|| Arc::new(BuildManager::default()))
        .clone()
}

fn prune(state: &mut State) {
    // The supervisor can outlive its async waiter. Consume its terminal safety
    // observation before releasing admission, including when no receiver exists.
    if let Some(job) = state.job.as_ref().filter(|job| {
        !job.waiter.load(Ordering::Acquire) && job.worker_finished.load(Ordering::Acquire)
    }) {
        // An aborted async waiter has no final TaskRun transition to call
        // `finish`. It is safe to close admission only after its worker stops.
        job.finished.store(true, Ordering::Release);
    }
    if state.job.as_ref().is_some_and(|job| {
        job.finished.load(Ordering::Acquire) && job.cleanup_unconfirmed.load(Ordering::Acquire)
    }) {
        state.quarantined = true;
    }
    if state.job.as_ref().is_some_and(|job| {
        !job.waiter.load(Ordering::Acquire)
            && job.finished.load(Ordering::Acquire)
            && job.worker_finished.load(Ordering::Acquire)
    }) {
        state.job = None;
    }
}

impl BuildManager {
    pub(super) fn claim(self: &Arc<Self>, id: &str) -> Result<Lease, String> {
        let mut state = self.0.lock();
        prune(&mut state);
        if state.quarantined {
            return Err("SOURCE_BUILD_RECOVERY_REQUIRED".into());
        }
        if state.job.is_some() {
            return Err("SOURCE_BUILD_BUSY".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let worker_finished = Arc::new(AtomicBool::new(true));
        let cleanup_unconfirmed = Arc::new(AtomicBool::new(false));
        let waiter = Arc::new(AtomicBool::new(true));
        state.job = Some(Job {
            id: id.into(),
            phase: Phase::Preparing,
            cancel: cancel.clone(),
            finished: finished.clone(),
            worker_finished: worker_finished.clone(),
            cleanup_unconfirmed: cleanup_unconfirmed.clone(),
            waiter: waiter.clone(),
        });
        Ok(Lease {
            manager: self.clone(),
            id: id.into(),
            cancel,
            finished,
            worker_finished,
            cleanup_unconfirmed,
            waiter,
        })
    }

    pub(super) fn cancel(&self, id: &str) -> Result<(), String> {
        let mut state = self.0.lock();
        prune(&mut state);
        if let Some(job) = state.job.as_ref().filter(|job| job.id == id) {
            if job.finished.load(Ordering::Acquire) {
                return Err("SOURCE_BUILD_OPERATION_FINISHED".into());
            }
            if job.phase == Phase::Publishing {
                return Err("SOURCE_BUILD_PUBLISH_COMMIT_STARTED".into());
            }
            if job.phase == Phase::Installing {
                return Err("SOURCE_BUILD_INSTALL_COMMIT_STARTED".into());
            }
            job.cancel.store(true, Ordering::Release);
        } else {
            // No worker has accepted this request. This also covers the small
            // gap after installation returns but before TaskRun terminal commit.
            return Err("SOURCE_BUILD_NOT_ACTIVE".into());
        }
        Ok(())
    }

    pub(super) fn state(&self, id: &str) -> BuildState {
        let mut state = self.0.lock();
        prune(&mut state);
        let Some(job) = state.job.as_ref().filter(|job| job.id == id) else {
            return BuildState {
                active: false,
                stage: "finished",
                cancellable: false,
                cancel_requested: false,
                recovery_required: state.quarantined,
            };
        };
        let done = job.finished.load(Ordering::Acquire);
        let cancel = job.cancel.load(Ordering::Acquire);
        BuildState {
            active: !done,
            stage: if done {
                "finished"
            } else if cancel {
                "cancelling"
            } else {
                match job.phase {
                    Phase::Preparing => "preparing",
                    Phase::Fetching => "fetching",
                    Phase::Materializing => "materializing",
                    Phase::Publishing => "publishing",
                    Phase::Building => "building",
                    Phase::Installing => "installing",
                }
            },
            cancellable: !done
                && !matches!(job.phase, Phase::Publishing | Phase::Installing)
                && !cancel,
            cancel_requested: cancel,
            recovery_required: state.quarantined,
        }
    }
}

impl Lease {
    pub(super) fn quarantine(&self) {
        self.manager.0.lock().quarantined = true;
    }

    /// When cleanup is unknown and a worker is still active, quarantine before
    /// the caller exits while preserving the original operation failure.
    /// This deliberately leaves `worker_finished` untouched.
    pub(super) fn quarantine_unconfirmed_worker(&self) -> bool {
        if !self.cleanup_unconfirmed.load(Ordering::Acquire)
            || self.worker_finished.load(Ordering::Acquire)
        {
            return false;
        }
        self.quarantine();
        true
    }

    pub(super) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    /// Atomically closes cancellation admission and reports whether a request
    /// won the race. A successful cancel therefore always ends as Cancelled;
    /// requests after this transition are rejected by `BuildManager::cancel`.
    pub(super) fn finish(&self) -> Result<bool, String> {
        let mut state = self.manager.0.lock();
        let job = state
            .job
            .as_mut()
            .filter(|job| job.id == self.id)
            .ok_or("SOURCE_BUILD_LEASE_LOST")?;
        if !job.worker_finished.load(Ordering::Acquire) {
            return Err("SOURCE_BUILD_WORKER_ACTIVE".into());
        }
        let cancelled = job.cancel.load(Ordering::Acquire);
        job.finished.store(true, Ordering::Release);
        Ok(cancelled)
    }

    pub(super) fn phase_gate(&self) -> PhaseGate {
        PhaseGate {
            manager: self.manager.clone(),
            id: self.id.clone(),
        }
    }

    pub(super) fn phase(&self, phase: Phase) -> Result<(), String> {
        let mut state = self.manager.0.lock();
        let job = state
            .job
            .as_mut()
            .filter(|job| job.id == self.id)
            .ok_or("SOURCE_BUILD_LEASE_LOST")?;
        if job.finished.load(Ordering::Acquire) {
            return Err("SOURCE_BUILD_OPERATION_FINISHED".into());
        }
        if job.cancel.load(Ordering::Acquire) {
            return Err("SOURCE_BUILD_CANCELLED".into());
        }
        job.phase = phase;
        Ok(())
    }
}

impl PhaseGate {
    pub(super) fn enter(&self, phase: Phase) -> Result<(), String> {
        let mut state = self.manager.0.lock();
        let job = state
            .job
            .as_mut()
            .filter(|job| job.id == self.id)
            .ok_or("SOURCE_BUILD_LEASE_LOST")?;
        if job.finished.load(Ordering::Acquire) {
            return Err("SOURCE_BUILD_OPERATION_FINISHED".into());
        }
        if job.cancel.load(Ordering::Acquire) {
            return Err("SOURCE_BUILD_CANCELLED".into());
        }
        job.phase = phase;
        Ok(())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if !self.finished.load(Ordering::Acquire) {
            self.cancel.store(true, Ordering::Release);
        }
        self.waiter.store(false, Ordering::Release);
        prune(&mut self.manager.0.lock());
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
