use super::{
    crypto, key_snapshot,
    once_authorization::OnceAuthorization,
    registry,
    sessions::Sessions,
    types::{Binding, Owner},
    validate_session,
};
use atools_core::{
    agent::PermissionDecision,
    task_run::{TaskRun, TaskRunInitiator, TaskRunStatus},
    Database, Plugin, PluginManifest,
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn plugin() -> Plugin {
    let manifest: PluginManifest = serde_json::from_value(
        json!({"name":"safe-storage-fixture","version":"1.0.0","main":"index.html"}),
    )
    .unwrap();
    Plugin {
        id: "safe-storage-fixture".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: "/isolated/safe-storage-fixture".into(),
        enabled: true,
        manifest,
        created_at: "fixture".into(),
        updated_at: "fixture".into(),
    }
}

fn pending_open() -> (Database, Plugin, Arc<Sessions>, Binding, String, TaskRun) {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let tool_name = registry::ensure_tool(&db, &plugin).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &tool_name).unwrap(),
        PermissionDecision::Confirm
    );
    let runtime = Arc::new(Sessions::default());
    let owner = Owner::new("main", &plugin.id, &uuid::Uuid::new_v4().to_string()).unwrap();
    let binding = Binding::current(&db, &plugin).unwrap();
    let preparation = runtime.begin(owner, None).unwrap();
    let intent_id = runtime.intent(preparation, binding.clone(), None).unwrap();
    let mut run = TaskRun::new(
        tool_name.clone(),
        TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"open","intentId":intent_id}),
    );
    run.status = TaskRunStatus::Running;
    let tool = db.get_agent_tool(&tool_name).unwrap().unwrap();
    run.output = json!({
        "permission_required":true,
        "retry_after_grant":true,
        "request_id":"fixture-request",
        "client_id":"atools-ui",
        "tool":tool_name,
        "arguments":run.input,
        "scopes":tool.scopes,
        "capabilitySnapshot":"fixture-current-capability"
    });
    db.upsert_task_run(&run).unwrap();
    runtime
        .store
        .lock()
        .intents
        .get(&intent_id)
        .unwrap()
        .run
        .lock()
        .replace(run.id.clone());
    (db, plugin, runtime, binding, intent_id, run)
}

#[test]
fn once_requires_exact_pending_run_then_expires_on_revoke_cancel_or_close() {
    let (db, plugin, runtime, binding, intent_id, mut run) = pending_open();
    let intent = runtime
        .store
        .lock()
        .intents
        .get(&intent_id)
        .unwrap()
        .clone();
    let tool = registry::tool_name(&plugin.id);
    assert!(OnceAuthorization::confirmed_open(
        &db,
        &intent_id,
        &intent,
        &plugin,
        &tool,
        "wrong-run"
    )
    .is_err());

    let proof =
        OnceAuthorization::confirmed_open(&db, &intent_id, &intent, &plugin, &tool, &run.id)
            .unwrap();
    let session = runtime
        .open(&intent_id, &binding, crypto::new_key(), Some(proof))
        .unwrap();
    let parsed_session_id = uuid::Uuid::parse_str(&session.id).unwrap();
    assert_eq!(parsed_session_id.get_version(), Some(uuid::Version::Random));
    run.status = TaskRunStatus::Succeeded;
    run.output =
        json!({"sessionId":session.id,"pluginId":plugin.id,"runtime":"plugin-secret-storage"});
    db.upsert_task_run(&run).unwrap();
    assert!(validate_session(&db, &session).is_ok());

    db.set_setting("agent.scope_policy", r#"{"secret_storage":"deny"}"#)
        .unwrap();
    assert!(
        validate_session(&db, &session).is_err(),
        "scope deny must override Once"
    );
    db.set_setting("agent.scope_policy", "{}").unwrap();
    run.status = TaskRunStatus::Cancelled;
    db.upsert_task_run(&run).unwrap();
    assert!(
        validate_session(&db, &session).is_err(),
        "cancelled opening run must revoke Once"
    );
    runtime.close(Some(&session.owner), None, None, false);
    assert!(
        validate_session(&db, &session).is_err(),
        "closed session must clear Once authority"
    );
    assert!(
        key_snapshot(&session).is_err(),
        "closed session must not yield a crypto key snapshot"
    );
    assert_eq!(*session.key.lock().as_ref(), [0; 32]);
}

#[test]
fn expired_intent_cannot_create_once_proof_even_with_live_pending_run() {
    let (db, plugin, runtime, _binding, intent_id, run) = pending_open();
    let mut store = runtime.store.lock();
    let intent = store.intents.get_mut(&intent_id).unwrap();
    intent.created = Instant::now() - Duration::from_secs(601);
    let expired = intent.clone();
    drop(store);
    assert!(OnceAuthorization::confirmed_open(
        &db,
        &intent_id,
        &expired,
        &plugin,
        &registry::tool_name(&plugin.id),
        &run.id
    )
    .is_err());
}

#[test]
fn revoked_saved_grant_does_not_downgrade_an_open_session_to_once() {
    let (db, plugin, runtime, binding, intent_id, mut run) = pending_open();
    let tool = registry::tool_name(&plugin.id);
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &tool).unwrap(),
        PermissionDecision::Allow
    );
    let session = runtime
        .open(&intent_id, &binding, crypto::new_key(), None)
        .unwrap();
    run.status = TaskRunStatus::Succeeded;
    run.output =
        json!({"sessionId":session.id,"pluginId":plugin.id,"runtime":"plugin-secret-storage"});
    db.upsert_task_run(&run).unwrap();
    assert!(validate_session(&db, &session).is_ok());
    db.revoke_agent_tool("atools-ui", &tool).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &tool).unwrap(),
        PermissionDecision::Confirm
    );
    assert!(
        validate_session(&db, &session).is_err(),
        "Confirm must not become a saved-session Once grant"
    );
}
