use super::{MutationRun, Outcome};
use atools_core::{
    db::Database,
    task_run::{TaskRunStatus, TaskValidationStatus},
};
use serde_json::json;
use std::sync::Arc;

fn database() -> Arc<Database> {
    Arc::new(Database::in_memory().expect("create isolated test database"))
}

#[test]
fn start_persists_human_running_run_with_only_plugin_and_operation_metadata() {
    let db = database();
    let run = MutationRun::start(db.clone(), "example-plugin", "install").unwrap();
    let id = run.id().to_owned();
    let saved = db.get_task_run(&id).unwrap().unwrap();

    assert_eq!(saved.status, TaskRunStatus::Running);
    assert_eq!(saved.capability_id, "atools-ui.plugin.install");
    assert_eq!(
        saved.initiator.kind,
        atools_core::task_run::TaskRunInitiatorType::Human
    );
    assert_eq!(saved.initiator.client_id.as_deref(), Some("atools-ui"));
    assert_eq!(
        saved.input,
        json!({ "pluginId": "example-plugin", "operation": "install" })
    );
    assert!(saved.started_at.is_some());
    drop(run);
}

#[test]
fn success_records_persistence_only_artifact_and_passed_validation() {
    let db = database();
    let run = MutationRun::start(db.clone(), "example-plugin", "update").unwrap();
    let id = run.id().to_owned();
    run.finish(Outcome::Success { changed: true }).unwrap();

    let saved = db.get_task_run(&id).unwrap().unwrap();
    assert_eq!(saved.status, TaskRunStatus::Succeeded);
    assert_eq!(saved.output["changed"], true);
    assert_eq!(saved.output["businessRuntimeVerified"], false);
    assert_eq!(saved.validation.status, TaskValidationStatus::Passed);
    assert_eq!(saved.artifacts.len(), 1);
    let artifact = &saved.artifacts[0];
    assert_eq!(artifact.kind, atools_core::task_run::ArtifactKind::Json);
    assert!(artifact.path.is_none());
    assert_eq!(artifact.metadata, saved.output);
    assert!(saved
        .summary
        .unwrap()
        .contains("business runtime not verified"));
}

#[test]
fn unchanged_mutation_is_cancelled_and_failure_persists_no_raw_error() {
    let db = database();
    let unchanged = MutationRun::start(db.clone(), "example-plugin", "enable").unwrap();
    let unchanged_id = unchanged.id().to_owned();
    unchanged
        .finish(Outcome::Success { changed: false })
        .unwrap();
    let unchanged_run = db.get_task_run(&unchanged_id).unwrap().unwrap();
    assert_eq!(unchanged_run.status, TaskRunStatus::Cancelled);
    assert_eq!(unchanged_run.output, json!({ "changed": false }));

    let failed = MutationRun::start(db.clone(), "example-plugin", "uninstall").unwrap();
    let failed_id = failed.id().to_owned();
    failed.finish(Outcome::Failure).unwrap();
    let failed_run = db.get_task_run(&failed_id).unwrap().unwrap();
    assert_eq!(failed_run.status, TaskRunStatus::Failed);
    assert_eq!(failed_run.errors.len(), 1);
    assert_eq!(failed_run.errors[0].message, "Plugin mutation failed");
    assert_eq!(failed_run.input["pluginId"], "example-plugin");
    assert!(failed_run.input.get("error").is_none());
}

#[test]
fn dropping_active_run_fails_it_and_first_terminal_state_wins() {
    let db = database();
    let interrupted = MutationRun::start(db.clone(), "interrupted-plugin", "import").unwrap();
    let interrupted_id = interrupted.id().to_owned();
    drop(interrupted);
    let interrupted_run = db.get_task_run(&interrupted_id).unwrap().unwrap();
    assert_eq!(interrupted_run.status, TaskRunStatus::Failed);
    assert_eq!(
        interrupted_run.errors[0].message,
        "Plugin mutation was interrupted"
    );

    for terminal in [TaskRunStatus::Cancelled, TaskRunStatus::Succeeded] {
        let run = MutationRun::start(db.clone(), "terminal-plugin", "update").unwrap();
        let id = run.id().to_owned();
        let mut earlier = db.get_task_run(&id).unwrap().unwrap();
        earlier.transition(terminal).unwrap();
        assert!(db.finish_running_task_run(&earlier).unwrap());

        run.finish(Outcome::Failure).unwrap();
        assert_eq!(db.get_task_run(&id).unwrap().unwrap().status, terminal);
    }
}

#[test]
fn rejects_unbounded_or_unknown_metadata() {
    let db = database();
    assert!(MutationRun::start(db.clone(), "plugin", "../../secret").is_err());
    assert!(MutationRun::start(db, "plugin\npath", "install").is_err());
}
