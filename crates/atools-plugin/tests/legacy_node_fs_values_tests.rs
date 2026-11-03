use atools_plugin::legacy_node::LegacyNodeSession;
use serde_json::{json, Value};

async fn request(session: &LegacyNodeSession, method: &str, params: Value) -> Value {
    session.request(method, params).await.unwrap()
}

async fn call(session: &LegacyNodeSession, module: &Value, name: &str, args: Vec<Value>) -> Value {
    let function = request(
        session,
        "get",
        json!({"handleId":module["handleId"],"property":name}),
    )
    .await;
    request(
        session,
        "call",
        json!({"handleId":function["handleId"],"args":args}),
    )
    .await
}

#[tokio::test]
async fn native_stats_dirents_are_fresh_bounded_value_copies_and_roundtrip() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("preload.cjs"),
        "throw Error('not executed');",
    )
    .unwrap();
    std::fs::write(temp.path().join("value.txt"), "first").unwrap();
    std::fs::write(temp.path().join("helper.cjs"), r#"
      const fs = require('node:fs'), path = require('node:path');
      module.exports = {
        stat(bigint) { return fs.statSync(path.join(__dirname, 'value.txt'), {bigint}); },
        dirent() { return fs.readdirSync(__dirname, {withFileTypes:true, encoding:'buffer'}).find(x=>x.name.toString()==='value.txt'); },
        inspect(s, d) { return [s.isFile(), s.isDirectory(), typeof s.mode, s.size, d.isFile(), Buffer.isBuffer(d.name), d.name.toString()]; },
        custom() { const s=fs.statSync(__dirname); s.isDirectory=()=>false; return s; },
        accessor() { const s=fs.statSync(__dirname); Object.defineProperty(s, 'size', {get(){throw Error('must not inspect')}}); return s; },
        direntAccessor() { const d=fs.readdirSync(__dirname,{withFileTypes:true})[0]; Object.defineProperty(d,Object.getOwnPropertySymbols(d)[0],{get(){throw Error('must not inspect symbol')}}); return d; },
        changedPrototype() { fs.Stats.prototype.isDirectory=()=>false; return fs.statSync(__dirname); }
      };
    "#).unwrap();
    let session = LegacyNodeSession::start(
        "fs-values",
        temp.path(),
        std::path::Path::new("preload.cjs"),
    )
    .await
    .unwrap();
    let helper = request(&session, "require", json!({"specifier":"./helper.cjs"})).await;
    let normal = call(
        &session,
        &helper,
        "stat",
        vec![json!({"kind":"value","value":false})],
    )
    .await;
    assert_eq!(normal["kind"], "fsStats");
    assert_eq!(
        normal["properties"]["size"],
        json!({"kind":"value","value":5})
    );
    let mut bigint = call(
        &session,
        &helper,
        "stat",
        vec![json!({"kind":"value","value":true})],
    )
    .await;
    assert_eq!(bigint["kind"], "fsStats");
    assert_eq!(bigint["properties"]["mode"]["kind"], "bigint");
    // A local copied Stats can be edited and passed back as a real native value.
    bigint["properties"]["mode"] = json!({"kind":"bigint","value":"16384"});
    let dirent = call(&session, &helper, "dirent", vec![]).await;
    assert_eq!(dirent["kind"], "fsDirent");
    assert_eq!(dirent["properties"]["name"]["kind"], "buffer");
    let inspected = call(&session, &helper, "inspect", vec![bigint, dirent]).await;
    let values: Vec<_> = inspected["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["value"].clone())
        .collect();
    assert_eq!(
        values,
        vec![
            json!(false),
            json!(true),
            json!("bigint"),
            json!("5"),
            json!(true),
            json!(true),
            json!("value.txt")
        ]
    );
    assert_eq!(inspected["items"][3], json!({"kind":"bigint","value":"5"}));
    std::fs::write(temp.path().join("value.txt"), "longer actual file").unwrap();
    let fresh = call(
        &session,
        &helper,
        "stat",
        vec![json!({"kind":"value","value":false})],
    )
    .await;
    assert_eq!(fresh["properties"]["size"]["value"], 18);
    // Custom methods/accessors/native prototype changes retain live handles.
    for method in ["custom", "accessor", "direntAccessor", "changedPrototype"] {
        assert_eq!(
            call(&session, &helper, method, vec![]).await["kind"],
            "handle"
        );
    }
    session.stop().await.unwrap();
}
