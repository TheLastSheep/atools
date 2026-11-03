use super::*;
use std::time::{Duration, Instant};

#[test]
fn main_push_expired_active_receipt_is_rejected_before_success_can_be_queued() {
    let runtime = Runtime::default();
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, mut rx) = intent.start().unwrap();
    intent
        .state
        .lock()
        .flight
        .as_mut()
        .unwrap()
        .clock
        .age_active(r.operation.deadline() + Duration::from_millis(1));
    assert_eq!(
        intent
            .complete("main", receipt(&r, &ticket, Outcome::Empty))
            .unwrap_err(),
        "ERR_MAIN_PUSH_DEADLINE"
    );
    assert_eq!(
        rx.try_recv().unwrap().unwrap_err(),
        "ERR_MAIN_PUSH_DEADLINE"
    );
}
#[test]
fn main_push_permission_wait_cannot_pause_an_already_exhausted_execution_budget() {
    let runtime = Runtime::default();
    let r = request(Operation::Select);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, mut rx) = intent.start().unwrap();
    intent
        .state
        .lock()
        .flight
        .as_mut()
        .unwrap()
        .clock
        .age_active(r.operation.deadline() + Duration::from_millis(1));
    assert_eq!(
        intent.waiting("main", &ticket, true).unwrap_err(),
        "ERR_MAIN_PUSH_DEADLINE"
    );
    assert_eq!(
        rx.try_recv().unwrap().unwrap_err(),
        "ERR_MAIN_PUSH_DEADLINE"
    );
}
#[tokio::test]
async fn main_push_prequeued_receipt_cannot_win_when_expired_budget_is_later_paused() {
    let runtime = Runtime::default();
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, rx) = intent.start().unwrap();
    {
        let mut state = intent.state.lock();
        let flight = state.flight.as_mut().unwrap();
        flight
            .clock
            .age_active(r.operation.deadline() + Duration::from_millis(1));
        flight.clock.waiting(true, Instant::now());
        // Exercise the ready oneshot branch independently of complete()'s admission check.
        flight
            .reply
            .take()
            .unwrap()
            .send(Ok(receipt(&r, &ticket, Outcome::Empty)))
            .unwrap();
    }
    assert_eq!(
        super::super::execution::wait(&intent, rx)
            .await
            .unwrap_err(),
        "ERR_MAIN_PUSH_DEADLINE"
    );
}

#[tokio::test]
async fn main_push_receipt_acceptance_stops_clock_before_later_receiver_poll() {
    let runtime = Runtime::default();
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, rx) = intent.start().unwrap();
    intent
        .state
        .lock()
        .flight
        .as_mut()
        .unwrap()
        .clock
        .age_active(Duration::from_millis(500));
    intent
        .complete("main", receipt(&r, &ticket, Outcome::Empty))
        .unwrap();
    assert!(intent
        .state
        .lock()
        .flight
        .as_ref()
        .unwrap()
        .clock
        .remaining(
            r.operation.deadline(),
            Instant::now() + Duration::from_secs(3600),
        )
        .is_none());
    assert_eq!(
        super::super::execution::wait(&intent, rx)
            .await
            .unwrap()
            .outcome,
        Outcome::Empty
    );
}

#[tokio::test]
async fn main_push_real_permission_pause_preserves_remaining_budget_for_receipt() {
    let runtime = Runtime::default();
    let r = request(Operation::Select);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, rx) = intent.start().unwrap();
    intent
        .state
        .lock()
        .flight
        .as_mut()
        .unwrap()
        .clock
        .age_active(Duration::from_millis(500));
    intent.waiting("main", &ticket, true).unwrap();
    assert!(intent
        .state
        .lock()
        .flight
        .as_ref()
        .unwrap()
        .clock
        .remaining(
            r.operation.deadline(),
            Instant::now() + Duration::from_secs(3600),
        )
        .is_none());
    intent
        .complete("main", receipt(&r, &ticket, Outcome::Handled))
        .unwrap();
    assert_eq!(
        super::super::execution::wait(&intent, rx)
            .await
            .unwrap()
            .outcome,
        Outcome::Handled
    );
}

#[tokio::test]
async fn main_push_receiver_ready_branch_rechecks_deadline_after_initial_wait_poll() {
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };
    struct Noop;
    impl Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }
    let runtime = Runtime::default();
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, rx) = intent.start().unwrap();
    let waker = Waker::from(Arc::new(Noop));
    let mut context = Context::from_waker(&waker);
    let mut waiting = Box::pin(super::super::execution::wait(&intent, rx));
    assert!(waiting.as_mut().poll(&mut context).is_pending());
    {
        let mut state = intent.state.lock();
        let flight = state.flight.as_mut().unwrap();
        flight
            .clock
            .age_active(r.operation.deadline() + Duration::from_millis(1));
        flight.clock.waiting(true, Instant::now());
        flight
            .reply
            .take()
            .unwrap()
            .send(Ok(receipt(&r, &ticket, Outcome::Empty)))
            .unwrap();
    }
    assert!(
        matches!(waiting.as_mut().poll(&mut context), Poll::Ready(Err(error)) if error == "ERR_MAIN_PUSH_DEADLINE")
    );
}
