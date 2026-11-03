use super::{
    execute_sync_request,
    once_authorization::OnceAuthorization,
    registry::{self, Access},
    request::ClipboardRequest,
    sessions::Sessions,
    tests::{fixture, plugin},
    validate_session,
};
use crate::plugin_page_runtime::test_binding;
use atools_core::{
    agent::PermissionDecision,
    db::Database,
    task_run::{TaskRun, TaskRunInitiator, TaskRunStatus},
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn confirmed_open(
    db: &Database,
    runtime: &Sessions,
    plugin: &atools_core::Plugin,
    access: Access,
    owner: &str,
) -> (Arc<super::sessions::Session>, String) {
    confirmed_open_with_document(db, runtime, plugin, access, owner, None, Duration::ZERO)
}

fn confirmed_open_with_document(
    db: &Database,
    runtime: &Sessions,
    plugin: &atools_core::Plugin,
    access: Access,
    owner: &str,
    document: Option<crate::plugin_page_runtime::DocumentBinding>,
    intent_age: Duration,
) -> (Arc<super::sessions::Session>, String) {
    let tool_name = registry::ensure_tool(db, plugin, access).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool_name).unwrap(),
        PermissionDecision::Confirm
    );
    let intent_id = runtime
        .intent_with_document(owner.into(), plugin.id.clone(), access, document)
        .unwrap();
    let mut run = TaskRun::new(
        tool_name.clone(),
        TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"open","intentId":intent_id}),
    );
    run.status = TaskRunStatus::Running;
    let tool = db.get_agent_tool(&tool_name).unwrap().unwrap();
    run.output = json!({
        "permission_required":true,"retry_after_grant":true,"request_id":"approved-request",
        "client_id":"atools-ui","tool":tool_name,"arguments":run.input,
        "scopes":tool.scopes,"capabilitySnapshot":"validated-current-snapshot"
    });
    db.upsert_task_run(&run).unwrap();
    if !intent_age.is_zero() {
        runtime
            .store
            .lock()
            .intents
            .get_mut(&intent_id)
            .unwrap()
            .created = Instant::now() - intent_age;
    }
    runtime
        .store
        .lock()
        .intents
        .get(&intent_id)
        .unwrap()
        .run
        .lock()
        .replace(run.id.clone());
    let intent = runtime
        .store
        .lock()
        .intents
        .get(&intent_id)
        .unwrap()
        .clone();
    let proof = OnceAuthorization::for_confirmed_open(
        db, &intent_id, &intent, plugin, access, &tool_name, &run.id,
    )
    .unwrap();
    let session = runtime
        .open_with_once_authorization(&intent_id, plugin, access, Some(proof))
        .unwrap();
    run.status = TaskRunStatus::Succeeded;
    run.output = json!({"sessionId":session.id,"pluginId":plugin.id,"access":access.label(),"runtime":"host-clipboard"});
    db.upsert_task_run(&run).unwrap();
    (session, run.id)
}

#[test]
fn confirmed_read_once_runs_real_history_requests_and_keeps_full_content() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, backend) = fixture();
    let (session, run_id) =
        confirmed_open(&db, &runtime, &plugin, Access::HistoryRead, "once-read");
    let text = format!("{}\n  preserved copy bytes  ", "x".repeat(300));
    let entry = db
        .record_clipboard_text(&text, "2026-10-22T10:00:00Z")
        .unwrap();
    assert!(validate_session(&db, &session).is_ok());
    let list = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":10}),
    )
    .unwrap();
    let page = execute_sync_request(&db, &session, &list, backend.as_ref()).unwrap();
    assert_eq!(page["items"][0]["content"], text);
    let get = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"getContent","id":entry.id}),
    )
    .unwrap();
    assert_eq!(
        execute_sync_request(&db, &session, &get, backend.as_ref()).unwrap()["content"],
        text
    );
    assert!(ClipboardRequest::parse(Access::HistoryRead, &json!({"operation":"clear"})).is_err());
    let mut revoked_run = db.get_task_run(&run_id).unwrap().unwrap();
    revoked_run.status = TaskRunStatus::Cancelled;
    db.upsert_task_run(&revoked_run).unwrap();
    assert!(validate_session(&db, &session).is_err());
}

