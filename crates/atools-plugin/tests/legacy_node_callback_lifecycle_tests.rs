use std::path::Path;
use std::time::Duration;

use atools_plugin::legacy_node::LegacyNodeSession;
use serde_json::{json, Value};

fn value(input: impl Into<Value>) -> Value {
    json!({"kind":"value","value":input.into()})
}

async fn settled(session: &LegacyNodeSession, promise: &Value) -> Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = session
                .request("pollPromise", json!({"handleId":promise["handleId"]}))
                .await
                .unwrap();
            if state["state"] != "pending" {
                assert_eq!(state["state"], "fulfilled", "{state}");
                return state["value"].clone();
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("real fs Promise should settle promptly")
}

#[tokio::test]
async fn hundreds_of_fs_progress_calls_release_callbacks_without_losing_live_subscriptions() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("preload.cjs"),
        "throw new Error('do not execute');",
    )
    .unwrap();
    std::fs::write(temp.path().join("data.txt"), "real fs data").unwrap();
    std::fs::write(
        temp.path().join("helper.cjs"),
        r#"
      const fs = require('node:fs');
      const observers = [];
      module.exports = {
        observe(callback) { observers.push(callback); },
        read(file, progress) {
          return fs.promises.readFile(file, 'utf8').then(text => {
            for (const callback of observers) callback(text);
            progress(text);
            return text;
          });
        }
      };
    "#,
    )
    .unwrap();
    let session =
        LegacyNodeSession::start("callback-lifecycle", temp.path(), Path::new("preload.cjs"))
            .await
            .unwrap();
    let helper = session
        .request("require", json!({"specifier":"./helper.cjs"}))
        .await
        .unwrap();
    let observe = session
        .request(
            "get",
            json!({"handleId":helper["handleId"],"property":"observe"}),
        )
        .await
        .unwrap();
    let read = session
        .request(
            "get",
            json!({"handleId":helper["handleId"],"property":"read"}),
        )
        .await
        .unwrap();
    session
        .request(
            "call",
            json!({"handleId":observe["handleId"],"args":[{"kind":"callback","id":"observer"}]}),
        )
        .await
        .unwrap();
    let file = value(temp.path().join("data.txt").to_string_lossy().as_ref());

    for index in 0..300 {
        let callback_id = format!("progress-{index}");
        let promise = session.request("call", json!({"handleId":read["handleId"],"args":[file,{"kind":"callback","id":callback_id}]})).await.unwrap();
        assert_eq!(settled(&session, &promise).await, value("real fs data"));
        let polled = session.request("poll", json!({})).await.unwrap();
        assert_eq!(polled["overflowed"], false);
        let events = polled["events"].as_array().unwrap();
        assert_eq!(
            events.len(),
            2,
            "each active callback must survive cleanup of previous calls"
        );
        assert_eq!(
            events[0],
            json!({"callbackId":"observer","args":[value("real fs data")]})
        );
        assert_eq!(
            events[1],
            json!({"callbackId":callback_id,"args":[value("real fs data")]})
        );
        let released = session
            .request(
                "release",
                json!({"handleIds":[promise["handleId"]],"callbackIds":[callback_id]}),
            )
            .await
            .unwrap();
        assert_eq!(released["callbacksReleased"], 1);
    }

    // Reusing an explicitly released ID must not revive native closures that
    // still retain the previous callback with that same ID.
    session
        .request("release", json!({"callbackIds":["observer"]}))
        .await
        .unwrap();
    session
        .request(
            "call",
            json!({"handleId":observe["handleId"],"args":[{"kind":"callback","id":"observer"}]}),
        )
        .await
        .unwrap();
    let promise = session
        .request(
            "call",
            json!({"handleId":read["handleId"],"args":[file,{"kind":"callback","id":"last"}]}),
        )
        .await
        .unwrap();
    settled(&session, &promise).await;
    let polled = session.request("poll", json!({})).await.unwrap();
    assert_eq!(polled["events"].as_array().unwrap().len(), 2);

    // Release also discards notifications already queued for a revoked callback.
    let promise = session
        .request(
            "call",
            json!({"handleId":read["handleId"],"args":[file,{"kind":"callback","id":"queued"}]}),
        )
        .await
        .unwrap();
    settled(&session, &promise).await;
    session
        .request("release", json!({"callbackIds":["queued"]}))
        .await
        .unwrap();
    let polled = session.request("poll", json!({})).await.unwrap();
    assert_eq!(
        polled["events"],
        json!([{"callbackId":"observer","args":[value("real fs data")]}])
    );
    session.stop().await.unwrap();
}
