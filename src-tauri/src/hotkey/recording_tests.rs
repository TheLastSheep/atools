use super::*;
#[derive(Default)]
struct FakePort {
    registered: bool,
    registrations: usize,
    releases: usize,
    fail_release: bool,
}
impl Port for FakePort {
    fn is_registered(&self) -> Result<bool, String> {
        Ok(self.registered)
    }
    fn register(&mut self) -> Result<(), String> {
        assert!(!self.registered);
        self.registered = true;
        self.registrations += 1;
        Ok(())
    }
    fn unregister(&mut self) -> Result<(), String> {
        self.releases += 1;
        if self.fail_release {
            return Err(UNAVAILABLE.into());
        }
        assert!(self.registered);
        self.registered = false;
        Ok(())
    }
}
fn target(session: &str) -> Target {
    Target {
        session_id: session.into(),
        label: format!("child-{session}"),
        origin: format!("atools-settings://{session}.localhost"),
        bundle_revision: "bundle".into(),
        visibility_epoch: 0,
    }
}
#[test]
fn borrowed_main_capture_never_registers_or_releases_main() {
    let mut r = Registry::default();
    let mut p = FakePort {
        registered: true,
        ..Default::default()
    };
    let (ack, _, fresh) = r.start(target("a"), 1, true, &mut p).unwrap();
    assert!(fresh);
    assert_eq!(ack.mode, Some(Mode::BorrowedMain));
    let event = r.capture("a", 1, &mut p).unwrap().unwrap();
    assert_eq!(event.outcome, Outcome::Recorded);
    assert!(r.capture("a", 1, &mut p).unwrap().is_none());
    assert!(p.registered);
    assert_eq!((p.registrations, p.releases), (0, 0));
}
#[test]
fn temporary_capture_releases_exactly_its_one_key_before_notice() {
    let mut r = Registry::default();
    let mut p = FakePort::default();
    r.start(target("a"), 1, false, &mut p).unwrap();
    assert!(p.registered);
    assert!(r.capture("a", 1, &mut p).unwrap().is_some());
    assert!(!p.registered);
    r.stop("a", 1, &mut p).unwrap();
    assert_eq!((p.registrations, p.releases), (1, 1));
}
#[test]
fn occupied_key_is_rejected_without_unregistering_another_owner() {
    let mut r = Registry::default();
    let mut p = FakePort {
        registered: true,
        ..Default::default()
    };
    assert!(r.start(target("a"), 1, false, &mut p).is_err());
    assert_eq!((p.registrations, p.releases), (0, 0));
    assert!(p.registered);
}
#[test]
fn stop_before_start_tombstone_and_safe_integer_boundaries() {
    let mut r = Registry::default();
    let mut p = FakePort::default();
    let (ack, _) = r.stop("a", 4, &mut p).unwrap();
    assert!(!ack.active);
    assert_eq!(ack.mode, None);
    assert!(r.start(target("a"), 4, false, &mut p).is_err());
    assert!(r.start(target("a"), 3, false, &mut p).is_err());
    assert!(r.start(target("a"), 0, false, &mut p).is_err());
    assert!(r
        .start(target("a"), MAX_GENERATION + 1, false, &mut p)
        .is_err());
    assert!(r.start(target("a"), 5, false, &mut p).is_ok());
}
#[test]
fn repeated_start_keeps_one_lease_and_does_not_refresh_deadline() {
    let mut r = Registry::default();
    let mut p = FakePort::default();
    r.start(target("a"), 1, false, &mut p).unwrap();
    let (_, _, fresh) = r.start(target("a"), 1, false, &mut p).unwrap();
    assert!(!fresh);
    assert_eq!(p.registrations, 1);
}
#[test]
fn late_stop_and_old_capture_cannot_change_new_generation() {
    let mut r = Registry::default();
    let mut p = FakePort::default();
    r.start(target("a"), 1, false, &mut p).unwrap();
    r.start(target("a"), 2, false, &mut p).unwrap();
    assert!(!r.stop("a", 1, &mut p).unwrap().0.active);
    assert!(r.matches_active("a", 2));
    assert!(r.capture("a", 1, &mut p).unwrap().is_none());
    assert!(r.stop("old", 99, &mut p).is_err());
    assert!(r.matches_active("a", 2));
}
#[test]
fn failed_cleanup_retains_owned_key_and_stop_retry_can_release_it() {
    let mut r = Registry::default();
    let mut p = FakePort::default();
    r.start(target("a"), 1, false, &mut p).unwrap();
    p.fail_release = true;
    assert!(r.stop("a", 1, &mut p).is_err());
    assert!(r.owns_temporary());
    assert!(!r.matches_active("a", 1));
    assert!(p.registered);
    assert!(r.start(target("a"), 2, false, &mut p).is_err());
    assert_eq!(p.registrations, 1);
    p.fail_release = false;
    assert!(!r.stop("a", 2, &mut p).unwrap().0.active);
    assert!(!r.owns_temporary());
    assert!(!p.registered);
}
#[test]
fn failed_capture_cleanup_does_not_report_recorded_and_is_retryable() {
    let mut r = Registry::default();
    let mut p = FakePort::default();
    r.start(target("a"), 1, false, &mut p).unwrap();
    p.fail_release = true;
    assert!(r.capture("a", 1, &mut p).is_err());
    assert!(r.owns_temporary());
    assert!(!r.matches_active("a", 1));
    p.fail_release = false;
    assert_eq!(
        r.cancel(&mut p, "unavailable").unwrap().unwrap().outcome,
        Outcome::Stopped("unavailable")
    );
    assert!(!p.registered);
}
#[test]
fn timeout_close_main_mutation_and_exit_use_same_owned_cleanup() {
    for reason in ["timeout", "cancelled", "unavailable"] {
        let mut r = Registry::default();
        let mut p = FakePort::default();
        r.start(target("a"), 1, false, &mut p).unwrap();
        assert_eq!(
            r.cancel(&mut p, reason).unwrap().unwrap().outcome,
            Outcome::Stopped(reason)
        );
        assert!(!p.registered);
        assert!(r.cancel(&mut p, reason).unwrap().is_none());
    }
}
#[test]
fn failed_notification_cannot_reactivate_or_duplicate_a_consumed_recording() {
    let mut r = Registry::default();
    let mut p = FakePort::default();
    r.start(target("a"), 1, false, &mut p).unwrap();
    let unsubmitted = r.capture("a", 1, &mut p).unwrap();
    drop(unsubmitted);
    assert!(r.capture("a", 1, &mut p).unwrap().is_none());
    assert!(!r.matches_active("a", 1));
    assert!(!p.registered);
}
