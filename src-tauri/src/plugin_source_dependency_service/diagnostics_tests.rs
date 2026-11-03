use super::*;
use atools_core::{db::Database, task_run::TaskRunInitiator};
use serde_json::json;
use std::time::Duration;

#[test]
fn unknown_flag_never_implies_user_cancel_and_diagnostic_is_bounded() {
    let context = Context::new("private-run-id");
    let value = context.diagnostic();
    assert_eq!(value["cause"], "unknown");
    assert_eq!(value["causeStage"], "unknown");
    assert!(value["workerReaped"].is_null());
    assert_eq!(value["resourceObservation"]["availability"], "absent");
    assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_DIAGNOSTIC_BYTES);
    assert!(!serde_json::to_string(&value)
        .unwrap()
        .contains("private-run-id"));
    assert!(project_metrics(&Value::Null).is_none());
}

#[test]
fn exact_registration_and_delayed_guard_drop_cannot_clear_new_run() {
    let _serial = TEST_ACTIVE_LOCK.lock().unwrap();
    let (old, old_guard) = register("run-old");
    let (new, _new_guard) = register("run-new");
    drop(old_guard);
    mark_accepted_user_cancel("run-old");
    assert_eq!(old.diagnostic()["cause"], "unknown");
    mark_accepted_user_cancel("stale-id");
    assert_eq!(new.diagnostic()["cause"], "unknown");
    mark_accepted_user_cancel("run-new");
    new.deadline_observed();
    assert_eq!(new.diagnostic()["cause"], "user_cancel");
}

#[test]
fn deadlines_are_first_cause_and_worker_observations_are_only_real() {
    let context = Context::new("run");
    context.set_stage(Stage::Preflight);
    context.deadline_observed();
    context.set_stage(Stage::MaterializeWorker);
    context.worker_observed(true, Some(12), 300, 2);
    let value = context.diagnostic();
    assert_eq!(value["cause"], "operation_deadline");
    assert_eq!(value["causeStage"], "preflight");
    assert_eq!(value["workerReaped"], true);
    assert_eq!(value["resourceObservation"]["availability"], "partial");
    assert_eq!(value["resourceObservation"]["sampleCount"], 256);
    assert_eq!(value["resourceObservation"]["sampleCountCapped"], true);
}

#[test]
fn elapsed_and_sample_counts_are_saturated_without_losing_the_capped_flag() {
    let context = Context::new("run");
    {
        let mut state = context.state.lock();
        let old = Instant::now() - Duration::from_millis(MAX_ELAPSED_MS + 10);
        state.operation_started = old;
        state.stage_started = old;
        state.cleanup_started = Some(old);
    }
    context.worker_observed(true, Some(12), u32::MAX, 0);
    context.end_cleanup();
    let diagnostic = context.diagnostic();
    assert_eq!(diagnostic["operationElapsedMs"], MAX_ELAPSED_MS);
    assert_eq!(diagnostic["cleanupElapsedMs"], MAX_ELAPSED_MS);
    assert_eq!(
        diagnostic["resourceObservation"]["sampleCount"],
        MAX_SAMPLES
    );
    assert_eq!(diagnostic["resourceObservation"]["sampleCountCapped"], true);
    assert_eq!(diagnostic["elapsedCapped"], true);
    assert!(valid_diagnostic(&diagnostic));
}

#[test]
fn projection_rejects_malformed_and_preserves_only_valid_diagnostic() {
    let mut metrics = json!({"existingCounter":7});
    let mut run = TaskRun::new(
        "prepare_ztools_source_dependencies",
        TaskRunInitiator::agent("fixture"),
        json!({}),
    );
    let mismatch = Context::new("different-run");
    run.metrics = metrics.clone();
    attach_to_run(&mut run, &mismatch);
    assert_eq!(run.metrics, metrics, "mismatched context must not attach");
    let context = Context::new(&run.id);
    attach_to_run(&mut run, &context);
    metrics = run.metrics.clone();
    assert_eq!(metrics["existingCounter"], 7);
    assert!(project_metrics(&metrics).is_some());
    assert!(project_cancelled_prepare(
        "prepare_ztools_source_dependencies",
        TaskRunStatus::Cancelled,
        &metrics
    )
    .is_some());
    assert!(project_cancelled_prepare(
        "prepare_ztools_source_dependencies",
        TaskRunStatus::Succeeded,
        &metrics
    )
    .is_none());
    assert!(project_cancelled_prepare(
        "fetch_ztools_source_dependencies",
        TaskRunStatus::Cancelled,
        &metrics
    )
    .is_none());
    assert!(project_cancelled_prepare(
        "prepare_ztools_source_dependencies",
        TaskRunStatus::Cancelled,
        &json!({})
    )
    .is_none());
    metrics["operationDiagnostic"]["secretPath"] = json!("/private/path");
    assert!(project_metrics(&metrics).is_none());
}

#[test]
fn worker_deadline_local_observation_is_not_projected_for_generic_failed_run() {
    let context = Context::new("run");
    context.set_stage(Stage::MaterializeWorker);
    context.deadline_observed();
    let mut failed = TaskRun::new(
        "prepare_ztools_source_dependencies",
        TaskRunInitiator::agent("fixture"),
        json!({}),
    );
    failed.transition(TaskRunStatus::Running).unwrap();
    failed.transition(TaskRunStatus::Failed).unwrap();
    assert_eq!(context.diagnostic()["cause"], "operation_deadline");
    assert!(failed.metrics.is_null());
    assert!(
        project_cancelled_prepare(&failed.capability_id, failed.status, &failed.metrics).is_none()
    );
}

#[test]
fn cancelled_run_metrics_survive_database_reopen_and_late_running_cas_loses() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "atools-b351-diagnostic-{}-{nonce}.sqlite",
        std::process::id()
    ));
    let mut run = TaskRun::new(
        "prepare_ztools_source_dependencies",
        TaskRunInitiator::agent("fixture"),
        json!({}),
    );
    run.transition(TaskRunStatus::Running).unwrap();
    {
        let db = Database::open(&path).unwrap();
        db.upsert_task_run(&run).unwrap();
    }
    let context = Context::new(&run.id);
    context.mark_cause(Cause::UserCancel);
    let db = Database::open(&path).unwrap();
    let mut terminal = db.get_task_run(&run.id).unwrap().unwrap();
    attach_to_run(&mut terminal, &context);
    terminal.transition(TaskRunStatus::Cancelled).unwrap();
    assert!(db.finish_running_task_run(&terminal).unwrap());
    let stored = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(stored.status, TaskRunStatus::Cancelled);
    assert_eq!(
        stored.metrics["operationDiagnostic"]["cause"],
        "user_cancel"
    );
    drop(db);
    let reopened = Database::open(&path).unwrap();
    let reopened_cancelled = reopened.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(reopened_cancelled.status, TaskRunStatus::Cancelled);
    assert_eq!(reopened_cancelled.metrics, stored.metrics);
    let mut late_success = run.clone();
    late_success.transition(TaskRunStatus::Succeeded).unwrap();
    assert!(!reopened.finish_running_task_run(&late_success).unwrap());
    assert_eq!(
        reopened.get_task_run(&run.id).unwrap().unwrap().metrics,
        stored.metrics
    );
    drop(reopened);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
}
