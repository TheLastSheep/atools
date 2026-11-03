use super::{
    dto::{Operation, Outcome, Receipt, Request},
    receipt::INTENT_TTL,
    store::Runtime,
};
use atools_core::Database;
use serde_json::json;

fn request(plugin: &str, operation: Operation) -> Request {
    Request {
        request_id: uuid::Uuid::new_v4().to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        plugin_id: plugin.into(),
        code_revision: "a".repeat(64),
        operation,
    }
}

fn action(plugin: &str) -> serde_json::Value {
    json!({"plugin_id":plugin,"feature_code":"","payload":null})
}

#[test]
fn only_one_live_start_intent_or_admission_per_plugin_even_with_distinct_session_ids() {
    let runtime = Runtime::default();
    let first = request("same-plugin", Operation::Start);
    runtime
        .begin("main", first.clone(), action("same-plugin"))
        .unwrap();

    let mut concurrent = request("same-plugin", Operation::Start);
    assert_ne!(first.session_id, concurrent.session_id);
    assert_eq!(
        runtime
            .begin("main", concurrent.clone(), action("same-plugin"))
            .err()
            .expect("duplicate plugin reservation is rejected"),
        "ERR_PLUGIN_BACKGROUND_SESSION_EXISTS"
    );

    let ready = runtime.intent(&first.request_id).unwrap();
    ready.bind_run("run-first").unwrap();
    runtime.finish(&ready, Outcome::Ready, "run-first").unwrap();
    concurrent.plugin_id = "same-plugin".into();
    assert_eq!(
        runtime
            .begin("main", concurrent, action("same-plugin"))
            .err()
            .expect("ready admission prevents a duplicate plugin reservation"),
        "ERR_PLUGIN_BACKGROUND_SESSION_EXISTS"
    );
}

#[test]
fn receipt_and_task_run_admission_are_single_use_and_operation_bound() {
    let runtime = Runtime::default();
    let start = request("plugin-a", Operation::Start);
    let intent = runtime
        .begin("main", start.clone(), action("plugin-a"))
        .unwrap();
    intent.bind_run("run-a").unwrap();
    let (ticket, mut receiver) = intent.start().unwrap();
    let receipt = Receipt {
        request_id: start.request_id.clone(),
        ticket: ticket.clone(),
        session_id: start.session_id.clone(),
        outcome: Outcome::Ready,
    };
    runtime.complete(&intent, receipt.clone()).unwrap();
    assert!(runtime.complete(&intent, receipt).is_err());
    assert_eq!(
        receiver.try_recv().unwrap().unwrap().outcome,
        Outcome::Ready
    );
    runtime.finish(&intent, Outcome::Ready, "run-a").unwrap();
    assert_eq!(
        runtime.admission("main", &start.session_id).unwrap().run_id,
        "run-a"
    );

    let stop = Request {
        request_id: uuid::Uuid::new_v4().to_string(),
        session_id: start.session_id.clone(),
        plugin_id: start.plugin_id.clone(),
        code_revision: start.code_revision.clone(),
        operation: Operation::Stop,
    };
    let stop_intent = runtime
        .begin("main", stop.clone(), action("plugin-a"))
        .unwrap();
    stop_intent.bind_run("run-stop").unwrap();
    assert!(runtime
        .finish(&stop_intent, Outcome::Ready, "run-stop")
        .is_err());
    assert!(runtime.admission("main", &start.session_id).is_ok());
}

#[test]
fn resident_limit_counts_ready_and_pending_starts_atomically() {
    let runtime = Runtime::default();
    for plugin in ["plugin-a", "plugin-b"] {
        let request = request(plugin, Operation::Start);
        runtime.begin("main", request, action(plugin)).unwrap();
    }
    let request = request("plugin-c", Operation::Start);
    assert_eq!(
        runtime
            .begin("main", request, action("plugin-c"))
            .err()
            .expect("resident limit rejects the third plugin"),
        "ERR_PLUGIN_BACKGROUND_LIMIT"
    );
}

#[tokio::test(start_paused = true)]
async fn background_ttl_expires_intents_but_never_a_ready_resident_admission() {
    let runtime = Runtime::default();
    let start = request("ttl-plugin", Operation::Start);
    let intent = runtime
        .begin("main", start.clone(), action("ttl-plugin"))
        .unwrap();
    intent.bind_run("ttl-run").unwrap();
    let (_, _receiver) = intent.start().unwrap();
    let expiry = tokio::spawn(async move { intent.wait_until_expired().await });

    tokio::time::advance(INTENT_TTL).await;
    assert!(expiry.await.unwrap(), "an uncompleted admission expires");
    runtime.close_request(&start.request_id);

    let ready = request("ready-plugin", Operation::Start);
    let intent = runtime
        .begin("main", ready.clone(), action("ready-plugin"))
        .unwrap();
    intent.bind_run("ready-run").unwrap();
    let (ticket, mut receiver) = intent.start().unwrap();
    runtime
        .complete(
            &intent,
            Receipt {
                request_id: ready.request_id.clone(),
                ticket,
                session_id: ready.session_id.clone(),
                outcome: Outcome::Ready,
            },
        )
        .unwrap();
    assert_eq!(
        receiver.try_recv().unwrap().unwrap().outcome,
        Outcome::Ready
    );
    runtime
        .finish(&intent, Outcome::Ready, "ready-run")
        .unwrap();
    assert!(!intent.wait_until_expired().await);
    tokio::time::advance(INTENT_TTL).await;
    assert!(runtime.admission("main", &ready.session_id).is_ok());
}

#[test]
fn stop_remains_allowed_when_background_start_is_denied_or_its_grant_is_revoked() {
    let db = Database::in_memory().unwrap();
    let plugin: atools_core::Plugin = serde_json::from_value(json!({
        "id":"stop-policy-plugin",
        "name":"Display Name",
        "version":"1.0.0",
        "path":"/inert",
        "enabled":true,
        "manifest":{"name":"policy-plugin","version":"1.0.0","main":"index.html"},
        "created_at":"now",
        "updated_at":"now"
    }))
    .unwrap();
    db.save_plugin(&plugin).unwrap();
    db.plugin_storage_set(
        &plugin.id,
        crate::plugin_data_runtime::BACKGROUND_STARTUP_KEY,
        &json!(["policy-plugin"]),
    )
    .unwrap();
    super::registry::sync(&db).unwrap();
    let start = super::registry::tool_name(&plugin.id, super::registry::Access::Start);
    let stop = super::registry::tool_name(&plugin.id, super::registry::Access::Stop);

    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &start).unwrap(),
        atools_core::agent::PermissionDecision::Confirm
    );
    db.grant_agent_tool("atools-ui", &start).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &start).unwrap(),
        atools_core::agent::PermissionDecision::Allow
    );
    db.revoke_agent_tool("atools-ui", &start).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &start).unwrap(),
        atools_core::agent::PermissionDecision::Confirm
    );

    crate::agent_tools::set_agent_scope_policy(&db, "plugin_background", "deny").unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &start).unwrap(),
        atools_core::agent::PermissionDecision::Deny
    );
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &stop).unwrap(),
        atools_core::agent::PermissionDecision::Allow
    );
}
