use std::path::Path;
use std::time::Duration;

use atools_plugin::legacy_node::LegacyNodeSession;
use atools_plugin::sidecar::{SidecarError, SidecarStatus};
use serde_json::{json, Value};
use tempfile::TempDir;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

fn fixture() -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("preload.cjs"),
        "throw new Error('preload must stay in the UI');",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("helper.cjs"),
        r#"
      let sharedPromise;
      let proxyInspections = 0;
      module.exports = {
        resolved(value) { return Promise.resolve(value); },
        pending() { return new Promise(() => {}); },
        rejection() { return Promise.reject(Object.assign(new Error('fixture rejection'), { code: 'FIXTURE_ERROR' })); },
        oversizedBinary() { return Promise.resolve(Buffer.alloc(800 * 1024)); },
        largeString(length) { return Promise.resolve('x'.repeat(length)); },
        escapedText(count) { return Promise.resolve((String.fromCharCode(0) + '保存✨' + String.fromCharCode(10) + '"quote"').repeat(count)); },
        many(count) { return Array.from({ length: count }, (_, index) => Promise.resolve(index)); },
        samePromise() { return sharedPromise || (sharedPromise = Promise.resolve('same')); },
        trapped() { return Promise.resolve(new Proxy({}, { ownKeys() { proxyInspections++; return []; } })); },
        get proxyInspections() { return proxyInspections; },
        plain() { return { value: 'not a Promise' }; }
      };
    "#,
    )
    .unwrap();
    temp
}

async fn start(temp: &TempDir) -> LegacyNodeSession {
    LegacyNodeSession::start(
        "promise-polling-fixture",
        temp.path(),
        Path::new("preload.cjs"),
    )
    .await
    .unwrap()
}

async fn require(session: &LegacyNodeSession) -> Value {
    session
        .request("require", json!({ "specifier": "./helper.cjs" }))
        .await
        .unwrap()
}

async fn get(session: &LegacyNodeSession, target: &Value, property: &str) -> Value {
    session
        .request(
            "get",
            json!({ "handleId": target["handleId"], "property": property }),
        )
        .await
        .unwrap()
}

async fn call(session: &LegacyNodeSession, function: &Value, args: Vec<Value>) -> Value {
    session
        .request(
            "call",
            json!({ "handleId": function["handleId"], "args": args }),
        )
        .await
        .unwrap()
}

fn value(input: impl Into<Value>) -> Value {
    json!({ "kind": "value", "value": input.into() })
}

fn handle_id(value: &Value) -> u64 {
    value["handleId"].as_u64().unwrap()
}

fn assert_remote_error(error: SidecarError, expected: &str) {
    assert!(matches!(&error, SidecarError::Remote { .. }), "{error:?}");
    assert!(error.to_string().contains(expected), "{error}");
}

async fn assert_batch_error(session: &LegacyNodeSession, params: Value, expected: &str) {
    assert_remote_error(
        session.request("pollPromises", params).await.unwrap_err(),
        expected,
    );
}

