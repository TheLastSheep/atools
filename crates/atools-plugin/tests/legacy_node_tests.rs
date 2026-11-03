use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atools_plugin::legacy_node::LegacyNodeSession;
use atools_plugin::sidecar::{SidecarError, SidecarStatus};
use serde_json::{json, Value};
use tempfile::TempDir;

fn fixture() -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("preload.cjs"),
        "throw new Error('preload must stay in the UI');",
    )
    .unwrap();
    std::fs::write(temp.path().join("helper.cjs"), r#"
      let state = 0;
      class Counter { constructor(value) { this.value = value; } add(n) { this.value += n; return this; } }
      module.exports = {
        Counter,
        increment() { return ++state; },
        same() { return this; },
        reflect(...args) { return args; },
        delayed(value) { return new Promise((resolve) => setTimeout(() => resolve(value), 20)); },
        rejection() { return Promise.reject(Object.assign(new Error('fixture rejection'), { code: 'FIXTURE_ERROR' })); },
        callback(cb) { setTimeout(() => cb(null, Buffer.from('callback')), 10); },
        predicate(cb) { return [1, 2].filter(cb); },
        get dangerous() { throw new Error('getter evaluated explicitly'); },
        hang() { for (;;) {} },
        noise() { process.stdout.write('x'.repeat(9 * 1024 * 1024)); return 1; },
        huge() { return Buffer.alloc(1024 * 1024); }
      };
    "#).unwrap();
    temp
}

async fn start(temp: &TempDir) -> LegacyNodeSession {
    LegacyNodeSession::start("temp-fixture", temp.path(), Path::new("preload.cjs"))
        .await
        .unwrap()
}

async fn require(session: &LegacyNodeSession, name: &str) -> Value {
    session
        .request("require", json!({ "specifier": name }))
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

async fn call(session: &LegacyNodeSession, target: &Value, args: Vec<Value>) -> Value {
    session
        .request(
            "call",
            json!({ "handleId": target["handleId"], "args": args }),
        )
        .await
        .unwrap()
}

fn value(input: impl Into<Value>) -> Value {
    json!({ "kind": "value", "value": input.into() })
}

#[tokio::test]
async fn real_node_builtins_and_relative_modules_keep_state_and_chain_identity() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session, "./helper.cjs").await;
    assert_eq!(
        require(&session, "./helper.cjs").await["handleId"],
        helper["handleId"]
    );
    assert_eq!(
        call(&session, &get(&session, &helper, "increment").await, vec![]).await,
        value(1)
    );
    assert_eq!(
        call(&session, &get(&session, &helper, "increment").await, vec![]).await,
        value(2)
    );
    assert_eq!(
        call(&session, &get(&session, &helper, "same").await, vec![]).await["handleId"],
        helper["handleId"]
    );

    let crypto = require(&session, "node:crypto").await;
    let hash = call(
        &session,
        &get(&session, &crypto, "createHash").await,
        vec![value("sha256")],
    )
    .await;
    let updated = call(
        &session,
        &get(&session, &hash, "update").await,
        vec![value("abc")],
    )
    .await;
    assert_eq!(updated["handleId"], hash["handleId"]);
    let digest = call(
        &session,
        &get(&session, &hash, "digest").await,
        vec![value("hex")],
    )
    .await;
    assert_eq!(
        digest,
        value("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );

    let file = temp.path().join("fixture.txt");
    std::fs::write(&file, "real-node-fs").unwrap();
    let fs = require(&session, "node:fs").await;
    let result = call(
        &session,
        &get(&session, &fs, "readFileSync").await,
        vec![value(file.to_string_lossy().as_ref()), value("utf8")],
    )
    .await;
    assert_eq!(result, value("real-node-fs"));
    session.stop().await.unwrap();
    assert_eq!(session.status(), SidecarStatus::Stopped);
}

#[tokio::test]
async fn construct_binary_dates_typed_arrays_errors_and_plain_arguments_roundtrip() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session, "./helper.cjs").await;
    let constructor = get(&session, &helper, "Counter").await;
    let counter = session
        .request(
            "construct",
            json!({ "handleId": constructor["handleId"], "args": [value(10)] }),
        )
        .await
        .unwrap();
    assert_eq!(
        call(
            &session,
            &get(&session, &counter, "add").await,
            vec![value(5)]
        )
        .await["handleId"],
        counter["handleId"]
    );
    assert_eq!(get(&session, &counter, "value").await, value(15));
    let arguments = vec![
        json!({"kind":"buffer","data":"aGVsbG8="}),
        json!({"kind":"date","value":"2026-10-15T00:00:00.000Z"}),
        json!({"kind":"typedArray","name":"Uint16Array","data":"AQACAA=="}),
        json!({"kind":"typedArray","name":"DataView","data":"AQI="}),
        json!({"kind":"typedArray","name":"ArrayBuffer","data":"AwQ="}),
        json!({"kind":"bigint","value":"9007199254740993"}),
        json!({"kind":"number","value":"NaN"}),
        json!({"kind":"error","name":"Error","message":"expected","code":"EXPECTED"}),
        json!({"kind":"object","properties":{"field":value("local-options")}}),
    ];
    let result = call(
        &session,
        &get(&session, &helper, "reflect").await,
        arguments.clone(),
    )
    .await;
    for index in 0..8 {
        assert_eq!(result["items"][index], arguments[index]);
    }
    assert_eq!(
        get(&session, &result["items"][8], "field").await,
        value("local-options")
    );
    session.stop().await.unwrap();
}

