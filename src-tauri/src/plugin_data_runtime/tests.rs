use super::{
    operations, privacy, registry,
    source_hint::{Hints, Usage},
    types::{Binding, Invocation, Owner},
    Sessions,
};
use atools_core::{Database, Plugin};
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc};

fn plugin(db: &Database, path: &str) -> Plugin {
    let plugin=serde_json::from_value(json!({"id":"data-fixture","name":"data-fixture","version":"1.0.0","path":path,
        "enabled":true,"manifest":{"name":"data-fixture","version":"1.0.0","main":"index.html"},"created_at":"now","updated_at":"now"})).unwrap();
    db.save_plugin(&plugin).unwrap();
    plugin
}
fn new_owner(plugin: &str) -> Owner {
    Owner::new("main", plugin, &uuid::Uuid::new_v4().to_string()).unwrap()
}
fn request(method: &str, args: Value) -> Value {
    json!({"method":method,"args":args})
}
fn call(db: &Database, method: &str, args: Value) -> Value {
    operations::execute(db, "data-fixture", &request(method, args)).unwrap()
}
pub(super) fn fixture() -> (Database, Plugin, Arc<Sessions>, Owner, Binding) {
    let db = Database::in_memory().unwrap();
    let p = plugin(&db, "/inert");
    let binding = Binding::current(&db, &p).unwrap();
    let owner = new_owner(&p.id);
    (db, p, Arc::new(Sessions::default()), owner, binding)
}
#[test]
fn data_runtime_prepare_cancel_cannot_revive_after_owner_window_or_plugin_close() {
    for mode in 0..3 {
        let (_, p, runtime, owner, binding) = fixture();
        let preparation = runtime.begin(owner.clone()).unwrap();
        match mode {
            0 => {
                runtime.close(Some(&owner), None, None, false);
            }
            1 => {
                runtime.close(None, None, Some("main"), false);
            }
            _ => {
                runtime.close(None, Some(&p.id), None, false);
            }
        }
        assert!(runtime.intent(preparation, binding).is_err());
        assert_eq!(runtime.counts(), (0, 0, 0, 0));
    }
}
#[test]
fn data_runtime_intent_is_one_shot_and_close_cancels_pending_permission() {
    let (_, _, runtime, owner, binding) = fixture();
    let intent = runtime
        .intent(runtime.begin(owner.clone()).unwrap(), binding.clone())
        .unwrap();
    assert!(runtime.bind_run(&intent, "permission-run"));
    assert_eq!(
        runtime.close(Some(&owner), None, None, false),
        vec!["permission-run"]
    );
    assert!(runtime.open(&intent, &binding).is_err());
    let intent = runtime
        .intent(runtime.begin(owner).unwrap(), binding.clone())
        .unwrap();
    assert!(runtime.open(&intent, &binding).is_ok());
    assert!(runtime.open(&intent, &binding).is_err());
}
#[test]
fn data_runtime_rotation_revokes_old_bearer_and_old_generation_close_revokes_successor() {
    let (_, p, runtime, owner, binding) = fixture();
    let intent = runtime
        .intent(runtime.begin(owner.clone()).unwrap(), binding.clone())
        .unwrap();
    let old = runtime.open(&intent, &binding).unwrap();
    let next = new_owner(&p.id);
    let pending = runtime.begin(old.owner.clone()).unwrap();
    let (new, _) = runtime.rotate(&old.owner, next, &old.id).unwrap();
    assert!(runtime.intent(pending, binding.clone()).is_err());
    assert!(runtime.begin(old.owner.clone()).is_err());
    assert_ne!(old.id, new.id);
    assert_ne!(old.token, new.token);
    assert!(!*old.active.lock());
    assert!(runtime.by_token(&old.token).is_none());
    assert!(runtime.by_token(&new.token).is_some());
    runtime.close(Some(&old.owner), None, None, false);
    assert!(runtime.get(&new.id).is_err());
}
#[test]
fn data_runtime_binding_rejects_disabled_path_version_and_same_version_revision_change() {
    let (db, mut p, _, _, binding) = fixture();
    for kind in 0..3 {
        let original = p.clone();
        match kind {
            0 => p.enabled = false,
            1 => p.path = "/changed".into(),
            _ => p.version = "2".into(),
        }
        db.save_plugin(&p).unwrap();
        assert!(binding.validate(&db, &p.id).is_err());
        p = original;
        db.save_plugin(&p).unwrap();
    }
    crate::plugin_code_revision::CodeRevision::begin(&db, &p.id)
        .unwrap()
        .finish(&db)
        .unwrap();
    assert!(binding.validate(&db, &p.id).is_err());
}
#[test]
fn data_runtime_private_metadata_rejects_raw_payload_foreign_identity_and_replayed_ticket() {
    let (_, p, runtime, owner, binding) = fixture();
    let intent = runtime
        .intent(runtime.begin(owner).unwrap(), binding.clone())
        .unwrap();
    let name = registry::tool_name(&p.id);
    assert!(privacy::validate(
        &runtime,
        &p.id,
        &name,
        &json!({"operation":"open","intentId":intent,"doc":{"secret":true}})
    )
    .is_err());
    assert!(privacy::validate(
        &runtime,
        "foreign",
        &name,
        &json!({"operation":"open","intentId":intent})
    )
    .is_err());
    let session = runtime.open(&intent, &binding).unwrap();
    let invocation = Arc::new(Invocation {
        session: session.id.clone(),
        request: request("db.get", json!(["private-id"])),
        claimed: AtomicBool::new(false),
        dynamic_features_changed: AtomicBool::new(false),
        run: parking_lot::Mutex::new(None),
        result: parking_lot::Mutex::new(None),
    });
    runtime
        .store
        .lock()
        .invocations
        .insert("ticket".into(), invocation);
    let args = json!({"operation":"request","sessionId":session.id,"invocationId":"ticket","method":"db.get"});
    privacy::validate(&runtime, &p.id, &name, &args).unwrap();
    let mut bad = args.clone();
    bad["method"] = json!("db.put");
    assert!(privacy::validate(&runtime, &p.id, &name, &bad).is_err());
    runtime.store.lock().invocations.remove("ticket");
    assert!(privacy::validate(&runtime, &p.id, &name, &args).is_err());

    let private = Arc::new(Invocation {
        session: session.id.clone(),
        request: request(
            "webStorage.setItem",
            json!([
                "private-client",
                "private-url",
                "private-key",
                "private-value"
            ]),
        ),
        claimed: AtomicBool::new(false),
        dynamic_features_changed: AtomicBool::new(false),
        run: parking_lot::Mutex::new(None),
        result: parking_lot::Mutex::new(None),
    });
    runtime
        .store
        .lock()
        .invocations
        .insert("web-ticket".into(), private);
    let durable = json!({"operation":"request","sessionId":session.id,"invocationId":"web-ticket","method":"webStorage.setItem"});
    privacy::validate(&runtime, &p.id, &name, &durable).unwrap();
    let serialized = durable.to_string();
    for secret in ["private-url", "private-key", "private-value"] {
        assert!(!serialized.contains(secret));
    }
}
#[test]
fn data_runtime_limits_preparations_and_sessions_without_starting_transport() {
    let (_, p, runtime, _, binding) = fixture();
    let mut preparations = Vec::new();
    for _ in 0..32 {
        preparations.push(runtime.begin(new_owner(&p.id)).unwrap());
    }
    assert!(runtime.begin(new_owner(&p.id)).is_err());
    drop(preparations);
    for _ in 0..4 {
        let id = runtime
            .intent(runtime.begin(new_owner(&p.id)).unwrap(), binding.clone())
            .unwrap();
        runtime.open(&id, &binding).unwrap();
    }
    let id = runtime
        .intent(runtime.begin(new_owner(&p.id)).unwrap(), binding.clone())
        .unwrap();
    assert!(runtime.open(&id, &binding).is_err());
    assert!(runtime.server.try_lock().unwrap().is_none());
}
#[test]
fn data_runtime_crud_storage_share_real_sqlite_and_conflict_remains_private_value() {
    let (db, _, _, _, _) = fixture();
    assert_eq!(call(&db, "db.get", json!(["missing"])), Value::Null);
    let first = call(
        &db,
        "db.put",
        json!([{"_id":"color/ff0000","color":"#FF0000","name":"red"}]),
    );
    assert_eq!(first["ok"], true);
    let doc = call(&db, "db.get", json!(["color/ff0000"]));
    assert_eq!(doc["name"], "red");
    assert!(doc["_rev"].is_string());
    let conflict = call(&db, "db.put", json!([{"_id":"color/ff0000","name":"lost"}]));
    assert_eq!(conflict["name"], "conflict");
    assert!(operations::logical_failure("db.put", &conflict));
    assert!(!operations::logical_failure(
        "db.get",
        &json!({"error":true})
    ));
    call(
        &db,
        "dbStorage.setItem",
        json!(["collectsort", ["color/ff0000"]]),
    );
    assert_eq!(
        call(&db, "dbStorage.getItem", json!(["collectsort"])),
        json!(["color/ff0000"])
    );
    assert!(db
        .plugin_data_get_bounded("data-fixture", "collectsort")
        .unwrap()
        .is_some());
    assert_eq!(
        call(&db, "db.allDocs", json!(["color/"]))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(
            &db,
            "db.allDocs",
            json!([["color/ff0000", "missing", "color/ff0000"]])
        )
        .as_array()
        .unwrap()
        .len(),
        2
    );
    let other =
        operations::execute(&db, "other", &request("db.get", json!(["color/ff0000"]))).unwrap();
    assert_eq!(other, Value::Null);
    let missing_storage = call(&db, "dbStorage.removeItem", json!(["absent-key"]));
    assert_eq!(missing_storage["name"], "not_found");
    assert_eq!(missing_storage["error"], true);
    assert!(operations::logical_failure(
        "dbStorage.removeItem",
        &missing_storage
    ));
    assert_eq!(
        call(&db, "dbStorage.removeItem", json!(["collectsort"])),
        Value::Null
    );
}
#[test]
fn data_runtime_rejects_unknown_fields_methods_and_oversized_request_before_writes() {
    let (db, _, _, _, _) = fixture();
    assert!(operations::execute(
        &db,
        "data-fixture",
        &json!({"method":"db.put","args":[],"pluginId":"other"})
    )
    .is_err());
    assert!(operations::execute(&db, "data-fixture", &request("shell", json!([]))).is_err());
    assert!(operations::execute(
        &db,
        "data-fixture",
        &request(
            "db.put",
            json!([{"_id":"too-large","text":"x".repeat(512*1024)}])
        )
    )
    .is_err());
    assert!(db
        .plugin_data_get_bounded("data-fixture", "too-large")
        .unwrap()
        .is_none());
}
#[test]
fn data_runtime_hint_distinguishes_detected_not_detected_unknown_and_does_not_execute_source() {
    let db = Database::in_memory().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let p = plugin(&db, directory.path().to_str().unwrap());
    let hints = Hints::default();
    std::fs::write(
        directory.path().join("index.html"),
        "<script>window.unexecuted=true</script>",
    )
    .unwrap();
    assert_eq!(hints.scan(&p, None), Usage::NotDetected);
    std::fs::write(
        directory.path().join("index.html"),
        "utools . db . get('private')",
    )
    .unwrap();
    assert_eq!(hints.scan(&p, None), Usage::Detected);
    std::fs::write(
        directory.path().join("index.html"),
        "x".repeat(2 * 1024 * 1024 + 1),
    )
    .unwrap();
    assert_eq!(hints.scan(&p, None), Usage::Unknown);
}
#[test]
fn data_runtime_attachment_roundtrip_and_conflict_use_bounded_binary_dto() {
    let (db, _, _, _, _) = fixture();
    let stored = call(
        &db,
        "db.postAttachment",
        json!(["binary", "AAEC/w==", "application/octet-stream"]),
    );
    assert_eq!(stored["ok"], true);
    assert_eq!(
        call(&db, "db.getAttachment", json!(["binary"])),
        json!({"base64":"AAEC/w=="})
    );
    let metadata = call(&db, "db.getAttachmentType", json!(["binary"]));
    assert_eq!(metadata["type"], "application/octet-stream");
    assert_eq!(metadata["length"], 4);
    assert_eq!(metadata["name"], "default");
    assert!(metadata["digest"].is_string());
    let repeated = call(
        &db,
        "db.postAttachment",
        json!(["binary", "AA==", "text/plain"]),
    );
    assert_eq!(repeated["name"], "conflict");
    assert!(operations::logical_failure("db.postAttachment", &repeated));
}
#[test]
fn data_runtime_hint_reads_large_published_size_bundle_and_keeps_total_budget() {
    let db = Database::in_memory().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let p = plugin(&db, directory.path().to_str().unwrap());
    let hints = Hints::default();
    let mut source = vec![b' '; 679_904];
    let api = b"utools.db.get('example')";
    source[600_000..600_000 + api.len()].copy_from_slice(api);
    std::fs::write(directory.path().join("index.js"), &source).unwrap();
    assert_eq!(hints.scan(&p, None), Usage::Detected);
    std::fs::write(directory.path().join("index.js"), vec![b' '; 679_904]).unwrap();
    assert_eq!(hints.scan(&p, None), Usage::NotDetected);
    for index in 0..5 {
        std::fs::write(
            directory.path().join(format!("chunk{index}.js")),
            vec![b' '; 2 * 1024 * 1024],
        )
        .unwrap();
    }
    assert_eq!(hints.scan(&p, None), Usage::Unknown);
}
#[test]
fn data_runtime_closing_latest_generation_forgets_bounded_predecessor_chain() {
    let (_, p, runtime, _, binding) = fixture();
    for _ in 0..40 {
        let owner = new_owner(&p.id);
        let intent = runtime
            .intent(runtime.begin(owner.clone()).unwrap(), binding.clone())
            .unwrap();
        let first = runtime.open(&intent, &binding).unwrap();
        let (next, _) = runtime.rotate(&owner, new_owner(&p.id), &first.id).unwrap();
        let (latest, _) = runtime
            .rotate(&next.owner, new_owner(&p.id), &next.id)
            .unwrap();
        runtime.close(Some(&latest.owner), None, None, false);
        assert_eq!(runtime.counts(), (0, 0, 0, 0));
    }
}
#[test]
fn data_runtime_expired_authorization_cancels_bound_real_task_and_removes_request() {
    use atools_core::{
        agent::PendingAgentToolRequest,
        task_run::{TaskRun, TaskRunInitiator, TaskRunStatus},
    };
    let (db, p, runtime, owner, binding) = fixture();
    let intent = runtime
        .intent(runtime.begin(owner).unwrap(), binding.clone())
        .unwrap();
    let mut run = TaskRun::new(
        registry::tool_name(&p.id),
        TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"open","intentId":intent}),
    );
    run.transition(TaskRunStatus::AwaitingPermission).unwrap();
    db.upsert_task_run(&run).unwrap();
    runtime.bind_run(&intent, &run.id);
    runtime
        .store
        .lock()
        .intents
        .get_mut(&intent)
        .unwrap()
        .created = std::time::Instant::now() - std::time::Duration::from_secs(601);
    let request = PendingAgentToolRequest {
        id: "pending".into(),
        run_id: Some(run.id.clone()),
        client_id: "atools-ui".into(),
        tool_name: run.capability_id.clone(),
        arguments: run.input.clone(),
        scopes: vec![],
        created_at: "now".into(),
    };
    let mut pending = std::collections::BTreeMap::from([(request.id.clone(), request)]);
    let expired = runtime.expire_intents();
    assert_eq!(expired, vec![run.id.clone()]);
    for id in expired {
        assert!(super::lifecycle::cancel_with(&db, &id, || {
            pending.retain(|_, request| request.run_id.as_deref() != Some(&id));
        }));
    }
    assert_eq!(
        db.get_task_run(&run.id).unwrap().unwrap().status,
        TaskRunStatus::Cancelled
    );
    assert!(pending.is_empty());
    assert!(runtime.open(&intent, &binding).is_err());
    let fresh = runtime
        .intent(runtime.begin(new_owner(&p.id)).unwrap(), binding)
        .unwrap();
    assert_ne!(fresh, intent);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn data_runtime_owned_execution_guard_survives_aborted_async_caller() {
    let gate = Arc::new(tokio::sync::RwLock::new(()));
    let guard = Arc::new(gate.clone().read_owned().await);
    let (started_rx, release_rx) = (
        std::sync::Arc::new(std::sync::Barrier::new(2)),
        std::sync::Arc::new(std::sync::Barrier::new(2)),
    );
    let started = started_rx.clone();
    let release = release_rx.clone();
    let task = tokio::spawn(async move {
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            started.wait();
            release.wait();
        })
        .await
        .unwrap();
    });
    started_rx.wait();
    task.abort();
    assert!(gate.try_write().is_err());
    release_rx.wait();
    let _write = tokio::time::timeout(std::time::Duration::from_secs(2), gate.write())
        .await
        .unwrap();
}
