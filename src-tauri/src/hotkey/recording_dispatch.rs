//! Atomic callback protocol. No manager APIs, metadata locks or OS operations
//! are used by observe(); token and ownership flags change in one CAS.
use super::{Notice, Outcome, Target, BUSY};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri_plugin_global_shortcut::ShortcutState;
const RESERVED: u64 = 1;
const ARMED: u64 = 2;
const HELD: u64 = 4;
const CANCELLED: u64 = 8;
const FLAGS: u64 = 15;
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReleaseClaim {
    Held,
    Cancelled,
    Recorded,
}
#[derive(Default)]
pub(crate) struct Signals {
    pub(super) dispatch: AtomicU64,
    #[cfg(test)]
    pub(super) before_claim: parking_lot::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    pub(super) visibility_epoch: AtomicU64,
    pub(super) shutting_down: AtomicBool,
    pub(super) lease_present: AtomicBool,
    pub(super) unavailable_sent: AtomicBool,
    pub(super) cleanup_worker: AtomicBool,
    pub(super) cancel_request: parking_lot::Mutex<Option<(u64, Option<String>)>>,
    pub(super) pending_notice: parking_lot::Mutex<Option<(Target, u64)>>,
    pub(super) deadline: parking_lot::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
impl Signals {
    pub(super) fn token(&self) -> u64 {
        self.dispatch.load(Ordering::Acquire) >> 4
    }
    pub(super) fn held(&self) -> bool {
        self.dispatch.load(Ordering::Acquire) & HELD != 0
    }
    #[cfg(test)]
    pub(super) fn cancelled(&self) -> bool {
        self.dispatch.load(Ordering::Acquire) & CANCELLED != 0
    }
    pub(super) fn arm(&self, target: Target, generation: u64) -> Result<u64, String> {
        let mut pending = self.pending_notice.lock();
        let mut old = self.dispatch.load(Ordering::Acquire);
        loop {
            if old & HELD != 0 || self.shutting_down.load(Ordering::Acquire) {
                return Err(BUSY.into());
            }
            let token = (old >> 4)
                .checked_add(1)
                .filter(|value| *value <= (u64::MAX >> 4))
                .ok_or(BUSY)?;
            let next = (token << 4) | RESERVED | ARMED;
            match self
                .dispatch
                .compare_exchange(old, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    *pending = Some((target, generation));
                    self.lease_present.store(true, Ordering::Release);
                    self.unavailable_sent.store(false, Ordering::Release);
                    return Ok(token);
                }
                Err(current) => old = current,
            }
        }
    }
    pub(super) fn disarm(&self) {
        self.dispatch.fetch_or(CANCELLED, Ordering::AcqRel);
        self.dispatch.fetch_and(!ARMED, Ordering::AcqRel);
    }
    pub(super) fn clear(&self) {
        self.dispatch.fetch_and(!FLAGS, Ordering::AcqRel);
    }
    pub(super) fn clear_if_idle(&self, force: bool) -> bool {
        let mut old = self.dispatch.load(Ordering::Acquire);
        #[cfg(test)]
        self.before_claim();
        loop {
            if !force && old & HELD != 0 {
                return false;
            }
            match self.dispatch.compare_exchange(
                old,
                old & !FLAGS,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(current) => old = current,
            }
        }
    }
    pub(super) fn claim_release(&self) -> ReleaseClaim {
        let mut old = self.dispatch.load(Ordering::Acquire);
        #[cfg(test)]
        self.before_claim();
        loop {
            if old & HELD != 0 {
                return ReleaseClaim::Held;
            }
            let claim = if old & CANCELLED != 0 {
                ReleaseClaim::Cancelled
            } else {
                ReleaseClaim::Recorded
            };
            match self.dispatch.compare_exchange(
                old,
                old & !FLAGS,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return claim,
                Err(current) => old = current,
            }
        }
    }
    fn cancel_pending(&self, token: u64) -> bool {
        let mut old = self.dispatch.load(Ordering::Acquire);
        loop {
            // A completed claim wins: late cancellation cannot produce a
            // contradictory unavailable event for the same completed input.
            if old >> 4 != token || old & RESERVED == 0 {
                return false;
            }
            match self.dispatch.compare_exchange(
                old,
                (old | CANCELLED) & !ARMED,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(current) => old = current,
            }
        }
    }
    #[cfg(test)]
    fn before_claim(&self) {
        let hook = self.before_claim.lock().take();
        if let Some(hook) = hook {
            hook();
        }
    }
    pub(super) fn retain_failed_cleanup(&self) {
        self.dispatch
            .fetch_or(RESERVED | CANCELLED, Ordering::AcqRel);
        self.disarm();
    }
    pub(super) fn observe(&self, state: ShortcutState) -> (bool, Option<u64>) {
        self.observe_loaded(self.dispatch.load(Ordering::Acquire), state)
    }
    pub(super) fn observe_loaded(&self, initial: u64, state: ShortcutState) -> (bool, Option<u64>) {
        if initial & RESERVED == 0 {
            return (false, None);
        }
        let token = initial >> 4;
        let mut old = initial;
        loop {
            if old >> 4 != token || old & RESERVED == 0 {
                return (true, None);
            }
            let next = if state == ShortcutState::Pressed {
                (old | HELD) & !ARMED
            } else {
                old & !HELD
            };
            match self
                .dispatch
                .compare_exchange(old, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    return (
                        true,
                        (state == ShortcutState::Released && old & HELD != 0).then_some(token),
                    )
                }
                Err(current) => old = current,
            }
        }
    }
    pub(super) fn failure_notice(&self, token: u64) -> Option<Notice> {
        let pending = self.pending_notice.lock();
        if token != self.token() || !self.lease_present.load(Ordering::Acquire) {
            return None;
        }
        let (target, generation) = pending.clone()?;
        if !self.cancel_pending(token) {
            return None;
        }
        if self.unavailable_sent.swap(true, Ordering::AcqRel) {
            return None;
        }
        Some(Notice {
            target,
            generation,
            outcome: Outcome::Stopped("unavailable"),
        })
    }
    pub(super) fn notice_current(&self, notice: &Notice) -> bool {
        self.pending_notice
            .lock()
            .as_ref()
            .is_some_and(|(target, generation)| {
                target == &notice.target && *generation == notice.generation
            })
    }
    pub(super) fn abort_deadline(&self) {
        if let Some(task) = self.deadline.lock().take() {
            task.abort();
        }
    }
}