#[tokio::test]
async fn promises_and_callbacks_are_polled_without_blocking_other_requests() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session, "./helper.cjs").await;
    let promise = call(
        &session,
        &get(&session, &helper, "delayed").await,
        vec![value("resolved")],
    )
    .await;
    assert_eq!(promise["kind"], "promise");
    let callback_result = call(
        &session,
        &get(&session, &helper, "callback").await,
        vec![json!({ "kind": "callback", "id": "fixture-callback" })],
    )
    .await;
    assert_eq!(callback_result["kind"], "undefined");
    let predicate = get(&session, &helper, "predicate").await;
    let unsupported = session
        .request(
            "call",
            json!({"handleId":predicate["handleId"],"args":[{"kind":"callback","id":"predicate"}]}),
        )
        .await
        .unwrap_err();
    assert!(unsupported
        .to_string()
        .contains("SYNC_CALLBACK_UNSUPPORTED"));
    let rejected = call(&session, &get(&session, &helper, "rejection").await, vec![]).await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    let settled = session
        .request("pollPromise", json!({"handleId": promise["handleId"]}))
        .await
        .unwrap();
    assert_eq!(
        settled,
        json!({"state":"fulfilled","value":value("resolved")})
    );
    assert_eq!(
        session
            .request("pollPromise", json!({"handleId": promise["handleId"]}))
            .await
            .unwrap(),
        settled
    );
    let rejected = session
        .request("pollPromise", json!({"handleId": rejected["handleId"]}))
        .await
        .unwrap();
    assert_eq!(rejected["state"], "rejected");
    assert_eq!(rejected["error"]["code"], "FIXTURE_ERROR");
    let events = session.request("poll", json!({})).await.unwrap();
    assert_eq!(events["overflowed"], false);
    assert_eq!(
        events["events"][0],
        json!({"callbackId":"fixture-callback","args":[value(Value::Null),{"kind":"buffer","data":"Y2FsbGJhY2s="}]})
    );
    assert_eq!(
        session.request("poll", json!({})).await.unwrap()["events"],
        json!([])
    );
    session.stop().await.unwrap();
}

