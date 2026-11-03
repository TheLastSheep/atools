use super::*;
use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
use std::time::Instant;

fn prepared(status: TaskRunStatus) -> (Database, Runtime, Request, String, tempfile::TempDir) {
    let (db, p, root) = setup();
    let name = registry::ensure(&db, &p).unwrap();
    let mut r = request(Operation::Prepare);
    r.identity.plugin_id = p.id;
    let runtime = Runtime::default();
    let intent = runtime.begin("main".into(), r.clone()).unwrap();
    let mut run = TaskRun::new(
        name,
        TaskRunInitiator::human(Some("atools-ui".into())),
        serde_json::to_value(&r).unwrap(),
    );
    run.transition(TaskRunStatus::Running).unwrap();
    if status != TaskRunStatus::Running {
        run.transition(status).unwrap();
    }
    run.output = json!({"outcome":"ready","runtime":"plugin-main-push"});
    db.upsert_task_run(&run).unwrap();
    intent.state.lock().run = Some(run.id.clone());
    runtime.ready(&intent).unwrap();
    runtime.remove(&r.request_id, None);
    intent.close();
    (db, runtime, r, run.id, root)
}
#[test]
fn main_push_runner_consent_requires_successful_prepare_and_never_creates_persistent_grants() {
    for status in [
        TaskRunStatus::Running,
        TaskRunStatus::Failed,
        TaskRunStatus::Cancelled,
        TaskRunStatus::Succeeded,
    ] {
        let (db, runtime, prepare, _, _root) = prepared(status);
        let mut q = prepare.clone();
        q.operation = Operation::Query;
        assert_eq!(
            super::super::admission::confirmation(&runtime, &db, "main", &q).is_ok(),
            status == TaskRunStatus::Succeeded
        );
        q.operation = Operation::Select;
        q.identity.command_type = CommandType::Regex; // Same declared feature can match a different command kind.
        assert_eq!(
            super::super::admission::confirmation(&runtime, &db, "main", &q).is_ok(),
            status == TaskRunStatus::Succeeded
        );
        assert!(db.list_agent_tool_grants().unwrap().is_empty());
    }
}
#[test]
fn main_push_ready_consent_does_not_hide_current_shared_permission_denial() {
    let (db, runtime, prepare, _, _root) = prepared(TaskRunStatus::Succeeded);
    let mut q = prepare.clone();
    q.operation = Operation::Query;
    let name = registry::tool_name(&prepare.identity.plugin_id);
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &name).unwrap(),
        atools_core::agent::PermissionDecision::Confirm
    );
    assert!(super::super::admission::confirmation(&runtime, &db, "main", &q).unwrap());
    let mut tool = db.get_agent_tool(&name).unwrap().unwrap();
    tool.enabled = false;
    db.sync_agent_tools(&[tool]).unwrap();
    // sync preserves enabled preferences; explicitly use the actual settings API.
    db.set_agent_tool_enabled(&name, false).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &name).unwrap(),
        atools_core::agent::PermissionDecision::Deny
    );
}
#[test]
fn main_push_prepared_runner_rejects_wrong_window_owner_revision_and_expired_or_closed_consent() {
    let (db, runtime, prepare, _, _root) = prepared(TaskRunStatus::Succeeded);
    let mut q = prepare.clone();
    q.operation = Operation::Query;
    assert!(super::super::admission::confirmation(&runtime, &db, "other", &q).is_err());
    for mutation in 0..3 {
        let mut foreign = q.clone();
        match mutation {
            0 => foreign.identity.plugin_id = "other".into(),
            1 => foreign.identity.code_revision = "b".repeat(64),
            _ => foreign.runner_id = uuid::Uuid::new_v4().to_string(),
        };
        assert!(super::super::admission::confirmation(&runtime, &db, "main", &foreign).is_err());
    }
    runtime
        .0
        .lock()
        .admissions
        .get_mut(&("main".into(), q.runner_id.clone()))
        .unwrap()
        .used = Instant::now() - super::super::admission::TTL;
    assert!(super::super::admission::confirmation(&runtime, &db, "main", &q).is_err());
    let closed = runtime.close(Some("main"), None, Some(&q.runner_id), false);
    assert_eq!(closed.prepares.len(), 1);
    assert!(super::super::admission::confirmation(&runtime, &db, "main", &q).is_err());
}
#[test]
fn main_push_query_supersede_keeps_runner_but_code_or_window_invalidation_drains_it() {
    let (db, runtime, prepare, _, _root) = prepared(TaskRunStatus::Succeeded);
    let mut q = prepare.clone();
    q.operation = Operation::Query;
    q.request_id = uuid::Uuid::new_v4().to_string();
    runtime.begin("main".into(), q.clone()).unwrap();
    runtime.remove(&q.request_id, Some("main")).unwrap().close();
    assert!(super::super::admission::confirmation(&runtime, &db, "main", &q).unwrap());
    assert_eq!(
        runtime.preparation_runner("main", &prepare.request_id),
        Some(prepare.runner_id.clone())
    );
    assert!(runtime
        .preparation_runner("foreign", &prepare.request_id)
        .is_none());
    let closed = runtime.close(None, Some(&prepare.identity.plugin_id), None, false);
    assert_eq!(closed.prepares.len(), 1);
    assert!(super::super::admission::confirmation(&runtime, &db, "main", &q).is_err());
}
#[test]
fn main_push_prepared_runner_count_remains_bounded_when_no_callback_is_pending() {
    let (db, runtime, prepare, _, _root) = prepared(TaskRunStatus::Succeeded);
    let mut second = request(Operation::Prepare);
    second.identity = prepare.identity.clone();
    let intent = runtime.begin("main".into(), second.clone()).unwrap();
    intent.state.lock().run = Some("other-run".into());
    runtime.ready(&intent).unwrap();
    runtime.remove(&second.request_id, None);
    intent.close();
    assert!(runtime
        .begin("main".into(), request(Operation::Prepare))
        .is_err());
    assert_eq!(runtime.0.lock().admissions.len(), 2);
    runtime.close(Some("main"), None, None, false);
    assert!(db.list_agent_tool_grants().unwrap().is_empty());
}

