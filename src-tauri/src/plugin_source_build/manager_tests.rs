use super::*;

#[test]
fn source_build_abandoned_unsafe_worker_publishes_quarantine_before_release() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("abandoned").unwrap();
    lease.worker_finished.store(false, Ordering::Release);
    let done = lease.worker_finished.clone();
    let operation_done = lease.finished.clone();
    let unsafe_cleanup = lease.cleanup_unconfirmed.clone();
    drop(lease);
    assert_eq!(manager.claim("early").err().unwrap(), "SOURCE_BUILD_BUSY");
    unsafe_cleanup.store(true, Ordering::Release);
    done.store(true, Ordering::Release);
    operation_done.store(true, Ordering::Release);
    assert!(!manager.state("abandoned").active);
    assert_eq!(
        manager.claim("later").err().unwrap(),
        "SOURCE_BUILD_RECOVERY_REQUIRED"
    );
    // Pruning the original job cannot lose the sticky observation.
    assert_eq!(
        manager.claim("later-again").err().unwrap(),
        "SOURCE_BUILD_RECOVERY_REQUIRED"
    );
}

#[test]
fn source_build_unconfirmed_cleanup_keeps_future_admission_closed() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("unknown").unwrap();
    lease.quarantine();
    drop(lease);
    assert_eq!(
        manager.claim("next").err().unwrap(),
        "SOURCE_BUILD_RECOVERY_REQUIRED"
    );
}

#[test]
fn source_build_admission_stays_closed_until_abandoned_worker_really_finishes() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("one").unwrap();
    lease.worker_finished.store(false, Ordering::Release);
    let done = lease.worker_finished.clone();
    let operation_done = lease.finished.clone();
    let cancel = lease.cancel.clone();
    drop(lease);
    assert!(cancel.load(Ordering::Acquire));
    assert!(manager.state("one").active);
    assert!(manager.claim("two").is_err());
    done.store(true, Ordering::Release);
    operation_done.store(true, Ordering::Release);
    assert!(!manager.state("one").active);
    assert!(manager.claim("two").is_ok());
}

#[test]
fn source_build_cancel_and_install_commit_are_one_atomic_boundary() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("one").unwrap();
    manager.cancel("one").unwrap();
    assert!(lease.phase(Phase::Installing).is_err());
    assert_eq!(manager.state("one").stage, "cancelling");
    assert!(lease.finish().unwrap());
    drop(lease);
    let lease = manager.claim("two").unwrap();
    lease.phase(Phase::Installing).unwrap();
    assert_eq!(
        manager.cancel("two").unwrap_err(),
        "SOURCE_BUILD_INSTALL_COMMIT_STARTED"
    );
    assert!(!lease.cancelled());
    assert!(!lease.finish().unwrap());
}

#[test]
fn source_build_cancel_requires_an_active_exact_worker_and_rejects_terminal_gap() {
    let manager = Arc::new(BuildManager::default());
    assert_eq!(
        manager.cancel("one").unwrap_err(),
        "SOURCE_BUILD_NOT_ACTIVE"
    );
    let lease = manager.claim("one").unwrap();
    assert!(!lease.cancelled());
    assert_eq!(
        manager.cancel("other").unwrap_err(),
        "SOURCE_BUILD_NOT_ACTIVE"
    );
    assert!(!lease.cancelled());
    lease.phase(Phase::Installing).unwrap();
    assert!(!lease.finish().unwrap());
    drop(lease);
    assert_eq!(
        manager.cancel("one").unwrap_err(),
        "SOURCE_BUILD_NOT_ACTIVE"
    );
    assert!(manager.claim("next").is_ok());
}

#[test]
fn accepted_cancel_is_observed_by_finish_and_late_cancel_is_rejected() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("cancel-wins").unwrap();
    manager.cancel("cancel-wins").unwrap();
    assert!(
        lease.finish().unwrap(),
        "accepted cancellation must choose Cancelled"
    );
    assert_eq!(
        manager.cancel("cancel-wins").unwrap_err(),
        "SOURCE_BUILD_OPERATION_FINISHED"
    );
    drop(lease);

    let completed = manager.claim("finish-wins").unwrap();
    assert!(!completed.finish().unwrap());
    assert_eq!(
        manager.cancel("finish-wins").unwrap_err(),
        "SOURCE_BUILD_OPERATION_FINISHED"
    );
}

