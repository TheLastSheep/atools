use super::*;
use std::sync::atomic::AtomicBool;
fn target() -> Target {
    Target {
        session_id: "s".into(),
        label: "c".into(),
        origin: "o".into(),
        bundle_revision: "b".into(),
        visibility_epoch: 0,
    }
}
fn armed() -> Signals {
    let s = Signals::default();
    s.arm(target(), 1).unwrap();
    s
}
#[derive(Default)]
struct Dispatcher {
    registered: bool,
    releases: usize,
    fail_release: bool,
    on_unregister: Option<Box<dyn FnOnce() + Send>>,
}
impl Port for Dispatcher {
    fn is_registered(&self) -> Result<bool, String> {
        Ok(self.registered)
    }
    fn register(&mut self) -> Result<(), String> {
        self.registered = true;
        Ok(())
    }
    fn unregister(&mut self) -> Result<(), String> {
        if self.fail_release {
            return Err("failed".into());
        }
        if let Some(hook) = self.on_unregister.take() {
            hook();
        }
        self.registered = false;
        self.releases += 1;
        Ok(())
    }
}
impl Dispatcher {
    // Faithful to plugin dispatch: after unregister it cannot deliver Released.
    fn event(&self, signals: &Signals, state: ShortcutState) -> Option<u64> {
        if self.registered {
            signals.observe(state).1
        } else {
            None
        }
    }
}
#[test]
fn pressed_only_claims_and_repeats_do_not_schedule_capture_until_released() {
    let s = armed();
    let token = s.token();
    assert_eq!(s.observe(ShortcutState::Pressed), (true, None));
    for _ in 0..20 {
        assert_eq!(s.observe(ShortcutState::Pressed), (true, None));
    }
    assert_eq!(s.observe(ShortcutState::Released), (true, Some(token)));
    assert_eq!(s.observe(ShortcutState::Released), (true, None));
}
#[test]
fn temporary_dispatcher_releases_before_unregister_and_next_generation_is_not_stuck() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    let token = s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    assert!(p.event(&s, ShortcutState::Pressed).is_none());
    assert!(p.registered);
    assert!(s.held());
    assert_eq!(p.event(&s, ShortcutState::Released), Some(token));
    assert!(r.capture("s", 1, &mut p).unwrap().is_some());
    update_signals(&s, &r);
    assert!(!p.registered);
    assert_eq!(p.event(&s, ShortcutState::Released), None);
    let next = s.arm(target(), 2).unwrap();
    r.start(target(), 2, false, &mut p).unwrap();
    assert!(next > token);
    assert!(!s.held());
}
#[test]
fn held_cancel_preserves_temporary_handler_until_release_then_can_rearm() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    assert!(end_recording(&mut r, &s, &mut p, "cancelled", false).is_err());
    assert!(p.registered);
    assert_eq!(p.releases, 0);
    assert!(!r.matches_active("s", 1));
    assert!(s.arm(target(), 2).is_err());
    assert!(p.event(&s, ShortcutState::Released).is_some());
    let reason = r.stop_reason();
    assert_eq!(
        end_recording(&mut r, &s, &mut p, reason, false)
            .unwrap()
            .unwrap()
            .outcome,
        Outcome::Stopped("cancelled")
    );
    assert!(!p.registered);
    assert!(s.arm(target(), 2).is_ok());
}
#[test]
fn main_change_held_is_busy_and_cannot_remove_borrowed_release_handler() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher {
        registered: true,
        ..Default::default()
    };
    s.arm(target(), 1).unwrap();
    r.start(target(), 1, true, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    let mut main_changed = false;
    if end_recording(&mut r, &s, &mut p, "cancelled", false).is_ok() {
        main_changed = true;
    }
    assert!(!main_changed);
    assert!(p.registered);
    assert_eq!(p.releases, 0);
    p.event(&s, ShortcutState::Released);
    end_recording(&mut r, &s, &mut p, "cancelled", false).unwrap();
    main_changed = true;
    assert!(main_changed);
    assert!(s.arm(target(), 2).is_ok());
}
#[test]
fn an_old_pressed_snapshot_cannot_claim_or_disarm_new_generation() {
    let s = armed();
    let old = s.dispatch.load(Ordering::Acquire);
    s.clear();
    let next = s.arm(target(), 2).unwrap();
    let current = s.dispatch.load(Ordering::Acquire);
    assert_eq!(s.observe_loaded(old, ShortcutState::Pressed), (true, None));
    assert_eq!(s.dispatch.load(Ordering::Acquire), current);
    assert_eq!(s.token(), next);
    assert!(!s.held());
}
#[test]
fn callback_atomically_claims_without_plugin_or_operation_locks() {
    let s = armed();
    let gate = parking_lot::Mutex::new(());
    let _held = gate.lock();
    let plugin = parking_lot::Mutex::new(());
    let _map = plugin.lock();
    assert_eq!(s.observe(ShortcutState::Pressed), (true, None));
    assert_eq!(s.observe(ShortcutState::Released).1, Some(s.token()));
}
#[test]
fn immediate_register_callback_is_reserved_but_capture_waits_for_release() {
    let c = GeneralSettingsCoordinator::default();
    let s = &c.recording_signals;
    let token = s.arm(target(), 1).unwrap();
    c.with_recording_registries(|_, r| {
        let mut p = Dispatcher::default();
        r.start(target(), 1, false, &mut p).unwrap();
        assert!(p.event(s, ShortcutState::Pressed).is_none());
        assert!(c.with_hotkey_operation(|| Ok(())).is_err());
        assert_eq!(p.event(s, ShortcutState::Released), Some(token));
        assert!(r.capture("s", 1, &mut p).unwrap().is_some());
        update_signals(s, r);
    })
    .unwrap();
    assert!(s.arm(target(), 2).is_ok());
}
#[test]
fn held_timeout_is_inactive_drain_and_exit_alone_forces_release_without_rearm() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    assert!(end_recording(&mut r, &s, &mut p, "timeout", false).is_err());
    assert!(p.registered);
    assert!(!r.matches_active("s", 1));
    s.shutting_down.store(true, Ordering::Release);
    end_recording(&mut r, &s, &mut p, "cancelled", true).unwrap();
    assert!(!p.registered);
    assert!(s.arm(target(), 2).is_err());
}
#[test]
fn cleanup_failure_keeps_lease_and_unavailable_is_once_per_token() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    let token = s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    p.fail_release = true;
    assert!(end_recording(&mut r, &s, &mut p, "timeout", false).is_err());
    assert!(p.registered);
    assert!(r.owns_temporary());
    assert_eq!(
        s.failure_notice(token).unwrap().outcome,
        Outcome::Stopped("unavailable")
    );
    assert!(s.failure_notice(token).is_none());
    p.fail_release = false;
    end_recording(&mut r, &s, &mut p, "timeout", false).unwrap();
    assert!(!p.registered);
}
#[test]
fn main_and_pasteboard_actions_defer_hide_cleanup_past_plugin_lock() {
    use std::sync::{Arc, Mutex};
    for _ in ["main", "pasteboard"] {
        let map = Arc::new(Mutex::new(()));
        let gate = Arc::new(Mutex::new(()));
        let m = map.lock().unwrap();
        let g = gate.lock().unwrap();
        let ran = Arc::new(AtomicBool::new(false));
        let mut queued: Option<Box<dyn FnOnce()>> = None;
        enqueue_pressed(ShortcutState::Pressed, false, || {
            let map = map.clone();
            let gate = gate.clone();
            let ran = ran.clone();
            queued = Some(Box::new(move || {
                let _g = gate.try_lock().unwrap();
                let _m = map.try_lock().unwrap();
                ran.store(true, Ordering::Release);
            }));
        });
        assert!(!ran.load(Ordering::Acquire));
        drop(g);
        drop(m);
        queued.unwrap()();
        assert!(ran.load(Ordering::Acquire));
    }
    enqueue_pressed(ShortcutState::Pressed, true, || panic!("captured"));
    enqueue_pressed(ShortcutState::Released, false, || panic!("released"));
}

