use std::sync::{Arc, Barrier};
use std::thread;

use atools_core::db::Database;
use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
use serde_json::json;

fn pending() -> TaskRun {
    TaskRun::new(
        "plugin.fixture.execute",
        TaskRunInitiator::agent("test-client"),
        json!({"file":"test.txt","options":{"format":"json"}}),
    )
}

#[test]
fn terminal_completion_and_cancellation_have_one_winner_and_cannot_reopen() {
    let db = Database::in_memory().unwrap();
    let pending = pending();
    db.upsert_task_run(&pending).unwrap();
    let active = running(&pending, "executor");
    assert!(db.claim_task_run(&active).unwrap());
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = [TaskRunStatus::Succeeded, TaskRunStatus::Cancelled]
        .into_iter()
        .map(|status| {
            let db = db.clone();
            let barrier = barrier.clone();
            let mut run = active.clone();
            run.transition(status).unwrap();
            thread::spawn(move || {
                barrier.wait();
                (db.finish_running_task_run(&run).unwrap(), run)
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|(won, _)| *won).count(), 1);
    let winner = &results.iter().find(|(won, _)| *won).unwrap().1;
    assert_same(&db, winner);
    for (_, loser) in results.iter() {
        assert!(!db.finish_running_task_run(loser).unwrap());
    }
    assert!(!db.claim_task_run(&active).unwrap());
    assert_same(&db, winner);
}

#[test]
fn terminal_finish_refuses_pending_and_mismatched_running_tasks_without_writes() {
    let db = Database::in_memory().unwrap();
    let pending = pending();
    db.upsert_task_run(&pending).unwrap();
    let active = running(&pending, "executor");
    let mut done = active.clone();
    done.transition(TaskRunStatus::Succeeded).unwrap();
    assert!(!db.finish_running_task_run(&done).unwrap());
    assert_same(&db, &pending);
    assert!(db.claim_task_run(&active).unwrap());
    let mut wrong = done.clone();
    wrong.input = json!({"other":true});
    assert!(!db.finish_running_task_run(&wrong).unwrap());
    assert!(!db.finish_running_task_run(&active).unwrap());
    assert_same(&db, &active);
    assert!(db.finish_running_task_run(&done).unwrap());
}

fn running(run: &TaskRun, owner: &str) -> TaskRun {
    let mut proposed = run.clone();
    proposed.transition(TaskRunStatus::Running).unwrap();
    proposed.summary = Some(owner.to_string());
    proposed.metrics = json!({"owner":owner});
    proposed
}

fn assert_same(db: &Database, expected: &TaskRun) {
    assert_eq!(
        serde_json::to_value(db.get_task_run(&expected.id).unwrap().unwrap()).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn claims_created_or_awaiting_runs_and_persists_the_complete_proposed_state() {
    for awaiting in [false, true] {
        let db = Database::in_memory().unwrap();
        let mut run = pending();
        if awaiting {
            run.transition(TaskRunStatus::AwaitingPermission).unwrap();
        }
        db.upsert_task_run(&run).unwrap();
        let mut proposed = running(&run, "winner");
        proposed.output = json!({"retained":"complete-running-state"});
        proposed.audit_id = Some("audit-claim".into());
        proposed.retry_of = Some("run-original".into());
        proposed.memory_ids = vec!["memory-verified".into()];
        assert!(db.claim_task_run(&proposed).unwrap());
        assert_same(&db, &proposed);
        assert!(!db.claim_task_run(&running(&run, "loser")).unwrap());
        assert_same(&db, &proposed);
    }
}

#[test]
fn rejects_missing_nonrunning_or_mismatched_identity_and_arguments_without_writes() {
    let db = Database::in_memory().unwrap();
    let run = pending();
    assert!(!db.claim_task_run(&running(&run, "missing")).unwrap());
    assert!(db.get_task_run(&run.id).unwrap().is_none());
    db.upsert_task_run(&run).unwrap();
    assert!(!db.claim_task_run(&run).unwrap());
    let proposed = running(&run, "invalid");
    let mut client = proposed.clone();
    client.initiator.client_id = Some("other-client".into());
    let mut kind = proposed.clone();
    kind.initiator = TaskRunInitiator::human(Some("test-client".into()));
    let mut capability = proposed.clone();
    capability.capability_id = "plugin.other.execute".into();
    let mut input = proposed.clone();
    input.input["file"] = json!("other.txt");
    let mut id = proposed.clone();
    id.id = "run-does-not-exist".into();
    for candidate in [client, kind, capability, input, id] {
        assert!(!db.claim_task_run(&candidate).unwrap());
        assert_same(&db, &run);
    }
}

#[test]
fn rejects_running_and_every_terminal_state_without_reopening_them() {
    for status in [
        TaskRunStatus::Running,
        TaskRunStatus::Partial,
        TaskRunStatus::Succeeded,
        TaskRunStatus::Failed,
        TaskRunStatus::Cancelled,
    ] {
        let db = Database::in_memory().unwrap();
        let run = pending();
        let proposed = running(&run, "new-executor");
        let mut existing = running(&run, "original-executor");
        if status != TaskRunStatus::Running {
            existing.transition(status).unwrap();
        }
        db.upsert_task_run(&existing).unwrap();
        assert!(!db.claim_task_run(&proposed).unwrap());
        assert_same(&db, &existing);
    }
}

#[test]
fn concurrent_claims_on_one_database_handle_have_exactly_one_winner() {
    let db = Database::in_memory().unwrap();
    let run = pending();
    db.upsert_task_run(&run).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|owner| {
            let database = db.clone();
            let barrier = barrier.clone();
            let proposed = running(&run, owner);
            thread::spawn(move || {
                barrier.wait();
                (database.claim_task_run(&proposed).unwrap(), proposed)
            })
        })
        .collect();
    barrier.wait();
    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(outcomes.iter().filter(|(claimed, _)| *claimed).count(), 1);
    assert_same(
        &db,
        &outcomes
            .into_iter()
            .find(|(claimed, _)| *claimed)
            .unwrap()
            .1,
    );
}

#[test]
fn independent_connections_to_the_same_database_cannot_claim_twice() {
    let temp = tempfile::tempdir().unwrap();
    let database_path = temp.path().join("claims.db");
    let db = Database::open(&database_path).unwrap();
    let run = pending();
    db.upsert_task_run(&run).unwrap();
    let connections = [
        Database::open(&database_path).unwrap(),
        Database::open(&database_path).unwrap(),
    ];
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = connections
        .into_iter()
        .enumerate()
        .map(|(index, database)| {
            let barrier = barrier.clone();
            let proposed = running(&run, &format!("connection-{index}"));
            thread::spawn(move || {
                barrier.wait();
                (database.claim_task_run(&proposed).unwrap(), proposed)
            })
        })
        .collect();
    barrier.wait();
    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(outcomes.iter().filter(|(claimed, _)| *claimed).count(), 1);
    assert_same(
        &db,
        &outcomes
            .into_iter()
            .find(|(claimed, _)| *claimed)
            .unwrap()
            .1,
    );
}

#[test]
fn pending_updates_cannot_overwrite_a_claimed_executor_or_change_identity() {
    let db = Database::in_memory().unwrap();
    let run = pending();
    db.upsert_task_run(&run).unwrap();
    let mut awaiting = run.clone();
    awaiting
        .transition(TaskRunStatus::AwaitingPermission)
        .unwrap();
    assert!(db.update_pending_task_run(&awaiting).unwrap());
    let mut wrong_input = awaiting.clone();
    wrong_input.input = json!({"wrong":true});
    assert!(!db.update_pending_task_run(&wrong_input).unwrap());
    let claimed = running(&awaiting, "winner");
    assert!(db.claim_task_run(&claimed).unwrap());
    let mut cancelled = awaiting.clone();
    cancelled.transition(TaskRunStatus::Cancelled).unwrap();
    assert!(!db.update_pending_task_run(&cancelled).unwrap());
    assert!(!db.update_pending_task_run(&awaiting).unwrap());
    assert!(!db.update_pending_task_run(&claimed).unwrap());
    assert_same(&db, &claimed);
}

#[test]
fn pending_cancellation_and_execution_claim_race_have_only_one_winner() {
    let db = Database::in_memory().unwrap();
    let run = pending();
    db.upsert_task_run(&run).unwrap();
    let mut cancelled = run.clone();
    cancelled.transition(TaskRunStatus::Cancelled).unwrap();
    let claimed = running(&run, "executor");
    let barrier = Arc::new(Barrier::new(3));
    let updater_db = db.clone();
    let updater_barrier = barrier.clone();
    let expected_cancelled = cancelled.clone();
    let updater = thread::spawn(move || {
        updater_barrier.wait();
        updater_db.update_pending_task_run(&cancelled).unwrap()
    });
    let executor_db = db.clone();
    let executor_barrier = barrier.clone();
    let expected_claimed = claimed.clone();
    let executor = thread::spawn(move || {
        executor_barrier.wait();
        executor_db.claim_task_run(&claimed).unwrap()
    });
    barrier.wait();
    let cancelled = updater.join().unwrap();
    let claimed = executor.join().unwrap();
    assert_ne!(cancelled, claimed);
    assert_same(
        &db,
        if claimed {
            &expected_claimed
        } else {
            &expected_cancelled
        },
    );
}

#[test]
fn created_dispatch_failure_races_permission_or_execution_without_overwriting_the_winner() {
    for awaiting in [false, true] {
        let db = Database::in_memory().unwrap();
        let run = pending();
        db.upsert_task_run(&run).unwrap();
        let mut failed = run.clone();
        failed.transition(TaskRunStatus::Failed).unwrap();
        let mut progressed = run.clone();
        progressed
            .transition(if awaiting {
                TaskRunStatus::AwaitingPermission
            } else {
                TaskRunStatus::Running
            })
            .unwrap();
        let expected_failed = failed.clone();
        let expected_progressed = progressed.clone();
        let barrier = Arc::new(Barrier::new(3));
        let failure_db = db.clone();
        let failure_barrier = barrier.clone();
        let failure = thread::spawn(move || {
            failure_barrier.wait();
            failure_db.fail_created_task_run(&failed).unwrap()
        });
        let progress_db = db.clone();
        let progress_barrier = barrier.clone();
        let progress = thread::spawn(move || {
            progress_barrier.wait();
            if awaiting {
                progress_db.update_pending_task_run(&progressed).unwrap()
            } else {
                progress_db.claim_task_run(&progressed).unwrap()
            }
        });
        barrier.wait();
        let failed_won = failure.join().unwrap();
        let progressed_won = progress.join().unwrap();
        assert_ne!(failed_won, progressed_won);
        assert_same(
            &db,
            if failed_won {
                &expected_failed
            } else {
                &expected_progressed
            },
        );
        if progressed_won {
            assert!(!db.fail_created_task_run(&expected_failed).unwrap());
        }
    }
}
