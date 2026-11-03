//! Small ownership primitives shared by the native caller and its barrier tests.
use serde_json::Value;
use tokio::sync::oneshot;

pub(crate) struct Envelope<L> {
    pub(crate) receipt: Value,
    pub(crate) observer: L,
}

pub(crate) fn send_envelope<L>(receipt: Value, observer: L) -> oneshot::Receiver<Envelope<L>> {
    let (send, receive) = oneshot::channel();
    // If delivery fails, the returned envelope is dropped outside the state lock.
    let _ = send.send(Envelope { receipt, observer });
    receive
}

pub(crate) struct StageGuard<F: FnOnce()> {
    finish: Option<F>,
}
impl<F: FnOnce()> StageGuard<F> {
    pub(crate) fn new(finish: F) -> Self {
        Self {
            finish: Some(finish),
        }
    }
}
impl<F: FnOnce()> Drop for StageGuard<F> {
    fn drop(&mut self) {
        if let Some(finish) = self.finish.take() {
            finish();
        }
    }
}

pub(crate) struct ConstructorGuard<F: FnOnce(Result<Value, String>)> {
    finish: Option<F>,
}

impl<F: FnOnce(Result<Value, String>)> ConstructorGuard<F> {
    pub(crate) fn new(finish: F) -> Self {
        Self {
            finish: Some(finish),
        }
    }
    pub(crate) fn finish(&mut self, result: Result<Value, String>) {
        if let Some(finish) = self.finish.take() {
            finish(result);
        }
    }
}
impl<F: FnOnce(Result<Value, String>)> Drop for ConstructorGuard<F> {
    fn drop(&mut self) {
        self.finish(Err("Settings constructor stopped unexpectedly".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct Lease(Arc<AtomicUsize>);
    impl Drop for Lease {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn sent_but_unpolled_receiver_drops_lease() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let receiver = send_envelope(Value::Null, Lease(Arc::clone(&dropped)));
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        drop(receiver);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn guard_finishes_once_on_success_error_and_unwind() {
        for mode in 0..3 {
            let calls = Arc::new(AtomicUsize::new(0));
            let calls_in = Arc::clone(&calls);
            let _ = std::panic::catch_unwind(move || {
                let mut guard = ConstructorGuard::new(move |_| {
                    calls_in.fetch_add(1, Ordering::SeqCst);
                });
                match mode {
                    0 => guard.finish(Ok(Value::Null)),
                    1 => guard.finish(Err("error".into())),
                    _ => panic!("constructor panic"),
                }
            });
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }
    use super::super::open_claims::{
        Adoption, ClaimId, ClaimKind, ClosingTicket, MainKey, OpenClaims, SessionKey,
    };
    use std::sync::Mutex;
    struct ClaimLease {
        state: Arc<Mutex<OpenClaims>>,
        claim: ClaimId,
        tickets: Arc<Mutex<Vec<ClosingTicket>>>,
    }
    impl Drop for ClaimLease {
        fn drop(&mut self) {
            let ticket = self.state.lock().unwrap().abandon(self.claim);
            if let Some(ticket) = ticket {
                self.tickets.lock().unwrap().push(ticket);
            }
        }
    }
    fn setup() -> (
        Arc<Mutex<OpenClaims>>,
        MainKey,
        SessionKey,
        Arc<Mutex<Vec<ClosingTicket>>>,
    ) {
        let mut state = OpenClaims::default();
        let (instance, _) = state.register_main_instance().unwrap();
        let (main, _) = state.note_main_started(instance).unwrap();
        state.note_main_finished(main).unwrap();
        (
            Arc::new(Mutex::new(state)),
            main,
            SessionKey {
                id: "one".into(),
                revoked_identity: 1,
            },
            Arc::new(Mutex::new(Vec::new())),
        )
    }
    fn claim(
        state: &Arc<Mutex<OpenClaims>>,
        main: MainKey,
        key: &SessionKey,
        tickets: &Arc<Mutex<Vec<ClosingTicket>>>,
    ) -> ClaimLease {
        let mut locked = state.lock().unwrap();
        let (id, _, _) = locked.admit_request(main, ClaimKind::General).unwrap();
        locked.join_or_start(id, key.clone()).unwrap();
        ClaimLease {
            state: Arc::clone(state),
            claim: id,
            tickets: Arc::clone(tickets),
        }
    }
    #[test]
    fn two_cancel_before_constructor_exits_closes_only_after_guard_finishes() {
        let (state, main, key, tickets) = setup();
        let a = claim(&state, main, &key, &tickets);
        let b = claim(&state, main, &key, &tickets);
        let finish_state = Arc::clone(&state);
        let finish_tickets = Arc::clone(&tickets);
        let finish_key = key.clone();
        let guard = ConstructorGuard::new(move |_| {
            let ticket = finish_state.lock().unwrap().finish_constructor(&finish_key);
            if let Some(ticket) = ticket {
                finish_tickets.lock().unwrap().push(ticket);
            }
        });
        drop(send_envelope(Value::Null, a));
        drop(b);
        assert!(tickets.lock().unwrap().is_empty());
        drop(guard);
        assert_eq!(*tickets.lock().unwrap(), vec![ClosingTicket(key)]);
    }
    #[tokio::test]
    async fn adoption_by_one_survives_older_receiver_cancellation() {
        let (state, main, key, tickets) = setup();
        let a = send_envelope(Value::Null, claim(&state, main, &key, &tickets));
        let b = send_envelope(Value::Null, claim(&state, main, &key, &tickets));
        let envelope = b.await.unwrap();
        state
            .lock()
            .unwrap()
            .adopt(envelope.observer.claim, Adoption::GeneralReplyConsumed)
            .unwrap();
        drop(envelope);
        drop(a);
        assert!(state.lock().unwrap().finish_constructor(&key).is_none());
        assert!(tickets.lock().unwrap().is_empty());
    }
    #[test]
    fn admitted_stage_defers_constructor_failure_cleanup_until_exit() {
        let (state, main, key, tickets) = setup();
        let lease = claim(&state, main, &key, &tickets);
        let token = state.lock().unwrap().begin_stage(main, &key).unwrap();
        assert!(state.lock().unwrap().fail_constructor(&key).is_none());
        assert!(state.lock().unwrap().finish_stage(&token).is_err());
        drop(lease);
        state.lock().unwrap().retire(&key);
        assert!(state.lock().unwrap().has_slot(&key));
        assert_eq!(
            state.lock().unwrap().end_stage(&key),
            Some(ClosingTicket(key.clone()))
        );
        state.lock().unwrap().retire(&key);
        assert!(!state.lock().unwrap().has_slot(&key));
    }

    #[test]
    fn queued_or_old_stage_cannot_retain_or_release_new_slot() {
        let (state, main, old, tickets) = setup();
        let lease = claim(&state, main, &old, &tickets);
        drop(lease);
        assert_eq!(
            state.lock().unwrap().finish_constructor(&old),
            Some(ClosingTicket(old.clone()))
        );
        state.lock().unwrap().retire(&old);
        let next = SessionKey {
            id: "new".into(),
            revoked_identity: 2,
        };
        let next_lease = claim(&state, main, &next, &tickets);
        assert!(state.lock().unwrap().begin_stage(main, &old).is_err());
        assert!(state.lock().unwrap().end_stage(&old).is_none());
        assert!(state.lock().unwrap().has_slot(&next));
        drop(next_lease);
    }

    #[test]
    fn focus_stage_keeps_adopted_slot_until_explicit_close_and_exit() {
        let (state, main, key, tickets) = setup();
        let lease = claim(&state, main, &key, &tickets);
        state
            .lock()
            .unwrap()
            .adopt(lease.claim, Adoption::GeneralReplyConsumed)
            .unwrap();
        drop(lease);
        assert!(state.lock().unwrap().finish_constructor(&key).is_none());
        let _token = state.lock().unwrap().begin_stage(main, &key).unwrap();
        state.lock().unwrap().invalidate_session(&key);
        state.lock().unwrap().retire(&key);
        assert!(state.lock().unwrap().busy(&key));
        assert_eq!(
            state.lock().unwrap().end_stage(&key),
            Some(ClosingTicket(key.clone()))
        );
        state.lock().unwrap().retire(&key);
        assert!(!state.lock().unwrap().has_slot(&key));
    }
    #[test]
    fn real_stage_guard_reentrant_cleanup_occurs_after_state_unlock() {
        let (state, main, key, tickets) = setup();
        let lease = claim(&state, main, &key, &tickets);
        state.lock().unwrap().begin_stage(main, &key).unwrap();
        assert!(state.lock().unwrap().fail_constructor(&key).is_none());
        let guard_state = Arc::clone(&state);
        let guard_key = key.clone();
        let guard = StageGuard::new(move || {
            let ticket = { guard_state.lock().unwrap().end_stage(&guard_key) };
            assert!(ticket.is_some());
            assert!(
                guard_state.try_lock().is_ok(),
                "cleanup must run after state unlock"
            );
        });
        drop(lease);
        drop(guard);
    }
}