#[test]
fn main_push_failed_select_revokes_its_prepared_runner_and_closes_other_pending_intents() {
    let (db, runtime, prepare, _, _root) = prepared(TaskRunStatus::Succeeded);
    let mut select = prepare.clone();
    select.request_id = uuid::Uuid::new_v4().to_string();
    select.operation = Operation::Select;
    let selection = runtime.begin("main".into(), select.clone()).unwrap();
    let mut query = select.clone();
    query.request_id = uuid::Uuid::new_v4().to_string();
    query.operation = Operation::Query;
    runtime.begin("main".into(), query.clone()).unwrap();
    let closed = runtime.finish(&selection, false);
    assert_eq!(closed.prepares.len(), 1);
    assert_eq!(closed.intents.len(), 1);
    assert_eq!(closed.intents[0].request.request_id, query.request_id);
    assert!(super::super::admission::confirmation(&runtime, &db, "main", &select).is_err());
    assert!(runtime.get(&query.request_id).is_err());
}

#[test]
fn main_push_successful_select_and_failed_query_keep_prepared_runner_consent() {
    let (db, runtime, prepare, _, _root) = prepared(TaskRunStatus::Succeeded);
    for (operation, success) in [(Operation::Select, true), (Operation::Query, false)] {
        let mut call = prepare.clone();
        call.request_id = uuid::Uuid::new_v4().to_string();
        call.operation = operation;
        let intent = runtime.begin("main".into(), call.clone()).unwrap();
        let closed = runtime.finish(&intent, success);
        assert!(closed.prepares.is_empty());
        assert!(closed.intents.is_empty());
        assert!(super::super::admission::confirmation(&runtime, &db, "main", &call).unwrap());
    }
}

#[test]
fn main_push_late_failed_select_cannot_close_a_new_preparation_reusing_runner_and_request_ids() {
    let (db, runtime, prepare, old_run, _root) = prepared(TaskRunStatus::Succeeded);
    let mut select = prepare.clone();
    select.request_id = uuid::Uuid::new_v4().to_string();
    select.operation = Operation::Select;
    let old_select = runtime.begin("main".into(), select.clone()).unwrap();
    let closed = runtime.close(Some("main"), None, Some(&prepare.runner_id), false);
    assert_eq!(closed.prepares, vec![old_run]);
    for intent in closed.intents {
        intent.close();
    }

    let mut fresh = prepare.clone();
    fresh.request_id = uuid::Uuid::new_v4().to_string();
    let prepared = runtime.begin("main".into(), fresh.clone()).unwrap();
    let mut run = TaskRun::new(
        registry::tool_name(&fresh.identity.plugin_id),
        TaskRunInitiator::human(Some("atools-ui".into())),
        serde_json::to_value(&fresh).unwrap(),
    );
    run.transition(TaskRunStatus::Running).unwrap();
    run.transition(TaskRunStatus::Succeeded).unwrap();
    run.output = json!({"outcome":"ready","runtime":"plugin-main-push"});
    db.upsert_task_run(&run).unwrap();
    prepared.state.lock().run = Some(run.id.clone());
    runtime.ready(&prepared).unwrap();
    runtime.finish(&prepared, true);
    prepared.close();
    let replacement = runtime.begin("main".into(), select.clone()).unwrap();

    let stale_cleanup = runtime.finish(&old_select, false);
    assert!(stale_cleanup.prepares.is_empty());
    assert!(stale_cleanup.intents.is_empty());
    assert!(std::sync::Arc::ptr_eq(
        &runtime.get(&select.request_id).unwrap(),
        &replacement
    ));
    assert!(super::super::admission::confirmation(&runtime, &db, "main", &select).unwrap());
}
