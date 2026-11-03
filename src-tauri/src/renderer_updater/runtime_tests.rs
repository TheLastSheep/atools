//! Actual session admission/retirement helpers used by popup commands and native callbacks.
use super::*;
fn session(id: &str) -> Session {
    let mut s = Session::new(
        id.repeat(32),
        Arc::new(Bundle {
            assets: Default::default(),
        }),
        true,
        "c".repeat(32),
    );
    s.ready = true;
    s
}
#[test]
fn confirmation_and_close_have_one_generation_and_actual_destroy_releases_quota() {
    let runtime = Runtime::default();
    let s = session("a");
    *runtime.session.lock() = Some(s.clone());
    let confirmation = runtime
        .reserve_confirmation(&s.id, &"c".repeat(32))
        .unwrap();
    assert!(runtime
        .reserve_confirmation(&s.id, &"c".repeat(32))
        .is_err());
    assert!(runtime.begin_close(&s.id, false).is_err());
    assert!(s.alive.load(Ordering::Acquire));
    drop(confirmation);
    runtime.begin_close(&s.id, false).unwrap();
    assert!(!s.alive.load(Ordering::Acquire));
    assert!(runtime.session.lock().is_some());
    assert!(runtime
        .reserve_confirmation(&s.id, &"c".repeat(32))
        .is_err());
    runtime.destroyed(&s.id);
    assert!(runtime.session.lock().is_none());
    assert!(s.destroyed.load(Ordering::Acquire));
    let next = session("b");
    *runtime.session.lock() = Some(next.clone());
    runtime.destroyed(&s.id);
    assert_eq!(runtime.session.lock().as_ref().unwrap().id, next.id);
}
#[test]
fn navigation_grant_is_single_use_and_does_not_release_native_slot() {
    let runtime = Runtime::default();
    let s = session("a");
    *runtime.session.lock() = Some(s.clone());
    let trusted = super::super::identity::popup_url(&s.id, cfg!(target_os = "windows"))
        .parse()
        .unwrap();
    assert!(runtime.navigation(&s.id, &trusted));
    assert!(!runtime.navigation(&s.id, &trusted));
    assert!(!s.alive.load(Ordering::Acquire));
    assert!(runtime.session.lock().is_some());
    runtime.destroyed(&"b".repeat(32));
    assert!(runtime.session.lock().is_some());
}
#[test]
fn busy_or_old_candidate_does_not_revoke_current_popup() {
    let runtime = Runtime::default();
    let s = session("a");
    *runtime.session.lock() = Some(s.clone());
    assert!(runtime.begin_close(&s.id, true).is_err());
    assert!(s.alive.load(Ordering::Acquire));
    assert!(runtime
        .reserve_confirmation(&s.id, &"d".repeat(32))
        .is_err());
    runtime.invalidate(&"b".repeat(32));
    assert!(s.alive.load(Ordering::Acquire));
    runtime.invalidate(&s.id);
    assert!(!s.alive.load(Ordering::Acquire));
}
fn snapshot(sequence: u64) -> crate::updater::snapshot::Snapshot {
    crate::updater::snapshot::Snapshot {
        version: 1,
        sequence,
        phase: crate::updater::snapshot::Phase::NotAvailable,
        candidate: None,
        checked: true,
        operation_id: None,
        progress: Default::default(),
        error: None,
    }
}
#[test]
fn publication_and_revocation_use_the_same_actual_runtime_arbitration() {
    let runtime = Arc::new(Runtime::default());
    let s = session("a");
    *runtime.session.lock() = Some(s.clone());
    runtime.invalidate(&s.id);
    let mut emitted = 0;
    runtime.enqueue_snapshot(&snapshot(1), |_, _| {
        emitted += 1;
        true
    });
    assert_eq!(emitted, 0);
    let next = session("b");
    *runtime.session.lock() = Some(next.clone());
    let (entered, at_emit) = std::sync::mpsc::channel();
    let (release, may_enqueue) = std::sync::mpsc::channel();
    let (trace_tx, trace_rx) = std::sync::mpsc::channel();
    let worker = runtime.clone();
    let trace = trace_tx.clone();
    let publishing = std::thread::spawn(move || {
        worker.enqueue_snapshot(&snapshot(2), |_, _| {
            entered.send(()).unwrap();
            may_enqueue.recv().unwrap();
            trace.send("enqueue").unwrap();
            true
        })
    });
    at_emit.recv().unwrap();
    let (attempted, actual_attempt) = std::sync::mpsc::channel();
    *runtime.revoke_attempt.lock() = Some(attempted);
    let worker = runtime.clone();
    let id = next.id.clone();
    let retiring = std::thread::spawn(move || {
        worker.invalidate(&id);
        trace_tx.send("revoke-complete").unwrap();
    });
    assert!(
        actual_attempt
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap(),
        "actual invalidate must observe contention before releasing the producer"
    );
    release.send(()).unwrap();
    publishing.join().unwrap();
    retiring.join().unwrap();
    assert_eq!(
        trace_rx.iter().collect::<Vec<_>>(),
        ["enqueue", "revoke-complete"]
    );
    runtime.enqueue_snapshot(&snapshot(3), |_, _| panic!("post-revocation enqueue"));
    assert_eq!(runtime.session.lock().as_ref().unwrap().last_sequence, 2);
}
#[test]
fn failed_close_keeps_identity_and_allows_only_a_single_cleanup_retry() {
    let runtime = Runtime::default();
    let s = session("a");
    *runtime.session.lock() = Some(s.clone());
    let (_, actual_close) = runtime.reserve_close_task(&s.id).unwrap();
    assert!(runtime.reserve_close_task(&s.id).is_err());
    assert!(runtime.session.lock().is_some());
    // Actual close task returned an error; its generation stays revoked and quota retained.
    drop(actual_close);
    assert!(!s.alive.load(Ordering::Acquire));
    let (_, retry) = runtime.reserve_close_task(&s.id).unwrap();
    assert!(runtime
        .reserve_confirmation(&s.id, &"c".repeat(32))
        .is_err());
    runtime.destroyed(&s.id);
    drop(retry);
    assert!(runtime.session.lock().is_none());
}
#[tokio::test]
async fn actual_session_waiter_receives_broadcast_between_flag_check_and_first_poll() {
    let runtime = Arc::new(Runtime::default());
    let s = session("a");
    *runtime.session.lock() = Some(s.clone());
    let producer = runtime.clone();
    let id = s.id.clone();
    let flag = s.destroyed.clone();
    *s.close_wait_gap.lock() = Some(Box::new(move || {
        assert!(!flag.load(Ordering::Acquire));
        // Actual Destroyed producer stores destroyed=true before notify_waiters (runtime.rs).
        producer.destroyed(&id);
        assert!(flag.load(Ordering::Acquire));
    }));
    tokio::time::timeout(std::time::Duration::from_secs(3), s.wait_closed())
        .await
        .expect("a pre-poll broadcast is guaranteed by locked Tokio1.52.3");
    assert!(s.destroyed.load(Ordering::Acquire));
    assert!(runtime.session.lock().is_none());
}

#[test]
fn r79_review_red_hidden_created_session_is_not_globally_reusable() {
    let runtime = Runtime::default();
    let s = session("a");
    runtime.opening.store(true, Ordering::Release);
    *runtime.session.lock() = Some(s);
    assert!(
        runtime.reusable_session().is_err(),
        "hidden opening transaction must not be promoted by another About"
    );
}
