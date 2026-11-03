use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
};

#[test]
fn clipboard_precreation_rejects_private_arguments_before_a_created_run_can_be_saved() {
    let db = Database::in_memory().unwrap();
    let tool = crate::launcher_media_clipboard::tool_definition();
    db.sync_agent_tools(&[tool.clone()]).unwrap();
    for input in [
        json!({"filesOnly":true,"raw":"PRIVATE_CLIPBOARD_PATH"}),
        json!({"filesOnly":"PRIVATE_CLIPBOARD_PATH"}),
        json!(["PRIVATE_CLIPBOARD_PATH"]),
    ] {
        let mut run = new_task_run("background-client", &tool.name, input);
        let error = crate::agent_tools::initialize_new_task_run(&db, &mut run)
            .expect_err("the shared background precreation boundary must reject private arguments");
        assert!(!error.contains("PRIVATE_CLIPBOARD_PATH"));
        assert!(db.get_task_run(&run.id).unwrap().is_none());
    }
}

#[test]
fn clipboard_precreation_retains_explicit_schema_input_and_never_adopts_private_defaults() {
    let db = Database::in_memory().unwrap();
    let tool = crate::launcher_media_clipboard::tool_definition();
    db.sync_agent_tools(&[tool.clone()]).unwrap();
    preference(
        &db,
        &tool.name,
        json!({"params":{"raw":"PRIVATE_DEFAULT","filesOnly":false}}),
    );
    let mut run = new_task_run("background-client", &tool.name, json!({"filesOnly":true}));
    crate::agent_tools::initialize_new_task_run(&db, &mut run).unwrap();
    assert_eq!(run.input, json!({"filesOnly":true}));
    assert!(run.memory_ids.is_empty());
}
use std::thread;

fn pending(db: &Database) -> TaskRun {
    let run = new_task_run("client", "fixture", json!({"value":1}));
    db.upsert_task_run(&run).unwrap();
    run
}

fn preference(db: &Database, tool: &str, arguments: Value) -> String {
    use atools_core::memory::{MemoryApproval, MemoryItem, MemoryScope, MemoryType};
    let item = MemoryItem::new(
        MemoryType::Preference,
        MemoryScope {
            tool: Some(tool.into()),
            ..MemoryScope::default()
        },
        json!({"arguments":arguments}),
        None,
        1.0,
        MemoryApproval::Explicit,
        None,
    )
    .unwrap();
    db.upsert_memory_item(&item).unwrap();
    item.id
}

#[test]
fn background_precreation_uses_verified_defaults_and_retains_explicit_input_and_memory_ids() {
    let db = Database::in_memory().unwrap();
    let id = preference(
        &db,
        "compress_images",
        json!({"quality":82,"format":"webp"}),
    );
    let mut run = new_task_run(
        "client",
        "compress_images",
        json!({"quality":95,"paths":["photo.png"]}),
    );
    super::super::initialize_new_task_run(&db, &mut run).unwrap();
    assert_eq!(
        run.input,
        json!({"quality":95,"format":"webp","paths":["photo.png"]})
    );
    assert_eq!(run.memory_ids, vec![id]);
    persist_new(&db, &run).unwrap();
    let selected = select_run(&db, Some(&run.id), "client", "compress_images", &run.input).unwrap();
    assert!(
        !selected.is_new,
        "dispatch must use initialized input, not create a second task"
    );
    assert_eq!(selected.run.input, run.input);
    assert_eq!(selected.run.memory_ids, run.memory_ids);
}

#[test]
fn resuming_approval_preserves_the_input_already_shown_to_the_user() {
    let db = Database::in_memory().unwrap();
    let mut run = pending(&db);
    run.transition(TaskRunStatus::AwaitingPermission).unwrap();
    persist_pending(&db, &run).unwrap();
    preference(&db, "fixture", json!({"newDefault":"must not appear"}));
    let mut selected = select_run(&db, Some(&run.id), "client", "fixture", &run.input).unwrap();
    assert!(!selected.is_new);
    apply_new_run_memory(&db, &mut selected.run);
    assert_eq!(selected.run.input, run.input);
    assert!(selected.run.memory_ids.is_empty());
}

#[test]
fn private_transports_never_adopt_user_parameter_defaults() {
    use atools_core::agent::ToolDefinition;
    for (name, source) in [
        (
            "legacy_node_fixture",
            crate::legacy_runtime::registry::SOURCE,
        ),
        (
            "host_clipboard_fixture",
            crate::host_runtime::registry::SOURCE,
        ),
        (
            "plugin_data_fixture",
            crate::plugin_data_runtime::registry::SOURCE,
        ),
        (
            "plugin_paths_fixture",
            crate::plugin_system_paths::registry::SOURCE,
        ),
        (
            "plugin_dialog_fixture",
            crate::plugin_dialog_runtime::registry::SOURCE,
        ),
        (
            "launcher_clipboard_fixture",
            crate::launcher_media_clipboard::SOURCE,
        ),
    ] {
        let db = Database::in_memory().unwrap();
        db.sync_agent_tools(&[ToolDefinition {
            name: name.into(),
            description: "private transport".into(),
            input_schema: json!({}),
            output_schema: None,
            scopes: vec![],
            enabled_by_default: true,
            enabled: true,
            source: source.into(),
            plugin_id: Some("fixture".into()),
        }])
        .unwrap();
        preference(
            &db,
            name,
            json!({"params":{"privateValue":"must stay out of history"}}),
        );
        let mut run = new_task_run("client", name, json!({"operation":"open"}));
        apply_new_run_memory(&db, &mut run);
        assert_eq!(run.input, json!({"operation":"open"}));
        assert!(run.memory_ids.is_empty());
    }
}

