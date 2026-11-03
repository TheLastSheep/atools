use super::*;
use atools_core::task_run::TaskRunInitiator;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn wait_for_cancel(
    cancelled: Arc<AtomicBool>,
    cancel_observed: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
) -> impl FnOnce() -> Result<(), String> + Send + 'static {
    move || {
        let bounded_wait = Instant::now() + Duration::from_secs(5);
        while !cancelled.load(Ordering::Acquire) && Instant::now() < bounded_wait {
            std::thread::sleep(Duration::from_millis(1));
        }
        cancel_observed.store(cancelled.load(Ordering::Acquire), Ordering::Release);
        finished.store(true, Ordering::Release);
        Ok(())
    }
}

async fn assert_deadline_helper_path(deadline: Instant) {
    let cancelled = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let cancel_observed = Arc::new(AtomicBool::new(false));
    let context = diagnostics::Context::new("deadline-helper-test");
    context.set_stage(DiagnosticStage::Preflight);
    let result = run_blocking_until(
        Arc::clone(&cancelled),
        deadline,
        wait_for_cancel(
            Arc::clone(&cancelled),
            Arc::clone(&cancel_observed),
            Arc::clone(&finished),
        ),
        "TEST_JOIN_FAILED",
        Some(&context),
    )
    .await;
    assert!(matches!(result, Err(ref error) if error == "SOURCE_DEPENDENCY_OPERATION_TIMEOUT"));
    assert!(cancelled.load(Ordering::Acquire));
    assert!(
        cancel_observed.load(Ordering::Acquire),
        "worker must observe cancellation before returning"
    );
    assert!(
        finished.load(Ordering::Acquire),
        "timeout helper must await the blocking closure"
    );
    let value = context.diagnostic();
    assert_eq!(value["cause"], "operation_deadline");
    assert_eq!(value["causeStage"], "preflight");
    assert!(value["stageElapsedMs"]["preflight"].as_u64().is_some());
    assert!(value["cleanupElapsedMs"].as_u64().is_some());
    assert!(
        value["workerReaped"].is_null(),
        "blocking closure completion is not process reap evidence"
    );
}

#[tokio::test]
async fn deadline_helper_timeout_cancels_and_joins_worker() {
    assert_deadline_helper_path(Instant::now() + Duration::from_millis(2)).await;
}

#[tokio::test]
async fn deadline_helper_already_expired_branch_cancels_and_joins_worker() {
    assert_deadline_helper_path(Instant::now() - Duration::from_millis(1)).await;
}

#[test]
fn accepted_manager_cancel_marks_only_exact_prepare_registration() {
    let _serial = diagnostics::TEST_ACTIVE_LOCK.lock().unwrap();
    let manager = Arc::new(super::super::super::manager::BuildManager::default());
    let run = TaskRun::new(
        registry::PREPARE,
        TaskRunInitiator::agent("fixture"),
        json!({}),
    );
    let (context, _registration) = diagnostics::register(&run.id);
    let _lease = manager.claim(&run.id).unwrap();
    request_cancel_with_manager(&run, manager.as_ref()).unwrap();
    let value = context.diagnostic();
    assert_eq!(value["cause"], "user_cancel");
    assert_eq!(value["causeStage"], "derive");
    assert!(manager.state(&run.id).cancel_requested);
}

#[test]
fn rejected_or_wrong_identity_cancel_never_marks_diagnostic_cause() {
    let _serial = diagnostics::TEST_ACTIVE_LOCK.lock().unwrap();
    let manager = Arc::new(super::super::super::manager::BuildManager::default());
    let target = TaskRun::new(
        registry::PREPARE,
        TaskRunInitiator::agent("fixture"),
        json!({}),
    );
    let (context, _registration) = diagnostics::register(&target.id);
    let _other_lease = manager.claim("different-active-run").unwrap();
    let error = request_cancel_with_manager(&target, manager.as_ref()).unwrap_err();
    assert_eq!(error, "SOURCE_BUILD_NOT_ACTIVE");
    assert_eq!(context.diagnostic()["cause"], "unknown");
    let invalid = TaskRun::new(
        "not_a_dependency_tool",
        TaskRunInitiator::agent("fixture"),
        json!({}),
    );
    assert_eq!(
        request_cancel_with_manager(&invalid, manager.as_ref()).unwrap_err(),
        "SOURCE_DEPENDENCY_TASK_IDENTITY"
    );
    assert_eq!(context.diagnostic()["cause"], "unknown");
}
