use atools_core::task_run::{
    Artifact, ArtifactKind, TaskRun, TaskRunInitiator, TaskRunStatus, TaskValidationStatus,
};
use atools_core::Database;
use serde_json::json;

#[test]
fn task_run_lifecycle_round_trips_through_database() {
    let db = Database::in_memory().expect("database");
    let mut run = TaskRun::new(
        "find_local_files",
        TaskRunInitiator::agent("mcp-http"),
        json!({ "query": "report" }),
    );
    assert_eq!(run.status, TaskRunStatus::Created);

    run.transition(TaskRunStatus::Running)
        .expect("start task run");
    run.output = json!({ "items": [{ "path": "/tmp/report.md" }] });
    run.summary = Some("find_local_files completed with 1 result item(s)".to_string());
    run.metrics = json!({ "durationMs": 12 });
    run.validation.status = TaskValidationStatus::Passed;
    run.artifacts.push(Artifact {
        id: "artifact-1".to_string(),
        kind: ArtifactKind::Json,
        label: "Structured result".to_string(),
        media_type: Some("application/json".to_string()),
        uri: Some(format!("atools://task-runs/{}/output", run.id)),
        path: None,
        size_bytes: None,
        metadata: json!({}),
    });
    run.transition(TaskRunStatus::Succeeded)
        .expect("finish task run");
    db.upsert_task_run(&run).expect("insert task run");

    let restored = db
        .get_task_run(&run.id)
        .expect("read task run")
        .expect("task run exists");
    assert_eq!(restored.id, run.id);
    assert_eq!(restored.status, TaskRunStatus::Succeeded);
    assert_eq!(restored.initiator.client_id.as_deref(), Some("mcp-http"));
    assert_eq!(restored.progress, Some(100));
    assert_eq!(restored.artifacts.len(), 1);
    assert_eq!(restored.metrics["durationMs"], 12);
    assert!(restored.started_at.is_some());
    assert!(restored.finished_at.is_some());

    let listed = db.list_task_runs(10).expect("list task runs");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, run.id);
}

#[test]
fn task_run_rejects_illegal_terminal_transitions() {
    let mut run = TaskRun::new(
        "find_local_files",
        TaskRunInitiator::agent("mcp-http"),
        json!({}),
    );
    run.transition(TaskRunStatus::Running).expect("start");
    run.transition(TaskRunStatus::Succeeded).expect("finish");
    let finished_at = run.finished_at.clone();
    let updated_at = run.updated_at.clone();

    let error = run
        .transition(TaskRunStatus::Running)
        .expect_err("succeeded task must stay terminal");
    assert_eq!(error.from, TaskRunStatus::Succeeded);
    assert_eq!(error.to, TaskRunStatus::Running);
    assert_eq!(run.status, TaskRunStatus::Succeeded);
    assert_eq!(run.finished_at, finished_at);
    assert_eq!(run.updated_at, updated_at);
}

#[test]
fn partial_and_failed_runs_can_reenter_running_for_retry() {
    for terminal in [TaskRunStatus::Partial, TaskRunStatus::Failed] {
        let mut run = TaskRun::new(
            "compress_images",
            TaskRunInitiator::human(Some("atools-ui".to_string())),
            json!({}),
        );
        run.transition(TaskRunStatus::Running).expect("start");
        run.transition(terminal).expect("finish retryable run");
        run.transition(TaskRunStatus::Running).expect("retry");
        assert_eq!(run.status, TaskRunStatus::Running);
        assert!(run.finished_at.is_none());
        assert_eq!(run.progress, Some(0));
    }
}

#[test]
fn task_run_json_uses_the_public_camel_case_contract() {
    let run = TaskRun::new(
        "search_clipboard",
        TaskRunInitiator::human(Some("atools-ui".to_string())),
        json!({}),
    );
    let value = serde_json::to_value(run).expect("serialize task run");

    assert_eq!(value["capabilityId"], "search_clipboard");
    assert_eq!(value["initiator"]["type"], "human");
    assert_eq!(value["initiator"]["clientId"], "atools-ui");
    assert_eq!(value["status"], "created");
    assert!(value.get("memoryIds").is_some());
    assert!(value.get("createdAt").is_some());
}
