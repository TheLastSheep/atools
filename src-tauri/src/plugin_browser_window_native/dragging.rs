//! AppKit window dragging tied to a recent, real mouse-down from that window.
//!
//! This transport is deliberately separate from plugin file dragging: it owns
//! one local AppKit monitor and never constructs or shares synthetic events.

use atools_core::agent::PermissionDecision;
use std::{
    sync::atomic::{AtomicU8, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, WebviewWindow};

#[cfg(target_os = "macos")]
mod macos;

pub(crate) const GESTURE_TTL: Duration = Duration::from_millis(250);
const QUEUED: u8 = 0;
const CHECKING: u8 = 1;
const ACCEPTED: u8 = 2;
const CANCELLED: u8 = 3;

#[derive(Clone, Copy, Debug)]
pub(crate) struct GestureStamp {
    pub window_number: isize,
    pub captured_at: Instant,
    pub captured_epoch_ms: u64,
    pub control_down: bool,
}

impl GestureStamp {
    pub(crate) fn is_eligible(
        self,
        window_number: isize,
        left_button_pressed: bool,
        started_at_ms: u64,
        prepared_at_ms: u64,
        prepared_at: Instant,
        now: Instant,
    ) -> bool {
        let lifetime = |from: Instant, to: Instant| {
            to.checked_duration_since(from)
                .is_some_and(|elapsed| elapsed <= GESTURE_TTL)
        };
        self.window_number == window_number
            && left_button_pressed
            && !self.control_down
            && self.captured_epoch_ms <= started_at_ms
            && started_at_ms <= prepared_at_ms
            && prepared_at_ms
                .checked_sub(started_at_ms)
                .is_some_and(|elapsed| elapsed <= GESTURE_TTL.as_millis() as u64)
            && lifetime(self.captured_at, prepared_at)
            && lifetime(self.captured_at, now)
            && lifetime(prepared_at, now)
    }
}

/// State for one queued start request. A timeout may cancel both work that is
/// still queued and synchronous authorization checks already in progress.
#[derive(Debug, Default)]
pub(crate) struct StartGate(AtomicU8);

impl StartGate {
    pub(crate) fn begin_checking(&self) -> bool {
        self.0
            .compare_exchange(QUEUED, CHECKING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn accept(&self) -> bool {
        self.0
            .compare_exchange(CHECKING, ACCEPTED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn cancel(&self) -> bool {
        loop {
            let state = self.0.load(Ordering::Acquire);
            if state == ACCEPTED || state == CANCELLED {
                return false;
            }
            if self
                .0
                .compare_exchange(state, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return true;
            }
        }
    }

    pub(crate) fn is_checking(&self) -> bool {
        self.0.load(Ordering::Acquire) == CHECKING
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct StartAuthorization {
    pub intent_running: bool,
    pub task_run_running: bool,
    pub source_active: bool,
    pub exact_self: bool,
    pub renderer_authorized: bool,
    pub window_alive: bool,
    pub permission_decision: PermissionDecision,
    pub permission_prompt_shown: bool,
}

impl StartAuthorization {
    pub(crate) fn allows(self) -> bool {
        self.intent_running
            && self.task_run_running
            && self.source_active
            && self.exact_self
            && self.renderer_authorized
            && self.window_alive
            && permission_allows_drag(self.permission_decision, self.permission_prompt_shown)
    }
}

fn permission_allows_drag(decision: PermissionDecision, prompt_shown: bool) -> bool {
    decision != PermissionDecision::Deny && !prompt_shown
}

pub(crate) fn register_window(label: &str, window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return macos::register_window(label, window);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (label, window);
        Ok(())
    }
}

pub(crate) fn forget_window(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    macos::forget_window(app, label);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label);
}

pub(crate) async fn start_dragging<F>(
    app: &AppHandle,
    label: &str,
    started_at_ms: u64,
    prepared_at: Instant,
    prepared_at_ms: u64,
    preflight: F,
) -> Result<serde_json::Value, String>
where
    F: FnOnce(&WebviewWindow) -> Result<StartAuthorization, String> + Send + 'static,
{
    #[cfg(target_os = "macos")]
    {
        macos::start_dragging(
            app,
            label,
            started_at_ms,
            prepared_at,
            prepared_at_ms,
            preflight,
        )
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            label,
            started_at_ms,
            prepared_at,
            prepared_at_ms,
            preflight,
        );
        Err("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: startDragging is only supported on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{permission_allows_drag, GestureStamp, StartAuthorization, StartGate, GESTURE_TTL};
    use atools_core::agent::PermissionDecision;
    use std::time::{Duration, Instant};

    fn stamp(captured_at: Instant, captured_epoch_ms: u64) -> GestureStamp {
        GestureStamp {
            window_number: 17,
            captured_at,
            captured_epoch_ms,
            control_down: false,
        }
    }

    #[test]
    fn gesture_requires_current_pressed_left_button_and_same_window() {
        let now = Instant::now();
        let prepared = now - Duration::from_millis(10);
        let captured = now - Duration::from_millis(20);
        let event = stamp(captured, 100);
        assert!(event.is_eligible(17, true, 105, 110, prepared, now));
        assert!(!event.is_eligible(17, false, 105, 110, prepared, now));
        assert!(!event.is_eligible(18, true, 105, 110, prepared, now));
    }

    #[test]
    fn gesture_expiry_and_newer_down_are_rejected() {
        let now = Instant::now();
        let prepared = now - GESTURE_TTL - Duration::from_millis(1);
        let expired = stamp(prepared - Duration::from_millis(1), 100);
        assert!(!expired.is_eligible(17, true, 105, 110, prepared, now));

        let fresh_prepared = now - Duration::from_millis(1);
        // Both native downs can precede Rust preparation. Only the original
        // DOM handler's epoch distinguishes this newer press from its request.
        let newer_down = stamp(now - Duration::from_millis(2), 120);
        assert!(newer_down.is_eligible(17, true, 120, 121, fresh_prepared, now));
        assert!(!newer_down.is_eligible(17, true, 110, 121, fresh_prepared, now));
    }

    #[test]
    fn control_click_is_not_eligible() {
        let now = Instant::now();
        let mut event = stamp(now - Duration::from_millis(1), 100);
        event.control_down = true;
        assert!(!event.is_eligible(17, true, 100, 101, now - Duration::from_millis(1), now));
    }

    #[test]
    fn gate_cancels_queued_or_checking_work_before_acceptance() {
        let queued = StartGate::default();
        assert!(queued.cancel());
        assert!(!queued.begin_checking());
        assert!(!queued.accept());

        let checking = StartGate::default();
        assert!(checking.begin_checking());
        assert!(checking.cancel());
        assert!(!checking.accept());
        assert!(!checking.cancel());

        let accepted = StartGate::default();
        assert!(accepted.begin_checking());
        assert!(accepted.accept());
        assert!(!accepted.accept());
        assert!(!accepted.cancel());
    }

    #[test]
    fn revoked_source_prevents_start() {
        let authorization = StartAuthorization {
            intent_running: true,
            task_run_running: true,
            source_active: false,
            exact_self: true,
            renderer_authorized: true,
            window_alive: true,
            permission_decision: PermissionDecision::Confirm,
            permission_prompt_shown: false,
        };
        assert!(!authorization.allows());
    }

    #[test]
    fn permission_allows_already_running_allow_or_confirm_but_never_prompt_or_deny() {
        assert!(permission_allows_drag(PermissionDecision::Allow, false));
        assert!(permission_allows_drag(PermissionDecision::Confirm, false));
        assert!(!permission_allows_drag(PermissionDecision::Deny, false));
        assert!(!permission_allows_drag(PermissionDecision::Allow, true));
        assert!(!permission_allows_drag(PermissionDecision::Confirm, true));
        assert!(!permission_allows_drag(PermissionDecision::Deny, true));
    }
}
