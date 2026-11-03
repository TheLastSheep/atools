use super::{
    handle_credit, parse_env_pairs, validate_request_fields, write_response_and_escalate,
    ChildEntry,
};
use crate::sidecar::node_children::error::RequestFailure;
use crate::sidecar::node_children::protocol::read_frame;
use crate::sidecar::node_children::spawn::{ChildCommand, ManagedChild};
use crate::sidecar::SidecarError;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::duplex;
use tokio::sync::mpsc;

#[test]
fn detached_spawn_rejects_unimplemented_fields_before_fork() {
    let request = json!({
        "id": 1,
        "op": "spawn",
        "file": "/node",
        "args": ["node"],
        "envPairs": [],
        "stdio": ["pipe", "pipe", "pipe"],
        "serialization": "json"
    });
    let error = validate_request_fields(&request, "spawn").unwrap_err();
    assert!(error.message.contains("serialization"));
}

#[test]
fn node_normalized_environment_assignments_preserve_equals_in_values() {
    let parsed = parse_env_pairs(Some(&json!([
        "PLAIN=value",
        "EXPRESSION=left=middle=right",
        "EMPTY="
    ])))
    .unwrap();

    assert_eq!(
        parsed,
        vec![
            ("PLAIN".to_string(), "value".to_string()),
            ("EXPRESSION".to_string(), "left=middle=right".to_string()),
            ("EMPTY".to_string(), String::new()),
        ]
    );
}

#[test]
fn environment_assignments_reject_malformed_duplicate_nul_and_oversized_entries() {
    let invalid_values = [
        json!(["MISSING_EQUALS"]),
        json!(["=value"]),
        json!(["DUP=one", "DUP=two"]),
        json!(["KEY\u{0000}=value"]),
        json!([format!("{}=value", "K".repeat(4097))]),
        json!([format!("KEY={}", "V".repeat(32 * 1024 + 1))]),
    ];

    for value in invalid_values {
        assert!(parse_env_pairs(Some(&value)).is_err(), "accepted {value}");
    }
}

#[tokio::test]
async fn fatal_post_spawn_cleanup_is_replied_then_escalated_to_owner() {
    let (mut writer, mut reader) = duplex(4096);
    let cleanup_error = SidecarError::Crashed("group disappearance was unconfirmed".into());
    let failure = RequestFailure::cleanup(
        RequestFailure::invalid("managed child startup failed"),
        cleanup_error.clone(),
    );

    let routed = write_response_and_escalate(&mut writer, 7, Err(failure)).await;
    assert_eq!(routed, Err(cleanup_error));
    let response = read_frame(&mut reader)
        .await
        .unwrap()
        .expect("ordinary protocol error response is sent before owner escalation");
    assert_eq!(response["id"], 7);
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "ERR_ATOOLS_CHILD_CLEANUP_FAILED");

    let ordinary = RequestFailure::invalid("bad request");
    assert_eq!(
        write_response_and_escalate(&mut writer, 8, Err(ordinary)).await,
        Ok(())
    );
    let response = read_frame(&mut reader).await.unwrap().unwrap();
    assert_eq!(response["ok"], false);
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("bad request"));
}

#[tokio::test]
async fn fatal_cleanup_route_does_not_replace_protocol_write_failures() {
    let (mut writer, reader) = duplex(1);
    drop(reader);
    let error = RequestFailure::cleanup(
        RequestFailure::invalid("startup failed"),
        SidecarError::Crashed("cleanup failed".into()),
    );
    let write_error = write_response_and_escalate(&mut writer, 1, Err(error))
        .await
        .expect_err("failed RPC write remains the observed transport failure");
    assert!(matches!(write_error, SidecarError::Crashed(_)));
}

#[tokio::test]
async fn credit_for_finished_child_is_an_accepted_noop() {
    let children = HashMap::from([(7, ChildEntry::Finished)]);
    let result = handle_credit(
        &json!({"childId":"7","stream":"stdout","count":32}),
        &children,
    )
    .await
    .unwrap();

    assert_eq!(result, json!({"accepted":true}));
}

#[tokio::test]
async fn credit_for_unknown_child_stays_an_error() {
    let error = handle_credit(
        &json!({"childId":"7","stream":"stdout","count":1}),
        &HashMap::new(),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "ERR_ATOOLS_CHILD_UNKNOWN");
}

#[tokio::test]
async fn invalid_credit_count_is_rejected_even_for_finished_child() {
    let children = HashMap::from([(7, ChildEntry::Finished)]);
    for count in [0, 33] {
        let error = handle_credit(
            &json!({"childId":"7","stream":"stdout","count":count}),
            &children,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "ERR_ATOOLS_CHILD_INVALID_REQUEST");
    }
}

#[tokio::test]
async fn credit_is_an_accepted_noop_when_running_command_channel_is_closed() {
    let (commands, receiver) = mpsc::channel(1);
    drop(receiver);
    let children = HashMap::from([(7, ChildEntry::Running(Arc::new(ManagedChild { commands })))]);

    let result = handle_credit(
        &json!({"childId":"7","stream":"stdout","count":1}),
        &children,
    )
    .await
    .unwrap();

    assert_eq!(result, json!({"accepted":true}));
}

#[tokio::test]
async fn credit_is_an_accepted_noop_when_running_actor_drops_response() {
    let (commands, mut receiver) = mpsc::channel(1);
    let actor = tokio::spawn(async move {
        if let Some(ChildCommand::Credit { response, .. }) = receiver.recv().await {
            drop(response);
        }
    });
    let children = HashMap::from([(7, ChildEntry::Running(Arc::new(ManagedChild { commands })))]);

    let result = handle_credit(
        &json!({"childId":"7","stream":"stdout","count":1}),
        &children,
    )
    .await
    .unwrap();
    actor.await.unwrap();

    assert_eq!(result, json!({"accepted":true}));
}

#[tokio::test]
async fn credit_preserves_real_actor_validation_errors() {
    let (commands, mut receiver) = mpsc::channel(1);
    let actor = tokio::spawn(async move {
        if let Some(ChildCommand::Credit { response, .. }) = receiver.recv().await {
            let _ = response.send(Err(RequestFailure::invalid(
                "stream credit budget exceeded",
            )));
        }
    });
    let children = HashMap::from([(7, ChildEntry::Running(Arc::new(ManagedChild { commands })))]);

    let error = handle_credit(
        &json!({"childId":"7","stream":"stdout","count":1}),
        &children,
    )
    .await
    .unwrap_err();
    actor.await.unwrap();

    assert_eq!(error.code, "ERR_ATOOLS_CHILD_INVALID_REQUEST");
    assert_eq!(error.message, "stream credit budget exceeded");
}
