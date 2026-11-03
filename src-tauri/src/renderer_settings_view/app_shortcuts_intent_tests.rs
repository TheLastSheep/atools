use super::*;
use std::time::Duration;

#[tokio::test]
async fn eval_success_alone_is_not_consumption_and_false_is_refusal() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let wait = wait_for_consumption(async { Ok(()) }, rx, Duration::from_millis(100));
    tokio::pin!(wait);
    tokio::select! {
        _ = &mut wait => panic!("eval submission cannot complete the caller"),
        _ = tokio::task::yield_now() => {}
    }
    tx.send(false).unwrap();
    assert!(!wait.await);
}
#[tokio::test]
async fn accepted_ack_completes_only_after_delivery_and_missing_ack_times_out() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    tx.send(true).unwrap();
    assert!(wait_for_consumption(async { Ok(()) }, rx, ACK_TIMEOUT).await);
    let (_tx, rx) = tokio::sync::oneshot::channel();
    assert!(!wait_for_consumption(async { Ok(()) }, rx, Duration::from_millis(1)).await);
}
#[tokio::test]
async fn delivery_failure_and_revocation_wake_without_waiting_for_deadline() {
    let (_tx, rx) = tokio::sync::oneshot::channel();
    assert!(!wait_for_consumption(async { Err(rejected()) }, rx, ACK_TIMEOUT).await);
    let (tx, rx) = tokio::sync::oneshot::channel();
    drop(tx);
    assert!(!wait_for_consumption(async { Ok(()) }, rx, ACK_TIMEOUT).await);
    let (tx, rx) = tokio::sync::oneshot::channel();
    tx.send(true).unwrap();
    assert!(!wait_for_consumption(std::future::pending(), rx, Duration::from_millis(1)).await);
}

#[tokio::test]
async fn catalog_completion_cannot_reverse_admitted_intent_order() {
    use super::super::{open_claims::ClaimKind, session::SettingsViewRuntime};
    let runtime = SettingsViewRuntime::default();
    let (instance, _) = runtime.register_main_instance().unwrap();
    let (main, _) = runtime.note_main_started(instance).unwrap();
    runtime.note_main_finished(main).unwrap();
    let (first, first_sequence, _) = runtime.admit_request(main, ClaimKind::AppIntent).unwrap();
    let (catalog_tx, catalog_rx) = tokio::sync::oneshot::channel();
    let first_lookup = check_admitted_catalog(async { catalog_rx.await.unwrap() }, || {
        runtime
            .open_claim_live(first)
            .then_some(())
            .ok_or_else(rejected)
    });
    tokio::pin!(first_lookup);
    tokio::select! {
        _ = &mut first_lookup => panic!("lookup crossed its barrier"),
        _ = tokio::task::yield_now() => {}
    }
    let (second, second_sequence, _) = runtime.admit_request(main, ClaimKind::AppIntent).unwrap();
    assert!(second_sequence > first_sequence);
    check_admitted_catalog(async { Ok(true) }, || {
        runtime
            .open_claim_live(second)
            .then_some(())
            .ok_or_else(rejected)
    })
    .await
    .unwrap();
    catalog_tx.send(Ok(true)).unwrap();
    assert!(first_lookup.await.is_err());
    assert!(runtime.open_claim_live(second));
}

#[tokio::test]
async fn same_url_main_started_and_old_instance_destroy_revalidate_after_catalog() {
    use super::super::{open_claims::ClaimKind, session::SettingsViewRuntime};
    let runtime = SettingsViewRuntime::default();
    let (instance, _) = runtime.register_main_instance().unwrap();
    let (main, _) = runtime.note_main_started(instance).unwrap();
    runtime.note_main_finished(main).unwrap();
    let (claim, _, _) = runtime.admit_request(main, ClaimKind::AppIntent).unwrap();
    let (next, _) = runtime.note_main_started(instance).unwrap();
    // No URL inequality is necessary: every Started revokes the old claim.
    runtime.note_main_finished(next).unwrap();
    assert!(check_admitted_catalog(async { Ok(true) }, || {
        runtime
            .open_claim_live(claim)
            .then_some(())
            .ok_or_else(rejected)
    })
    .await
    .is_err());
    let (replacement, _) = runtime.register_main_instance().unwrap();
    let (key, _) = runtime.note_main_started(replacement).unwrap();
    runtime.note_main_finished(key).unwrap();
    runtime.note_main_destroyed(instance).unwrap();
    assert_eq!(runtime.finished_main(), Some(key));
    assert!(runtime.note_main_finished(main).is_err());
}
