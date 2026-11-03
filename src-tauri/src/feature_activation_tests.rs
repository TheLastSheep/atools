use super::*;
use atools_core::Plugin;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn plugin(id: &str) -> Plugin {
    Plugin { id:id.into(), name:id.into(), enabled:true, version:"1".into(), path:"/never-executed".into(),
        manifest:serde_json::from_value(json!({"name":id,"title":format!("插件{id}"),"main":"index.html","features":[{"code":"shared","explain":"功能","cmds":["shared"]}]})).unwrap(),
        created_at:"now".into(),updated_at:"now".into() }
}
fn save(db: &Database, id: &str) {
    let p = plugin(id);
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
}

#[test]
fn wrong_cached_owner_is_failed_audited_and_never_runs_the_ready_effect() {
    let db = Database::in_memory().unwrap();
    save(&db, "A");
    save(&db, "B");
    let run = begin(&db, "shared", &None, Some("A")).unwrap();
    let id = run.id.clone();
    let effects = AtomicUsize::new(0);
    let result = finish(
        &db,
        "shared",
        Instant::now(),
        run,
        resolve_checked(&db, "shared", None, Some("A")),
        |_| {
            effects.fetch_add(1, Ordering::SeqCst);
        },
    );
    assert!(result.err().unwrap().starts_with("FEATURE_OWNER_CHANGED:"));
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    let stored = db.get_task_run(&id).unwrap().unwrap();
    assert_eq!(stored.status, TaskRunStatus::Failed);
    assert!(stored.artifacts.is_empty());
    assert!(db
        .list_task_runs(10)
        .unwrap()
        .iter()
        .all(|run| run.status != TaskRunStatus::Succeeded));
}

#[test]
fn current_owner_and_legacy_code_only_calls_keep_identity_payload_and_normal_metadata_updates() {
    let db = Database::in_memory().unwrap();
    save(&db, "A");
    for expected in [Some("A"), None] {
        let payload = Some(json!({"original":"值"}));
        let action = resolve_checked(&db, "shared", payload.clone(), expected).unwrap();
        assert_eq!(action.plugin_id, "A");
        assert_eq!(action.feature_code, "shared");
        assert_eq!(action.payload, payload.unwrap());
    }
    let mut p = db.get_plugin("A").unwrap();
    p.manifest.title = Some("重命名仍同身份".into());
    p.version = "2".into();
    p.updated_at = "later".into();
    db.save_plugin(&p).unwrap();
    let action = resolve_checked(&db, "shared", None, Some("A")).unwrap();
    assert_eq!(action.plugin_name, "重命名仍同身份");
    let run = begin(&db, "shared", &None, Some("A")).unwrap();
    let id = run.id.clone();
    let effects = AtomicUsize::new(0);
    finish(&db, "shared", Instant::now(), run, Ok(action), |_| {
        effects.fetch_add(1, Ordering::SeqCst);
    })
    .unwrap();
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    assert_eq!(
        db.get_task_run(&id).unwrap().unwrap().status,
        TaskRunStatus::Succeeded
    );
}

#[test]
fn malformed_expected_identity_never_degrades_to_a_code_only_call() {
    let db = Database::in_memory().unwrap();
    save(&db, "A");
    for expected in ["", " A", "A ", "A\n"] {
        assert!(resolve_checked(&db, "shared", None, Some(expected))
            .err()
            .unwrap()
            .contains("Invalid expected"));
    }
}

#[tokio::test]
async fn owner_is_rechecked_after_waiting_for_the_actual_execution_gate() {
    for expected in [Some("A"), None] {
        let db = Arc::new(Database::in_memory().unwrap());
        save(&db, "A");
        let gates = Arc::new(crate::plugin_execution_gates::PluginExecutionGates::default());
        let mutation = gates.write("A").await;
        let (selected, selected_rx) = tokio::sync::oneshot::channel();
        let reader_db = db.clone();
        let reader_gates = gates.clone();
        let request = tokio::spawn(async move {
            let run = begin(&reader_db, "shared", &None, expected).unwrap();
            let result =
                resolve_with_gate(&reader_db, "shared", None, expected, |owner| async move {
                    selected.send(owner.clone()).unwrap();
                    reader_gates.read(&owner).await
                })
                .await;
            let effects = AtomicUsize::new(0);
            let result = finish(
                &reader_db,
                "shared",
                Instant::now(),
                run,
                result.map(|(action, _guard)| action),
                |_| {
                    effects.fetch_add(1, Ordering::SeqCst);
                },
            );
            assert_eq!(effects.load(Ordering::SeqCst), 0);
            result
        });
        assert_eq!(selected_rx.await.unwrap(), "A");
        // A different plugin's installation can replace this globally unique code.
        save(&db, "B");
        drop(mutation);
        assert!(request
            .await
            .unwrap()
            .err()
            .unwrap()
            .starts_with("FEATURE_OWNER_CHANGED:"));
        assert_eq!(
            db.list_task_runs(10).unwrap()[0].status,
            TaskRunStatus::Failed
        );
    }
}
