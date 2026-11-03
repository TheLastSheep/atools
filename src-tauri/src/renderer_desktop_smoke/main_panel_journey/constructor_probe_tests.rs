use super::{cleanup_after_drain_retry, native::CleanupObservation, panel_created_fact};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::oneshot;

fn cleanup_pending(panel_created: Option<bool>) -> CleanupObservation {
    CleanupObservation {
        panel_created,
        order_out_confirmed: None,
        close_requested: None,
        owner_cleared: Some(false),
        native_operations_terminal: false,
    }
}

fn cleanup_confirmed() -> CleanupObservation {
    CleanupObservation {
        panel_created: Some(true),
        order_out_confirmed: Some(true),
        close_requested: Some(true),
        owner_cleared: Some(true),
        native_operations_terminal: true,
    }
}

#[tokio::test]
async fn delayed_create_drains_then_retries_owned_panel_cleanup() {
    let creator_terminal = Arc::new(AtomicBool::new(false));
    let panel_owned = Arc::new(AtomicBool::new(false));
    let wait_terminal = Arc::clone(&creator_terminal);
    let delayed_owner = Arc::clone(&panel_owned);
    let (drain_started_tx, drain_started_rx) = oneshot::channel();
    let (finish_create_tx, finish_create_rx) = oneshot::channel();
    let wait = async move {
        let _ = drain_started_tx.send(());
        if finish_create_rx.await.is_err() {
            return false;
        }
        delayed_owner.store(true, Ordering::Release);
        wait_terminal.store(true, Ordering::Release);
        true
    };
    let retry_owner = Arc::clone(&panel_owned);
    let retry_terminal = Arc::clone(&creator_terminal);
    let retry = async move {
        assert!(retry_terminal.load(Ordering::Acquire));
        assert!(retry_owner.swap(false, Ordering::AcqRel));
        cleanup_confirmed()
    };

    let task = tokio::spawn(cleanup_after_drain_retry(
        cleanup_pending(None),
        wait,
        retry,
    ));
    drain_started_rx
        .await
        .expect("cleanup should wait for create");
    assert!(!creator_terminal.load(Ordering::Acquire));
    finish_create_tx.send(()).expect("release delayed create");

    let cleanup = task.await.expect("cleanup coordinator should finish");
    assert!(cleanup.safe());
    assert_eq!(cleanup.panel_created, Some(true));
    assert!(!panel_owned.load(Ordering::Acquire));
}

#[tokio::test]
async fn unknown_nonterminal_operation_is_not_retried_or_promoted_to_absent() {
    let retried = Arc::new(AtomicBool::new(false));
    let retry_marker = Arc::clone(&retried);
    let cleanup = cleanup_pending(None);
    let final_cleanup = cleanup_after_drain_retry(cleanup, async { false }, async move {
        retry_marker.store(true, Ordering::Release);
        cleanup_confirmed()
    })
    .await;

    assert!(!retried.load(Ordering::Acquire));
    assert_eq!(final_cleanup.panel_created, None);
    assert_eq!(final_cleanup.owner_cleared, Some(false));
    assert!(!final_cleanup.safe());
    assert_eq!(panel_created_fact(None, None, Some(false)), None);
}

#[tokio::test]
async fn failed_retry_keeps_cleanup_unconfirmed_and_creation_fact_monotonic() {
    let first = cleanup_pending(Some(true));
    let retry = CleanupObservation {
        panel_created: Some(false),
        order_out_confirmed: Some(false),
        close_requested: Some(true),
        owner_cleared: Some(false),
        native_operations_terminal: true,
    };
    let final_cleanup = cleanup_after_drain_retry(first, async { true }, async { retry }).await;

    assert!(!final_cleanup.safe());
    assert_eq!(
        panel_created_fact(Some(true), Some(true), final_cleanup.panel_created),
        Some(true)
    );
    assert_eq!(final_cleanup.owner_cleared, Some(false));
}