#[test]
fn confirmed_delete_once_deletes_only_requested_rows_and_deny_wins() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, backend) = fixture();
    let (session, _) = confirmed_open(&db, &runtime, &plugin, Access::HistoryDelete, "once-delete");
    let keep = db
        .record_clipboard_text("keep", "2026-10-22T10:00:00Z")
        .unwrap();
    let remove = db
        .record_clipboard_text("remove", "2026-10-22T10:01:00Z")
        .unwrap();
    let delete = ClipboardRequest::parse(
        Access::HistoryDelete,
        &json!({"operation":"delete","id":remove.id}),
    )
    .unwrap();
    assert_eq!(
        execute_sync_request(&db, &session, &delete, backend.as_ref()).unwrap()["deleted"],
        true
    );
    assert_eq!(db.search_clipboard_history("", 10).unwrap()[0].id, keep.id);
    db.set_setting("agent.scope_policy", r#"{"clipboard_delete":"deny"}"#)
        .unwrap();
    let clear =
        ClipboardRequest::parse(Access::HistoryDelete, &json!({"operation":"clear"})).unwrap();
    assert!(execute_sync_request(&db, &session, &clear, backend.as_ref()).is_err());
    assert_eq!(db.search_clipboard_history("", 10).unwrap().len(), 1);
    db.set_setting("agent.scope_policy", "{}").unwrap();
    assert_eq!(
        execute_sync_request(&db, &session, &clear, backend.as_ref()).unwrap()["deletedCount"],
        1
    );
    assert!(db.search_clipboard_history("", 10).unwrap().is_empty());
}

#[test]
fn saved_grant_revoke_never_downgrades_to_once_and_rotation_requires_reapproval() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, _) = fixture();
    let tool = registry::ensure_tool(&db, &plugin, Access::HistoryRead).unwrap();
    db.set_setting("agent.permission_mode", "developer")
        .unwrap();
    let developer_intent = runtime
        .intent(
            "developer-owner".into(),
            plugin.id.clone(),
            Access::HistoryRead,
        )
        .unwrap();
    let developer_session = runtime
        .open(&developer_intent, &plugin, Access::HistoryRead)
        .unwrap();
    db.set_setting("agent.permission_mode", "conservative")
        .unwrap();
    assert!(validate_session(&db, &developer_session).is_err());
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let saved_intent = runtime
        .intent("saved-owner".into(), plugin.id.clone(), Access::HistoryRead)
        .unwrap();
    let saved = runtime
        .open(&saved_intent, &plugin, Access::HistoryRead)
        .unwrap();
    db.revoke_agent_tool("atools-ui", &tool).unwrap();
    assert!(validate_session(&db, &saved).is_err());

    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let saved_again = runtime
        .open(
            &runtime
                .intent(
                    "saved-owner-2".into(),
                    plugin.id.clone(),
                    Access::HistoryRead,
                )
                .unwrap(),
            &plugin,
            Access::HistoryRead,
        )
        .unwrap();
    let saved_successors = runtime
        .rotate_bound(
            "saved-owner-2",
            "saved-owner-3",
            &plugin.id,
            &[saved_again.id.clone()],
            None,
        )
        .unwrap();
    assert!(saved_successors.is_empty());
    let saved_successor = runtime
        .store
        .lock()
        .sessions
        .values()
        .find(|s| s.owner == "saved-owner-3")
        .cloned()
        .unwrap();
    assert!(validate_session(&db, &saved_successor).is_ok());
    let (once, once_run_id) = confirmed_open(
        &db,
        &runtime,
        &plugin,
        Access::HistoryDelete,
        "rotating-once",
    );
    let rotated = runtime
        .rotate_bound(
            "rotating-once",
            "rotated-once",
            &plugin.id,
            &[once.id.clone()],
            None,
        )
        .unwrap();
    assert_eq!(rotated, vec![once_run_id]);
    assert!(runtime
        .store
        .lock()
        .sessions
        .values()
        .any(|s| s.id == saved_successor.id));
    assert!(!runtime
        .store
        .lock()
        .sessions
        .values()
        .any(|s| s.owner == "rotated-once"));
    assert!(runtime
        .intent(
            "rotated-once".into(),
            plugin.id.clone(),
            Access::HistoryDelete
        )
        .is_ok());
    let (reauthorized, _) = confirmed_open(
        &db,
        &runtime,
        &plugin,
        Access::HistoryDelete,
        "rotated-once",
    );
    assert!(validate_session(&db, &reauthorized).is_ok());
}

