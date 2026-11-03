//! Production runtime admission/ACK transitions; SDK authentication needs Native smoke.
use super::*;
use serde_json::json;
use settings::{bundle::SettingsBundle, open_claims::ClaimKind, preferences::SettingsPreferences};

fn setup() -> (SettingsViewRuntime, MainKey, SessionView) {
    let runtime = SettingsViewRuntime::default();
    let (instance, _) = runtime.register_main_instance().unwrap();
    let (main, _) = runtime.note_main_started(instance).unwrap();
    runtime.note_main_finished(main).unwrap();
    let session = runtime
        .begin_session(
            "00000000000040008000000000000001".into(),
            Arc::new(SettingsBundle::height_test_bundle("bundle")),
            Arc::new(SettingsPreferences::height_test_preferences(None)),
            json!({}),
            json!("darwin"),
        )
        .unwrap();
    runtime.mark_opened_with(&session.id, |_| Ok(())).unwrap();
    runtime
        .note_index_request(&session.label, &session.origin)
        .unwrap();
    runtime.record_page_started(&session.id).unwrap();
    runtime
        .record_ready(&session.id, &session.bundle_revision)
        .unwrap();
    runtime.mark_open_with(&session.id, |_| Ok(())).unwrap();
    (runtime, main, session)
}
fn pending(
    runtime: &SettingsViewRuntime,
    main: MainKey,
    session: &SessionView,
    id: &str,
) -> (ClaimId, u64, oneshot::Receiver<bool>) {
    let (claim, sequence, _) = runtime.admit_request(main, ClaimKind::AppIntent).unwrap();
    runtime.join_or_start(claim, session_key(session)).unwrap();
    runtime.finish_open_constructor(&session_key(session));
    let sequence = sequence.unwrap();
    let receiver = runtime
        .reserve_intent(id.into(), sequence, session, claim, main)
        .unwrap();
    (claim, sequence, receiver)
}
fn ack(id: &str, sequence: u64, accepted: bool) -> IntentAck {
    settings::intent_protocol::parse_ack(&json!({"id":id,"sequence":sequence,"accepted":accepted}))
        .unwrap()
}
#[test]
fn wrong_duplicate_and_late_ack_cannot_consume_new_pending() {
    let (runtime, main, session) = setup();
    let old = "a".repeat(32);
    let new = "b".repeat(32);
    let (_, sequence, mut old_rx) = pending(&runtime, main, &session, &old);
    let (claim, next, mut new_rx) = pending(&runtime, main, &session, &new);
    assert!(matches!(
        old_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    assert!(runtime
        .acknowledge_intent(&session, ack(&old, sequence, true))
        .is_err());
    assert!(runtime
        .acknowledge_intent(&session, ack(&new, sequence, true))
        .is_err());
    assert!(runtime.intent_pending(&new, next, claim, &session));
    runtime
        .acknowledge_intent(&session, ack(&new, next, true))
        .unwrap();
    assert_eq!(new_rx.try_recv(), Ok(true));
    assert!(runtime
        .acknowledge_intent(&session, ack(&new, next, true))
        .is_err());
}
#[test]
fn accepted_ack_adopts_before_older_general_observer_abandons() {
    let (runtime, main, session) = setup();
    let (general, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
    runtime
        .join_or_start(general, session_key(&session))
        .unwrap();
    let id = "a".repeat(32);
    let (_, sequence, mut receiver) = pending(&runtime, main, &session, &id);
    // ACK is independent of the ordinary operation semaphore.
    let _all_operations = session
        .operations
        .clone()
        .try_acquire_many_owned(32)
        .unwrap();
    runtime
        .acknowledge_intent(&session, ack(&id, sequence, true))
        .unwrap();
    assert_eq!(receiver.try_recv(), Ok(true));
    assert!(runtime.abandon_open(general).is_none());
    assert!(runtime
        .finish_open_constructor(&session_key(&session))
        .is_none());
}
#[test]
fn observer_cancellation_before_ack_wins_and_wakes_waiter() {
    let (runtime, main, session) = setup();
    let id = "a".repeat(32);
    let (claim, sequence, mut receiver) = pending(&runtime, main, &session, &id);
    assert!(runtime.abandon_open(claim).is_some());
    assert_eq!(
        receiver.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    );
    assert!(runtime
        .acknowledge_intent(&session, ack(&id, sequence, true))
        .is_err());
}
#[test]
fn all_real_session_revocations_wake_the_ack_waiter() {
    for mode in 0..6 {
        let (runtime, main, session) = setup();
        let id = "a".repeat(32);
        let (_, sequence, mut receiver) = pending(&runtime, main, &session, &id);
        match mode {
            0 => {
                runtime.mark_closing(&session.id, "child-out").unwrap();
            }
            1 => {
                assert!(runtime.record_page_started(&session.id).unwrap());
            }
            2 => {
                runtime.take_if(&session.id).unwrap();
            }
            3 => {
                runtime.take_for_shutdown(&session.id).unwrap();
            }
            4 => {
                runtime.note_main_started(main.window_instance).unwrap();
            }
            _ => {
                runtime.note_main_destroyed(main.window_instance).unwrap();
            }
        }
        assert_eq!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Closed),
            "revocation {mode}"
        );
        assert!(runtime
            .acknowledge_intent(&session, ack(&id, sequence, true))
            .is_err());
    }
}
#[test]
fn refusal_and_exact_cancellation_preserve_other_pending() {
    let (runtime, main, session) = setup();
    let id = "a".repeat(32);
    let (claim, sequence, mut receiver) = pending(&runtime, main, &session, &id);
    assert!(runtime
        .cancel_intent(&"b".repeat(32), sequence, claim)
        .is_none());
    assert!(runtime.intent_pending(&id, sequence, claim, &session));
    assert!(runtime
        .acknowledge_intent(&session, ack(&id, sequence, false))
        .unwrap()
        .is_some());
    assert_eq!(receiver.try_recv(), Ok(false));
}