#[test]
fn publication_gate_serializes_cancel_without_sleep_or_timing_assumptions() {
    let manager = Arc::new(BuildManager::default());
    let cancel_during_work = manager.claim("cancel-during-work").unwrap();
    cancel_during_work.phase(Phase::Materializing).unwrap();
    manager.cancel("cancel-during-work").unwrap();
    assert!(cancel_during_work.finish().unwrap());
    drop(cancel_during_work);

    let publishing = manager.claim("publish-wins").unwrap();
    publishing.phase_gate().enter(Phase::Publishing).unwrap();
    assert_eq!(
        manager.cancel("publish-wins").unwrap_err(),
        "SOURCE_BUILD_PUBLISH_COMMIT_STARTED"
    );
    assert!(!publishing.cancelled());
    assert!(!publishing.finish().unwrap());
}

#[test]
fn abandoned_unreaped_worker_keeps_admission_closed_then_quarantines() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("abandoned-worker").unwrap();
    lease.worker_finished.store(false, Ordering::Release);
    lease.cleanup_unconfirmed.store(true, Ordering::Release);
    let worker_finished = lease.worker_finished.clone();
    drop(lease);
    assert_eq!(
        manager.claim("too-early").err().unwrap(),
        "SOURCE_BUILD_BUSY"
    );

    worker_finished.store(true, Ordering::Release);
    assert_eq!(
        manager.claim("after-reap").err().unwrap(),
        "SOURCE_BUILD_RECOVERY_REQUIRED"
    );
}

#[test]
fn accepted_cancel_cannot_become_terminal_before_worker_reap() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("cancel-waits-for-worker").unwrap();
    lease.worker_finished.store(false, Ordering::Release);
    manager.cancel("cancel-waits-for-worker").unwrap();
    assert_eq!(lease.finish().unwrap_err(), "SOURCE_BUILD_WORKER_ACTIVE");
    assert!(lease.cancelled());
    lease.worker_finished.store(true, Ordering::Release);
    assert!(lease.finish().unwrap());
}

#[test]
fn unconfirmed_dependency_worker_failure_is_preserved_and_quarantined_before_finish() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("unreaped-dependency-worker").unwrap();
    lease.worker_finished.store(false, Ordering::Release);
    lease.cleanup_unconfirmed.store(true, Ordering::Release);

    let original: Result<(), String> = Err("SOURCE_DEPENDENCY_WORKER_UNREAPED".to_owned());
    let preserved: Result<(), String> = if lease.quarantine_unconfirmed_worker() {
        Err(original
            .err()
            .unwrap_or_else(|| "SOURCE_DEPENDENCY_CLEANUP_UNCONFIRMED".to_owned()))
    } else {
        original
    };

    assert_eq!(preserved.unwrap_err(), "SOURCE_DEPENDENCY_WORKER_UNREAPED");
    assert!(!lease.worker_finished.load(Ordering::Acquire));
    assert_eq!(lease.finish().unwrap_err(), "SOURCE_BUILD_WORKER_ACTIVE");
    let state = manager.state("unreaped-dependency-worker");
    assert!(state.active);
    assert!(state.recovery_required);
    assert_eq!(
        manager.claim("next").err().unwrap(),
        "SOURCE_BUILD_RECOVERY_REQUIRED"
    );
}

#[test]
fn unconfirmed_worker_cleanup_cannot_report_success() {
    let manager = Arc::new(BuildManager::default());
    let lease = manager.claim("unconfirmed-success").unwrap();
    lease.worker_finished.store(false, Ordering::Release);
    lease.cleanup_unconfirmed.store(true, Ordering::Release);

    let original: Result<(), String> = Ok(());
    let preserved: Result<(), String> = if lease.quarantine_unconfirmed_worker() {
        Err(original
            .err()
            .unwrap_or_else(|| "SOURCE_DEPENDENCY_CLEANUP_UNCONFIRMED".to_owned()))
    } else {
        original
    };

    assert_eq!(
        preserved.unwrap_err(),
        "SOURCE_DEPENDENCY_CLEANUP_UNCONFIRMED"
    );
    assert!(!lease.worker_finished.load(Ordering::Acquire));
    assert!(manager.state("unconfirmed-success").recovery_required);
}
