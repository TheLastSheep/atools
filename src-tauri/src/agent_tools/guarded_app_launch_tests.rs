use super::*;
use crate::renderer_app_state::{coordinate_launch, OpenFailure};
use atools_core::db::{RendererAppIdentity, RendererAppStateMutation, RendererDirectSubtype};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn db_with_trigger(sql: &str) -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sqlite");
    let db = Database::open(&path).unwrap();
    let result = std::process::Command::new("sqlite3")
        .arg(&path)
        .arg(sql)
        .output()
        .expect("sqlite3 test fixture required");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    (dir, db)
}
fn running(db: &Database) -> TaskRun {
    let mut run = new_task_run(
        "atools-ui",
        "open_or_reveal_path",
        json!({"path":"/A.app", "reveal":false}),
    );
    db.upsert_task_run(&run).unwrap();
    run.transition(TaskRunStatus::Running).unwrap();
    assert!(db.claim_task_run(&run).unwrap());
    run
}
#[tokio::test]
async fn guarded_audit_failure_after_effect_fails_actual_run_and_skips_history() {
    let (_dir, db) = db_with_trigger("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    let mut run = running(&db);
    let effects = AtomicUsize::new(0);
    let records = AtomicUsize::new(0);
    let result: Result<(), _> = coordinate_launch(
        || async {
            effects.fetch_add(1, Ordering::SeqCst);
            let entry = AuditLogEntry::new(
                "atools-ui",
                "open_or_reveal_path",
                json!({}),
                AuditStatus::Confirmed,
            );
            insert_audit(&db, &mut run, &entry, true, true)
                .map(|_| ())
                .map_err(|_| OpenFailure::Failed)
        },
        || async {
            records.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |_| {},
    )
    .await;
    assert!(result.is_err());
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    assert_eq!(records.load(Ordering::SeqCst), 0);
    let saved = db.get_task_run(&run.id).unwrap().unwrap();
    assert_eq!(saved.status, TaskRunStatus::Failed);
    assert!(saved.audit_id.is_none());
    assert!(saved
        .errors
        .iter()
        .any(|issue| issue.code == "audit_record_failed"));
}
#[tokio::test]
async fn actual_core_history_failure_after_effect_is_record_failure() {
    let (_dir, db) = db_with_trigger("CREATE TRIGGER reject_history BEFORE INSERT ON settings WHEN NEW.key='ztools-renderer:command-history' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    let effects = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&effects);
    let result = coordinate_launch(
        move || async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        || async {
            db.apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
                app: RendererAppIdentity {
                    path: "/A.app".into(),
                    name: "A".into(),
                    sub_type: RendererDirectSubtype::App,
                },
                now_ms: 1,
            })
            .map_err(|_| ())
        },
        |_| {},
    )
    .await;
    assert!(result.is_err());
    assert_eq!(effects.load(Ordering::SeqCst), 1);
}