#[test]
fn expired_background_dispatch_fails_only_its_unchanged_created_run() {
    let db = Database::in_memory().unwrap();
    let run = pending(&db);
    assert!(fail_created_dispatch(
        &db,
        &run.id,
        "other-client",
        "fixture",
        &run.input,
        "expired"
    )
    .is_none());
    assert!(fail_created_dispatch(
        &db,
        &run.id,
        "client",
        "fixture",
        &json!({"changed":true}),
        "expired"
    )
    .is_none());
    let result = fail_created_dispatch(
        &db,
        &run.id,
        "client",
        "fixture",
        &run.input,
        "private ticket expired",
    )
    .unwrap();
    assert!(result.is_error);
    let failed = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(failed.status, TaskRunStatus::Failed);
    assert_eq!(failed.errors[0].code, "dispatch_rejected");
    assert_eq!(failed.validation.status, TaskValidationStatus::Failed);
    for status in [
        TaskRunStatus::AwaitingPermission,
        TaskRunStatus::Running,
        TaskRunStatus::Succeeded,
    ] {
        let mut other = new_task_run("client", "fixture", run.input.clone());
        if status == TaskRunStatus::Succeeded {
            other.transition(TaskRunStatus::Running).unwrap();
        }
        other.transition(status).unwrap();
        db.upsert_task_run(&other).unwrap();
        assert!(fail_created_dispatch(
            &db,
            &other.id,
            "client",
            "fixture",
            &other.input,
            "expired"
        )
        .is_none());
        assert_eq!(db.get_task_run(&other.id).unwrap().unwrap().status, status);
    }
}

#[test]
fn explicit_running_missing_or_mismatched_ids_never_fall_back_to_new_runs() {
    let db = Database::in_memory().unwrap();
    let mut run = pending(&db);
    run.transition(TaskRunStatus::Running).unwrap();
    db.upsert_task_run(&run).unwrap();
    for (id, client, tool, input) in [
        (run.id.as_str(), "client", "fixture", json!({"value":1})),
        (
            run.id.as_str(),
            "other-client",
            "fixture",
            json!({"value":1}),
        ),
        (run.id.as_str(), "client", "other-tool", json!({"value":1})),
        (run.id.as_str(), "client", "fixture", json!({"value":2})),
        ("run-missing", "client", "fixture", json!({"value":1})),
    ] {
        assert!(select_run(&db, Some(id), client, tool, &input).is_err());
        assert_eq!(db.list_task_runs(10).unwrap().len(), 1);
        assert_eq!(
            db.get_task_run(&run.id).unwrap().unwrap().status,
            TaskRunStatus::Running
        );
    }
}

#[test]
fn terminal_run_ids_are_rejected_without_implicit_retry_creation() {
    let db = Database::in_memory().unwrap();
    let mut ids = Vec::new();
    for status in [
        TaskRunStatus::Partial,
        TaskRunStatus::Succeeded,
        TaskRunStatus::Failed,
        TaskRunStatus::Cancelled,
    ] {
        let mut run = pending(&db);
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(status).unwrap();
        db.upsert_task_run(&run).unwrap();
        ids.push(run.id);
    }

    for id in &ids {
        let run = db.get_task_run(id).unwrap().unwrap();
        let rejected = match select_run(&db, Some(id), "client", "fixture", &run.input) {
            Ok(_) => panic!("terminal run IDs must not trigger retries"),
            Err(error) => error,
        };
        assert_eq!(
            rejected.structured_content["errorCode"],
            "TASK_RUN_RESUME_REJECTED"
        );
    }
    assert_eq!(db.list_task_runs(10).unwrap().len(), ids.len());
}

#[test]
fn stale_pending_failures_and_confirmation_updates_preserve_an_executor_winner() {
    let db = Database::in_memory().unwrap();
    let run = pending(&db);
    let mut winner = run.clone();
    winner.transition(TaskRunStatus::Running).unwrap();
    claim(&db, &winner).unwrap();
    let mut stale = run.clone();
    stale.transition(TaskRunStatus::AwaitingPermission).unwrap();
    let conflict = persist_pending(&db, &stale).unwrap_err();
    assert_eq!(conflict.structured_content["status"], "running");
    assert!(fail_before_execution(&db, &mut stale, "tool removed", 1).is_error);
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().status,
        TaskRunStatus::Running
    );
}

#[test]
fn concurrent_confirmed_selections_cross_the_execution_boundary_once() {
    let db = Database::in_memory().unwrap();
    let mut run = pending(&db);
    run.transition(TaskRunStatus::AwaitingPermission).unwrap();
    db.upsert_task_run(&run).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let executed = Arc::new(AtomicUsize::new(0));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let db = db.clone();
            let barrier = barrier.clone();
            let executed = executed.clone();
            let run = run.clone();
            thread::spawn(move || {
                let mut selected = select_run(&db, Some(&run.id), "client", "fixture", &run.input)
                    .unwrap()
                    .run;
                selected.transition(TaskRunStatus::Running).unwrap();
                barrier.wait();
                if claim(&db, &selected).is_ok() {
                    executed.fetch_add(1, Ordering::SeqCst);
                }
            })
        })
        .collect();
    barrier.wait();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(executed.load(Ordering::SeqCst), 1);
}