#[tokio::test]
async fn batch_poll_preserves_mixed_states_order_identity_and_validation() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session).await;

    let resolved_text = "ready 保存✨\n\"quoted\"";
    let resolved = call(
        &session,
        &get(&session, &helper, "resolved").await,
        vec![value(resolved_text)],
    )
    .await;
    let pending = call(&session, &get(&session, &helper, "pending").await, vec![]).await;
    let rejected = call(&session, &get(&session, &helper, "rejection").await, vec![]).await;
    let encode_error = call(
        &session,
        &get(&session, &helper, "oversizedBinary").await,
        vec![],
    )
    .await;
    let first_shared = call(
        &session,
        &get(&session, &helper, "samePromise").await,
        vec![],
    )
    .await;
    let second_shared = call(
        &session,
        &get(&session, &helper, "samePromise").await,
        vec![],
    )
    .await;
    assert_eq!(handle_id(&first_shared), handle_id(&second_shared));

    let ids = [resolved, pending, rejected, encode_error, first_shared]
        .iter()
        .map(handle_id)
        .collect::<Vec<_>>();
    let batch = session
        .request("pollPromises", json!({ "handleIds": ids }))
        .await
        .unwrap();
    assert_eq!(batch["fallback"], json!([]));
    let states = batch["states"].as_array().unwrap();
    assert_eq!(states.len(), 5);
    for (entry, expected_id) in states.iter().zip(ids.iter()) {
        assert_eq!(entry["handleId"], json!(expected_id));
    }
    assert_eq!(states[0]["state"]["state"], "fulfilled");
    assert_eq!(states[0]["state"]["value"], value(resolved_text));
    assert_eq!(states[1]["state"], json!({ "state": "pending" }));
    assert_eq!(states[2]["state"]["state"], "rejected");
    assert_eq!(states[2]["state"]["error"]["code"], "FIXTURE_ERROR");
    assert_eq!(states[3]["state"]["state"], "rejected");
    assert!(states[3]["state"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("ERR_ATOOLS_NODE_VALUE_BUDGET"));
    assert_eq!(states[4]["state"]["state"], "fulfilled");
    let batch_bytes = serde_json::to_vec(&batch).unwrap().len();
    assert!(batch_bytes + 4096 <= MAX_RESPONSE_BYTES);

    assert_batch_error(
        &session,
        json!({ "handleIds": [] }),
        "INVALID_PROMISE_BATCH",
    )
    .await;
    assert_batch_error(
        &session,
        json!({ "handleIds": [ids[0], ids[0]] }),
        "INVALID_PROMISE_BATCH",
    )
    .await;
    assert_batch_error(
        &session,
        json!({ "handleIds": [0] }),
        "INVALID_PROMISE_BATCH",
    )
    .await;
    assert_batch_error(
        &session,
        json!({ "handleIds": [-1] }),
        "INVALID_PROMISE_BATCH",
    )
    .await;
    assert_batch_error(
        &session,
        json!({ "handleIds": [9_007_199_254_740_992_u64] }),
        "INVALID_PROMISE_BATCH",
    )
    .await;
    assert_batch_error(
        &session,
        json!({ "handleIds": [ids[0]], "extra": true }),
        "INVALID_PROMISE_BATCH",
    )
    .await;
    let too_many = (0..33).map(|_| json!(ids[0])).collect::<Vec<_>>();
    assert_batch_error(
        &session,
        json!({ "handleIds": too_many }),
        "INVALID_PROMISE_BATCH",
    )
    .await;
    assert_batch_error(
        &session,
        json!({ "handleIds": [9_000_000_u64] }),
        "UNKNOWN_HANDLE",
    )
    .await;
    let trapped = call(&session, &get(&session, &helper, "trapped").await, vec![]).await;
    assert_batch_error(
        &session,
        json!({ "handleIds": [handle_id(&trapped), 9_000_000_u64] }),
        "UNKNOWN_HANDLE",
    )
    .await;
    assert_eq!(get(&session, &helper, "proxyInspections").await["value"], 0);
    assert_eq!(
        session
            .request("pollPromise", json!({ "handleId": handle_id(&trapped) }),)
            .await
            .unwrap()["state"],
        "fulfilled"
    );
    assert_eq!(get(&session, &helper, "proxyInspections").await["value"], 1);
    assert_batch_error(
        &session,
        json!({ "handleIds": [handle_id(&helper)] }),
        "NOT_PROMISE",
    )
    .await;

    let many = call(
        &session,
        &get(&session, &helper, "many").await,
        vec![value(32)],
    )
    .await;
    let many_ids = many["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(handle_id)
        .collect::<Vec<_>>();
    assert_eq!(many_ids.len(), 32);
    let accepted = session
        .request("pollPromises", json!({ "handleIds": many_ids }))
        .await
        .unwrap();
    assert_eq!(accepted["states"].as_array().unwrap().len(), 32);

    let released_id = ids[0];
    let release = session
        .request("release", json!({ "handleIds": [released_id] }))
        .await
        .unwrap();
    assert_eq!(release["released"], 1);
    assert_batch_error(
        &session,
        json!({ "handleIds": [released_id] }),
        "UNKNOWN_HANDLE",
    )
    .await;
    session.stop().await.unwrap();
    assert_eq!(session.status(), SidecarStatus::Stopped);
}

#[tokio::test]
async fn escaped_utf8_states_fit_reserved_batch_budget_and_fallback_recovers() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session).await;
    let first = call(
        &session,
        &get(&session, &helper, "escapedText").await,
        vec![value(15_000)],
    )
    .await;
    let second = call(
        &session,
        &get(&session, &helper, "escapedText").await,
        vec![value(15_000)],
    )
    .await;
    let third = call(
        &session,
        &get(&session, &helper, "escapedText").await,
        vec![value(15_000)],
    )
    .await;
    let ids = [handle_id(&first), handle_id(&second), handle_id(&third)];
    let expected_text = "\0保存✨\n\"quote\"".repeat(15_000);

    let mut batch = Value::Null;
    for _ in 0..100 {
        batch = session
            .request("pollPromises", json!({ "handleIds": ids }))
            .await
            .unwrap();
        if batch["fallback"]
            .as_array()
            .unwrap()
            .contains(&json!(ids[2]))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(batch["fallback"], json!([ids[2]]));
    let states = batch["states"].as_array().unwrap();
    assert_eq!(states.len(), 2);
    for (entry, expected_id) in states.iter().zip(ids.iter()) {
        assert_eq!(entry["handleId"], json!(expected_id));
        assert_eq!(entry["state"]["state"], "fulfilled");
        assert_eq!(entry["state"]["value"]["value"], expected_text);
    }
    let result_bytes = serde_json::to_vec(&batch).unwrap().len();
    assert!(result_bytes + 4096 <= MAX_RESPONSE_BYTES);

    let recovered = session
        .request("pollPromise", json!({ "handleId": ids[2] }))
        .await
        .unwrap();
    assert_eq!(recovered["state"], "fulfilled");
    assert_eq!(recovered["value"]["value"], expected_text);
    let single_frame = json!({ "jsonrpc": "2.0", "id": u64::MAX, "result": recovered });
    assert!(serde_json::to_vec(&single_frame).unwrap().len() <= MAX_RESPONSE_BYTES);

    let release = session
        .request("release", json!({ "handleIds": ids }))
        .await
        .unwrap();
    assert_eq!(release["released"], 3);
    session.stop().await.unwrap();
    assert_eq!(session.status(), SidecarStatus::Stopped);
}