#[test]
fn once_proof_rejects_missing_stale_or_mismatched_taskrun_evidence() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, _) = fixture();
    let tool_name = registry::ensure_tool(&db, &plugin, Access::HistoryRead).unwrap();
    let intent_id = runtime
        .intent("proof-owner".into(), plugin.id.clone(), Access::HistoryRead)
        .unwrap();
    let intent = runtime
        .store
        .lock()
        .intents
        .get(&intent_id)
        .unwrap()
        .clone();
    assert!(OnceAuthorization::for_confirmed_open(
        &db,
        &intent_id,
        &intent,
        &plugin,
        Access::HistoryRead,
        &tool_name,
        "missing-run"
    )
    .is_err());

    let mut run = TaskRun::new(
        tool_name.clone(),
        TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"open","intentId":intent_id}),
    );
    run.status = TaskRunStatus::Running;
    let tool = db.get_agent_tool(&tool_name).unwrap().unwrap();
    run.output = json!({"permission_required":true,"retry_after_grant":true,"request_id":"r","client_id":"atools-ui","tool":tool_name,"arguments":{"operation":"open","intentId":"other-intent"},"scopes":tool.scopes,"capabilitySnapshot":"digest"});
    db.upsert_task_run(&run).unwrap();
    *intent.run.lock() = Some(run.id.clone());
    assert!(OnceAuthorization::for_confirmed_open(
        &db,
        &intent_id,
        &intent,
        &plugin,
        Access::HistoryRead,
        &tool_name,
        &run.id
    )
    .is_err());

    run.output["arguments"] = run.input.clone();
    run.capability_id = "different-capability".into();
    db.upsert_task_run(&run).unwrap();
    assert!(OnceAuthorization::for_confirmed_open(
        &db,
        &intent_id,
        &intent,
        &plugin,
        Access::HistoryRead,
        &tool_name,
        &run.id
    )
    .is_err());
    run.capability_id = tool_name.clone();
    run.status = TaskRunStatus::AwaitingPermission;
    db.upsert_task_run(&run).unwrap();
    assert!(OnceAuthorization::for_confirmed_open(
        &db,
        &intent_id,
        &intent,
        &plugin,
        Access::HistoryRead,
        &tool_name,
        &run.id
    )
    .is_err());
    run.status = TaskRunStatus::Running;
    db.upsert_task_run(&run).unwrap();
    let mut stale = intent;
    stale.created = Instant::now() - Duration::from_secs(601);
    assert!(OnceAuthorization::for_confirmed_open(
        &db,
        &intent_id,
        &stale,
        &plugin,
        Access::HistoryRead,
        &tool_name,
        &run.id
    )
    .is_err());
}

#[test]
fn document_bound_once_session_is_not_transferred_to_rotated_owner() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, backend) = fixture();
    let (old_document, old_active) = test_binding();
    let (session, session_run_id) = confirmed_open_with_document(
        &db,
        &runtime,
        &plugin,
        Access::HistoryRead,
        "document-owner",
        Some(old_document),
        Duration::ZERO,
    );
    assert!(validate_session(&db, &session).is_ok());
    let (new_document, _) = test_binding();
    let rotated = runtime
        .rotate_bound(
            "document-owner",
            "document-owner-next",
            &plugin.id,
            &[session.id.clone()],
            Some(new_document.clone()),
        )
        .unwrap();
    assert_eq!(rotated, vec![session_run_id]);
    let list = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":10}),
    )
    .unwrap();
    assert!(execute_sync_request(&db, &session, &list, backend.as_ref()).is_err());
    old_active.store(false, std::sync::atomic::Ordering::Release);
    let (reauthorized, _) = confirmed_open_with_document(
        &db,
        &runtime,
        &plugin,
        Access::HistoryRead,
        "document-owner-next",
        Some(new_document),
        Duration::ZERO,
    );
    assert!(validate_session(&db, &reauthorized).is_ok());
}

#[test]
fn once_session_expires_from_original_intent_creation_time() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, _) = fixture();
    let (session, _) = confirmed_open_with_document(
        &db,
        &runtime,
        &plugin,
        Access::HistoryRead,
        "near-expiry-owner",
        None,
        Duration::from_secs(599),
    );
    let proof = session.once_authorization.as_ref().unwrap();
    let expires_at = proof.expires_at_for_test();
    assert!(proof.permits_at_for_test(&db, &session, expires_at - Duration::from_nanos(1)));
    assert!(!proof.permits_at_for_test(&db, &session, expires_at));
}
