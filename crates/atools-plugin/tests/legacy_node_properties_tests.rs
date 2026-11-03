use atools_plugin::legacy_node::LegacyNodeSession;
use serde_json::{json, Value};

async fn set(
    session: &LegacyNodeSession,
    id: &Value,
    name: &str,
    value: Value,
) -> Result<Value, String> {
    session
        .request("set", json!({"handleId":id,"property":name,"value":value}))
        .await
        .map_err(|e| e.to_string())
}
fn value(value: i64) -> Value {
    json!({"kind":"value","value":value})
}

#[tokio::test]
async fn property_writes_reach_real_node_and_obey_descriptors_and_callback_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("preload.cjs"),
        "throw Error('must remain local');",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("helper.cjs"),
        r#"
      let stored=0, retained;
      const target={
        value:1,
        get doubled(){return stored*2},
        set doubled(value){stored=value},
        set throws(value){throw Error('real setter throw')},
        set callsCallback(value){retained('setter callback')},
        retain(cb){retained=cb}
      };
      Object.defineProperty(target,'readonly',{value:42,writable:false});
      module.exports=target;
    "#,
    )
    .unwrap();
    let session = LegacyNodeSession::start(
        "properties",
        temp.path(),
        std::path::Path::new("preload.cjs"),
    )
    .await
    .unwrap();
    let target = session
        .request("require", json!({"specifier":"./helper.cjs"}))
        .await
        .unwrap();
    let id = &target["handleId"];
    assert_eq!(set(&session, id, "value", value(17)).await.unwrap(), true);
    assert_eq!(
        session
            .request("get", json!({"handleId":id,"property":"value"}))
            .await
            .unwrap()["value"],
        17
    );
    assert_eq!(set(&session, id, "doubled", value(9)).await.unwrap(), true);
    assert_eq!(
        session
            .request("get", json!({"handleId":id,"property":"doubled"}))
            .await
            .unwrap()["value"],
        18
    );
    assert_eq!(
        set(&session, id, "readonly", value(9)).await.unwrap(),
        false
    );
    assert!(set(&session, id, "throws", value(9))
        .await
        .unwrap_err()
        .contains("real setter throw"));
    for name in ["constructor", "__proto__", "prototype"] {
        assert!(set(&session, id, name, value(9))
            .await
            .unwrap_err()
            .contains("PROPERTY_DENIED"));
    }
    for argument in [
        json!({"kind":"callback","id":"forbidden"}),
        json!({"kind":"object","properties":{"cb":{"kind":"callback","id":"nested"}}}),
    ] {
        assert!(set(&session, id, "value", argument)
            .await
            .unwrap_err()
            .contains("SET_CALLBACK_UNSUPPORTED"));
    }
    let retain = session
        .request("get", json!({"handleId":id,"property":"retain"}))
        .await
        .unwrap();
    assert!(set(&session, id, "value", retain.clone())
        .await
        .unwrap_err()
        .contains("SET_CALLBACK_UNSUPPORTED"));
    session
        .request(
            "call",
            json!({"handleId":retain["handleId"],"args":[{"kind":"callback","id":"retained"}]}),
        )
        .await
        .unwrap();
    assert!(set(&session, id, "callsCallback", value(9))
        .await
        .unwrap_err()
        .contains("SYNC_CALLBACK_UNSUPPORTED"));
    assert_eq!(
        session.request("poll", json!({})).await.unwrap()["events"],
        json!([])
    );
    session.stop().await.unwrap();
}