#[test]
fn hidden_before_arm_or_hide_and_show_during_registration_invalidates_start_and_notice() {
    let s = Signals::default();
    let before = s.visibility_epoch.load(Ordering::Acquire);
    assert!(visibility_allows(before, before, true));
    assert!(!visibility_allows(before, before, false));
    s.visibility_epoch.fetch_add(1, Ordering::AcqRel);
    let after = s.visibility_epoch.load(Ordering::Acquire);
    assert!(!visibility_allows(before, after, false));
    assert!(
        !visibility_allows(before, after, true),
        "show cannot revive an in-flight pre-hide start or old notice"
    );
    assert!(visibility_allows(after, after, true));
}
#[test]
fn queued_old_notice_does_not_cross_into_a_new_generation() {
    let s = Signals::default();
    s.arm(target(), 1).unwrap();
    let old = Notice {
        target: target(),
        generation: 1,
        outcome: Outcome::Recorded,
    };
    assert!(s.notice_current(&old));
    s.clear();
    s.arm(target(), 2).unwrap();
    assert!(!s.notice_current(&old));
}
#[tokio::test]
async fn notice_gate_barrier_waits_for_originating_operation_and_releases_before_delivery() {
    use std::sync::{mpsc, Arc};
    let c = Arc::new(GeneralSettingsCoordinator::default());
    let worker = c.clone();
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let owner = std::thread::spawn(move || {
        worker
            .with_hotkey_operation(|| {
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .unwrap();
    });
    locked_rx.recv().unwrap();
    let barrier = c.clone();
    let delivered = Arc::new(AtomicBool::new(false));
    let result = delivered.clone();
    let waiter = tokio::spawn(async move {
        assert!(wait_for_gate(&barrier).await);
        assert!(barrier.with_hotkey_operation(|| Ok(())).is_ok());
        result.store(true, Ordering::Release);
    });
    tokio::task::yield_now().await;
    assert!(!delivered.load(Ordering::Acquire));
    release_tx.send(()).unwrap();
    waiter.await.unwrap();
    owner.join().unwrap();
    assert!(delivered.load(Ordering::Acquire));
}

#[test]
fn stop_gate_busy_immediately_disarms_capture_even_before_registry_can_be_updated() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    let token = s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    // Stop failed to acquire the gate. Failure publication must still revoke
    // input capture; Registry cannot be mutated until the operation gate opens.
    assert!(s.failure_notice(token).is_some());
    assert!(r.matches_active("s", 1));
    assert!(s.cancelled());
    p.event(&s, ShortcutState::Released);
    let notice = release_recording(&mut r, &s, &mut p, true)
        .unwrap()
        .unwrap();
    assert_eq!(notice.outcome, Outcome::Stopped("cancelled"));
    assert!(!p.registered);
}

#[test]
fn stop_tombstone_is_preserved_when_held_cleanup_must_wait() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    r.remember_stop("s", 2).unwrap();
    assert!(end_recording(&mut r, &s, &mut p, "cancelled", false).is_err());
    p.event(&s, ShortcutState::Released);
    release_recording(&mut r, &s, &mut p, true).unwrap();
    assert!(
        r.start(target(), 2, false, &mut p).is_err(),
        "late start cannot revive the stopped generation"
    );
    assert!(r.start(target(), 3, false, &mut p).is_ok());
}

