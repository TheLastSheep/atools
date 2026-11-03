use std::sync::Arc;

use super::RuntimeAccounting;

#[test]
fn activity_guard_decrements_its_counter_once_when_dropped() {
    let accounting = RuntimeAccounting::shared();
    let call = accounting.track_call();
    let write = accounting.track_write();
    assert_eq!(accounting.snapshot().pending_calls, 1);
    assert_eq!(accounting.snapshot().pending_writes, 1);

    drop(call);
    drop(write);
    assert_eq!(accounting.snapshot().pending_calls, 0);
    assert_eq!(accounting.snapshot().pending_writes, 0);
}

#[tokio::test]
async fn a_new_session_observes_and_waits_for_an_old_owned_write() {
    let runtime_accounting = RuntimeAccounting::shared();
    let old_session_accounting = Arc::clone(&runtime_accounting);
    let old_write = old_session_accounting.track_write();
    drop(old_session_accounting);

    let new_session_accounting = Arc::clone(&runtime_accounting);
    let waiter = tokio::spawn(async move {
        new_session_accounting.wait_for_writes_to_finish().await;
    });
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());
    assert_eq!(runtime_accounting.snapshot().pending_writes, 1);

    drop(old_write);
    waiter.await.unwrap();
    assert_eq!(runtime_accounting.snapshot().pending_writes, 0);
}
