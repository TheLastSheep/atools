use super::*;
use std::sync::Arc;
#[test]
fn main_push_window_receipt_is_one_shot_and_wrong_ticket_or_window_cannot_consume() {
    let runtime = Runtime::default();
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, mut rx) = intent.start().unwrap();
    assert!(intent
        .complete("other", receipt(&r, &ticket, Outcome::Empty))
        .is_err());
    assert!(intent
        .complete("main", receipt(&r, "wrong", Outcome::Empty))
        .is_err());
    assert!(rx.try_recv().is_err());
    intent
        .complete("main", receipt(&r, &ticket, Outcome::Empty))
        .unwrap();
    assert_eq!(rx.try_recv().unwrap().unwrap().outcome, Outcome::Empty);
    assert!(intent
        .complete("main", receipt(&r, &ticket, Outcome::Empty))
        .is_err());
}

#[test]
fn main_push_cancellation_closes_pending_approvals_and_executing_receipts_without_replay() {
    let runtime = Runtime::default();
    let r = request(Operation::Prepare);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    intent.state.lock().run = Some("durable-run".into());
    assert!(runtime.remove(&r.request_id, Some("foreign")).is_none());
    let closed = runtime.remove(&r.request_id, Some("main")).unwrap();
    assert_eq!(closed.close().as_deref(), Some("durable-run"));
    assert!(closed.start().is_err());
    assert!(runtime.get(&r.request_id).is_err());
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, mut rx) = intent.start().unwrap();
    intent.close();
    assert_eq!(
        rx.try_recv().unwrap().unwrap_err(),
        "ERR_MAIN_PUSH_CANCELLED"
    );
    assert!(intent
        .complete("main", receipt(&r, &ticket, Outcome::Empty))
        .is_err());
}

#[test]
fn main_push_runner_and_global_bounds_reject_growth_and_plugin_invalidation_is_scoped() {
    let runtime = Runtime::default();
    for _ in 0..2 {
        runtime
            .begin("main".into(), request(Operation::Prepare))
            .unwrap();
    }
    assert!(runtime
        .begin("main".into(), request(Operation::Prepare))
        .is_err());
    assert_eq!(runtime.take(None, Some("absent"), false).len(), 0);
    assert_eq!(runtime.take(Some("other"), None, false).len(), 0);
    assert_eq!(runtime.take(None, Some("fixture"), false).len(), 2);
    for n in 0..32 {
        runtime
            .begin(format!("window-{n}"), request(Operation::Prepare))
            .unwrap();
    }
    assert!(runtime
        .begin("last".into(), request(Operation::Prepare))
        .is_err());
}

#[tokio::test]
async fn main_push_actual_receipt_wait_has_no_early_success_and_cancellation_releases_waiter() {
    let runtime = Arc::new(Runtime::default());
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, rx) = intent.start().unwrap();
    let task_intent = intent.clone();
    let task = tokio::spawn(async move { super::super::execution::wait(&task_intent, rx).await });
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    intent
        .complete("main", receipt(&r, &ticket, Outcome::Empty))
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap().outcome, Outcome::Empty);
    let r = request(Operation::Query);
    let intent = runtime.begin("other".into(), r).unwrap();
    let (_, rx) = intent.start().unwrap();
    let t = intent.clone();
    let task = tokio::spawn(async move { super::super::execution::wait(&t, rx).await });
    intent.close();
    assert_eq!(task.await.unwrap().unwrap_err(), "ERR_MAIN_PUSH_CANCELLED");
}

#[test]
fn main_push_waiting_requires_current_ticket_and_does_not_authorize_resources() {
    let runtime = Runtime::default();
    let r = request(Operation::Query);
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let (ticket, _rx) = intent.start().unwrap();
    assert!(intent.waiting("foreign", &ticket, true).is_err());
    assert!(intent.waiting("main", "foreign", true).is_err());
    intent.waiting("main", &ticket, true).unwrap();
    assert!(intent
        .state
        .lock()
        .flight
        .as_ref()
        .unwrap()
        .clock
        .remaining(r.operation.deadline(), std::time::Instant::now())
        .is_none());
    intent.waiting("main", &ticket, false).unwrap();
    assert!(intent
        .state
        .lock()
        .flight
        .as_ref()
        .unwrap()
        .clock
        .remaining(r.operation.deadline(), std::time::Instant::now())
        .is_some());
    intent.close();
    assert!(intent.waiting("main", &ticket, false).is_err());
}

#[test]
fn main_push_receipt_does_not_accept_enter_for_query_or_rows_for_prepare() {
    let r = request(Operation::Query);
    let mut receipt = receipt(&r, "ticket", Outcome::Enter);
    assert!(receipt.validate(Operation::Query).is_err());
    receipt.outcome = Outcome::Handled;
    receipt.row_count = 21;
    assert!(receipt.validate(Operation::Query).is_err());
    receipt.outcome = Outcome::Ready;
    receipt.row_count = 1;
    assert!(receipt.validate(Operation::Prepare).is_err());
    receipt.row_count = 0;
    assert!(receipt.validate(Operation::Prepare).is_ok());
}

#[tokio::test]
async fn main_push_deadline_expires_without_receipt_and_visible_permission_wait_is_paused() {
    use std::time::Duration;
    let runtime = Runtime::default();
    let r = request(Operation::Query);
    let intent = runtime.begin("deadline".into(), r).unwrap();
    let (_, rx) = intent.start().unwrap();
    let outcome = tokio::time::timeout(
        Duration::from_secs(3),
        super::super::execution::wait(&intent, rx),
    )
    .await
    .unwrap();
    assert_eq!(outcome.unwrap_err(), "ERR_MAIN_PUSH_DEADLINE");
    intent.close();
    let r = request(Operation::Query);
    let intent = runtime.begin("waiting".into(), r.clone()).unwrap();
    let (ticket, rx) = intent.start().unwrap();
    intent.waiting("waiting", &ticket, true).unwrap();
    let held = intent.clone();
    let task = tokio::spawn(async move { super::super::execution::wait(&held, rx).await });
    tokio::time::sleep(Duration::from_millis(1250)).await;
    assert!(
        !task.is_finished(),
        "approval time cannot exhaust the 1200ms callback budget"
    );
    intent.waiting("waiting", &ticket, false).unwrap();
    intent
        .complete("waiting", receipt(&r, &ticket, Outcome::Empty))
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap().outcome, Outcome::Empty);
}