#[tokio::test]
async fn inspection_never_calls_getters_and_errors_do_not_pretend_host_support() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session, "./helper.cjs").await;
    assert!(helper["keys"]
        .as_array()
        .unwrap()
        .contains(&json!("dangerous")));
    let getter = session
        .request(
            "get",
            json!({"handleId":helper["handleId"],"property":"dangerous"}),
        )
        .await
        .unwrap_err();
    assert!(getter.to_string().contains("getter evaluated explicitly"));
    let denied = session
        .request(
            "get",
            json!({"handleId":helper["handleId"],"property":"constructor"}),
        )
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("PROPERTY_DENIED"));
    assert!(session
        .request("require", json!({"specifier":"electron"}))
        .await
        .unwrap_err()
        .to_string()
        .contains("HOST_API_UNAVAILABLE"));
    assert!(session
        .request("require", json!({"specifier":"fixture-does-not-exist"}))
        .await
        .is_err());
    let huge = get(&session, &helper, "huge").await;
    assert!(session
        .request("call", json!({"handleId":huge["handleId"],"args":[]}))
        .await
        .unwrap_err()
        .to_string()
        .contains("VALUE_BUDGET"));
    let released = session
        .request("release", json!({"handleIds":[helper["handleId"]]}))
        .await
        .unwrap();
    assert_eq!(released["released"], 1);
    assert!(session
        .request(
            "get",
            json!({"handleId":helper["handleId"],"property":"same"})
        )
        .await
        .is_err());
    session.stop().await.unwrap();
}

#[tokio::test]
async fn stop_interrupts_a_busy_node_without_waiting_on_the_call_lock() {
    let temp = fixture();
    let session = Arc::new(start(&temp).await);
    let helper = require(&session, "./helper.cjs").await;
    let hang = get(&session, &helper, "hang").await;
    let caller = session.clone();
    let pending = tokio::spawn(async move {
        caller
            .request("call", json!({"handleId":hang["handleId"],"args":[]}))
            .await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    let started = Instant::now();
    session.stop().await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(pending.await.unwrap().is_err());
    assert_eq!(session.status(), SidecarStatus::Stopped);
}

#[tokio::test]
async fn unbounded_stdout_without_a_newline_terminates_the_process() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session, "./helper.cjs").await;
    let noise = get(&session, &helper, "noise").await;
    let error = session
        .request("call", json!({"handleId":noise["handleId"],"args":[]}))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        SidecarError::Protocol(_) | SidecarError::Crashed(_)
    ));
    assert_ne!(session.status(), SidecarStatus::Running);
}

#[tokio::test]
async fn request_timeout_kills_a_nonresponsive_process() {
    let temp = fixture();
    let session = start(&temp).await;
    let helper = require(&session, "./helper.cjs").await;
    let hang = get(&session, &helper, "hang").await;
    let error = session
        .request("call", json!({"handleId":hang["handleId"],"args":[]}))
        .await
        .unwrap_err();
    assert!(matches!(error, SidecarError::Timeout(5000)));
    assert_eq!(session.status(), SidecarStatus::Stopped);
}

#[tokio::test]
async fn stop_stays_bounded_when_a_busy_node_fills_its_stdin_pipe() {
    let temp = fixture();
    let session = Arc::new(start(&temp).await);
    let helper = require(&session, "./helper.cjs").await;
    let hang = get(&session, &helper, "hang").await;
    let reflect = get(&session, &helper, "reflect").await;
    let busy_session = session.clone();
    let busy = tokio::spawn(async move {
        busy_session
            .request("call", json!({"handleId":hang["handleId"],"args":[]}))
            .await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    let blocked_session = session.clone();
    let blocked = tokio::spawn(async move {
        blocked_session
            .request(
                "call",
                json!({"handleId":reflect["handleId"],"args":[value("x".repeat(512 * 1024))]}),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let started = Instant::now();
    tokio::time::timeout(Duration::from_millis(1500), session.stop())
        .await
        .expect("stop must not remain queued behind an unbounded pipe write")
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert!(busy.await.unwrap().is_err());
    assert!(blocked.await.unwrap().is_err());
    assert_ne!(session.status(), SidecarStatus::Running);
}
