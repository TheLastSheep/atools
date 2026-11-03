//! Upstream double-tap wakeup's finite transient-blur suppression; no timer or polling.
use parking_lot::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
#[derive(Default)]
pub(crate) struct TransientBlurGuard {
    deadline: Mutex<Option<Instant>>,
}
impl TransientBlurGuard {
    fn arm(&self, will_show: bool, now: Instant) -> Option<Instant> {
        let mut deadline = self.deadline.lock();
        let previous = *deadline;
        if will_show {
            let candidate = now + Duration::from_millis(350);
            *deadline = Some(previous.map_or(candidate, |old| old.max(candidate)));
        }
        previous
    }
    fn active(&self, now: Instant) -> bool {
        self.deadline.lock().is_some_and(|deadline| now < deadline)
    }
    fn restore(&self, previous: Option<Instant>) {
        *self.deadline.lock() = previous;
    }
}
pub(crate) fn suppress_double_tap_blur(app: &AppHandle) -> Option<Instant> {
    app.try_state::<TransientBlurGuard>()
        .and_then(|guard| guard.arm(true, Instant::now()))
}
pub(crate) fn restore_double_tap_blur(app: &AppHandle, previous: Option<Instant>) {
    if let Some(guard) = app.try_state::<TransientBlurGuard>() {
        guard.restore(previous);
    }
}
pub(crate) fn transient_blur_suppressed(app: &AppHandle) -> bool {
    app.try_state::<TransientBlurGuard>()
        .is_some_and(|guard| guard.active(Instant::now()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_show_arms_deadline_and_exact_expiry_restores_blur() {
        let guard = TransientBlurGuard::default();
        let now = Instant::now();
        guard.arm(false, now);
        assert!(!guard.active(now));
        guard.arm(true, now);
        assert!(guard.active(now + Duration::from_millis(349)));
        assert!(!guard.active(now + Duration::from_millis(350)));
        guard.arm(false, now + Duration::from_millis(100));
        assert!(!guard.active(now + Duration::from_millis(350)));
    }
    #[test]
    fn failed_show_restores_previous_guard_and_repeated_show_never_shortens_it() {
        let guard = TransientBlurGuard::default();
        let now = Instant::now();
        guard.arm(true, now);
        let previous = guard.arm(true, now + Duration::from_millis(100));
        assert!(guard.active(now + Duration::from_millis(400)));
        guard.restore(previous);
        assert!(!guard.active(now + Duration::from_millis(400)));
    }
}