#[test]
fn idle_cleanup_and_callback_claim_are_one_atomic_decision() {
    let s = armed();
    let loaded = s.dispatch.load(Ordering::Acquire);
    assert!(s.clear_if_idle(false));
    assert_eq!(
        s.observe_loaded(loaded, ShortcutState::Pressed),
        (true, None)
    );
    assert!(!s.held());
    s.arm(target(), 2).unwrap();
    s.observe(ShortcutState::Pressed);
    assert!(!s.clear_if_idle(false));
    assert!(
        s.held(),
        "a winning callback claim keeps its release handler alive"
    );
}

#[test]
fn actual_stop_caller_preserves_handler_when_pressed_wins_between_qualification_and_cleanup_cas() {
    use std::sync::Arc;
    let s = Arc::new(Signals::default());
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    let callback = s.clone();
    *s.before_claim.lock() = Some(Box::new(move || {
        assert_eq!(callback.observe(ShortcutState::Pressed), (true, None));
    }));
    assert!(stop_recording(&mut r, &s, &mut p, "s", 1).is_err());
    assert!(s.before_claim.lock().is_none());
    assert!(p.registered);
    assert_eq!(p.releases, 0);
    assert!(s.held());
    p.event(&s, ShortcutState::Released);
    stop_recording(&mut r, &s, &mut p, "s", 1).unwrap();
    assert!(!p.registered);
}
#[test]
fn actual_release_caller_honors_cancel_winning_after_qualification_before_completion_cas() {
    use std::sync::Arc;
    let s = Arc::new(Signals::default());
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    let token = s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    p.event(&s, ShortcutState::Released);
    let cancelled = s.clone();
    *s.before_claim.lock() = Some(Box::new(move || {
        assert!(cancelled.failure_notice(token).is_some());
    }));
    let notice = release_recording(&mut r, &s, &mut p, true)
        .unwrap()
        .unwrap();
    assert!(s.before_claim.lock().is_none());
    assert_eq!(notice.outcome, Outcome::Stopped("cancelled"));
    assert!(!p.registered);
}
#[test]
fn actual_release_caller_winning_completion_prevents_late_contradictory_unavailable() {
    use std::sync::Arc;
    let s = Arc::new(Signals::default());
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    let token = s.arm(target(), 1).unwrap();
    r.start(target(), 1, false, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    p.event(&s, ShortcutState::Released);
    let late = s.clone();
    p.on_unregister = Some(Box::new(move || {
        assert!(late.failure_notice(token).is_none());
    }));
    let notice = release_recording(&mut r, &s, &mut p, true)
        .unwrap()
        .unwrap();
    assert_eq!(notice.outcome, Outcome::Recorded);
    assert!(!p.registered);
    assert!(s.failure_notice(token).is_none());
}
#[test]
fn actual_stop_caller_for_old_generation_does_not_touch_new_held_lease() {
    let s = Signals::default();
    let mut r = Registry::default();
    let mut p = Dispatcher::default();
    s.arm(target(), 2).unwrap();
    r.start(target(), 2, false, &mut p).unwrap();
    p.event(&s, ShortcutState::Pressed);
    let before = s.dispatch.load(Ordering::Acquire);
    assert!(!stop_recording(&mut r, &s, &mut p, "s", 1).unwrap().0.active);
    assert_eq!(s.dispatch.load(Ordering::Acquire), before);
    assert!(r.matches_active("s", 2));
    assert!(p.registered);
    assert_eq!(p.releases, 0);
}

#[test]
fn shutdown_preserves_held_temporary_on_failed_unregister() {
    let signals = Signals::default();
    let mut registry = Registry::default();
    let mut port = Dispatcher::default();
    signals.arm(target(), 1).unwrap();
    registry.start(target(), 1, false, &mut port).unwrap();
    port.event(&signals, ShortcutState::Pressed);
    port.fail_release = true;
    assert!(shutdown_recording(&mut registry, &signals, &mut port, false).is_err());
    assert!(signals.held());
    assert!(registry.owns_temporary());
    assert!(port.registered);
    port.fail_release = false;
    assert!(shutdown_recording(&mut registry, &signals, &mut port, false).is_ok());
    assert!(!signals.held());
    assert!(!port.registered);
}

#[test]
fn shutdown_borrowed_held_waits_for_confirmed_main_withdrawal() {
    let signals = Signals::default();
    let mut registry = Registry::default();
    let mut port = Dispatcher { registered: true, ..Default::default() };
    signals.arm(target(), 1).unwrap();
    registry.start(target(), 1, true, &mut port).unwrap();
    port.event(&signals, ShortcutState::Pressed);
    assert!(shutdown_recording(&mut registry, &signals, &mut port, false).is_err());
    assert!(signals.held());
    assert!(shutdown_recording(&mut registry, &signals, &mut port, true).is_ok());
    assert!(!signals.held());
}
