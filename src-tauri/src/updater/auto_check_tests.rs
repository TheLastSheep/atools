use super::*;
use std::sync::atomic::AtomicUsize;
async fn settled() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}
#[tokio::test(start_paused = true)]
async fn one_immediate_periodic_skip_duplicate_disable_and_shutdown_without_wall_wait() {
    let scheduler = Arc::new(Scheduler::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let task = tokio::spawn(scheduler.clone().drive(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        true
    }));
    scheduler.commit(true, None);
    settled().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    scheduler.commit(true, None);
    settled().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(PERIOD).await;
    settled().await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // Missed intervals are skipped, not replayed as a burst of queued checks.
    tokio::time::advance(PERIOD * 20).await;
    settled().await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    scheduler.commit(false, None);
    settled().await;
    tokio::time::advance(PERIOD * 3).await;
    settled().await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    scheduler.stop();
    task.await.unwrap();
    assert!(!scheduler.commit(true, None).runtime_applied);
}
#[tokio::test(start_paused = true)]
async fn quick_toggle_pending_immediate_waits_real_worker_and_never_queues_ticks() {
    let scheduler = Arc::new(Scheduler::default());
    let busy = Arc::new(AtomicBool::new(true));
    let b = busy.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let task = tokio::spawn(scheduler.clone().drive(move |_| {
        if b.load(Ordering::Acquire) {
            false
        } else {
            count.fetch_add(1, Ordering::SeqCst);
            true
        }
    }));
    scheduler.commit(true, None);
    settled().await;
    let old = scheduler.generation().unwrap();
    scheduler.commit(false, None);
    scheduler.commit(true, None);
    settled().await;
    assert!(!scheduler.current(old));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    busy.store(false, Ordering::Release);
    scheduler.finished.notify_one();
    settled().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    scheduler.stop();
    task.await.unwrap();
}
#[test]
fn runtime_error_receipts_are_closed_bounded_and_success_is_not_network_completion() {
    let success = serde_json::to_value(Receipt::success()).unwrap();
    assert_eq!(
        success,
        serde_json::json!({"runtimeApplied":true,"runtimeError":null})
    );
    for code in [
        "SETTINGS_UPDATER_RUNTIME_UNAVAILABLE",
        "SETTINGS_UPDATER_PROVIDER_DISABLED",
        "SETTINGS_UPDATER_PROVIDER_UNAVAILABLE",
        "SETTINGS_UPDATER_RUNTIME_STOPPED",
    ] {
        let receipt = Receipt::failed(code);
        assert!(!receipt.runtime_applied);
        assert_eq!(receipt.runtime_error.as_ref().unwrap().code, code);
        assert!(serde_json::to_vec(&receipt.runtime_error).unwrap().len() <= 2048);
    }
}