#[tokio::test]
async fn oversized_batch_item_falls_back_and_single_poll_keeps_the_one_mib_limit() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session).await;
    let large = call(
        &session,
        &get(&session, &helper, "largeString").await,
        vec![value(1_046_000)],
    )
    .await;
    let small = call(
        &session,
        &get(&session, &helper, "resolved").await,
        vec![value("still included")],
    )
    .await;
    let large_id = handle_id(&large);
    let small_id = handle_id(&small);

    let mut batch = Value::Null;
    for _ in 0..100 {
        batch = session
            .request("pollPromises", json!({ "handleIds": [large_id, small_id] }))
            .await
            .unwrap();
        if batch["fallback"]
            .as_array()
            .unwrap()
            .contains(&json!(large_id))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(batch["fallback"], json!([large_id]));
    assert_eq!(batch["states"].as_array().unwrap().len(), 1);
    assert_eq!(batch["states"][0]["handleId"], json!(small_id));
    assert_eq!(batch["states"][0]["state"]["state"], "fulfilled");

    let large_state = session
        .request("pollPromise", json!({ "handleId": large_id }))
        .await
        .unwrap();
    let large_text = large_state["value"]["value"].as_str().unwrap();
    assert_eq!(large_text.len(), 1_046_000);

    let single_frame = json!({
        "jsonrpc": "2.0",
        "id": u64::MAX,
        "result": large_state,
    });
    let single_frame_bytes = serde_json::to_vec(&single_frame).unwrap().len();
    assert!(single_frame_bytes <= MAX_RESPONSE_BYTES);
    let batch_state = json!({
        "states": [{ "handleId": large_id, "state": large_state }],
        "fallback": [],
    });
    let batch_result_bytes = serde_json::to_vec(&batch_state).unwrap().len();
    assert!(batch_result_bytes + 4096 > MAX_RESPONSE_BYTES);

    let release = session
        .request("release", json!({ "handleIds": [large_id, small_id] }))
        .await
        .unwrap();
    assert_eq!(release["released"], 2);
    assert_batch_error(
        &session,
        json!({ "handleIds": [large_id] }),
        "UNKNOWN_HANDLE",
    )
    .await;
    session.stop().await.unwrap();
    assert_eq!(session.status(), SidecarStatus::Stopped);
}
