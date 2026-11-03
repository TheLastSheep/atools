use atools_api_shim::handler::ApiHandler;
use atools_core::{Database, Plugin};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn actual_feature_dispatch_invalidates_shared_snapshot_and_preserves_explicit_code_label() {
    let directory = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::in_memory().unwrap());
    let plugin = Plugin {
        id: "hash".into(),
        name: "hash".into(),
        version: "1".into(),
        path: directory.path().to_string_lossy().to_string(),
        enabled: true,
        manifest: serde_json::from_value(
            json!({"name":"hash","title":"摘要工具","features":[{"code":"static-hash","label":"静态摘要"}]}),
        )
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    let handler = ApiHandler::new(db.clone(), directory.path().to_path_buf());
    let old = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        handler
            .handle("hash", "features.get", vec![])
            .await
            .unwrap(),
        json!([])
    );
    handler
        .handle(
            "hash",
            "features.set",
            vec![json!([{"code":"MD5","label":"MD5","explain":"摘要说明","cmds":["md5"]}])],
        )
        .await
        .unwrap();
    let current = db.feature_catalog_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&old, &current));
    assert_eq!(current.find("hash", "MD5").unwrap().display_label, "MD5");
    assert_eq!(current.search("md5")[0].feature_code, "MD5");
    assert!(current.find("hash", "static-hash").is_some());
    assert_eq!(
        handler
            .handle("hash", "features.get", vec![json!(["MD5"])])
            .await
            .unwrap()[0]["label"],
        "MD5"
    );
    handler
        .handle("hash", "features.remove", vec![json!("MD5")])
        .await
        .unwrap();
    let after = db.feature_catalog_snapshot().unwrap();
    assert!(after.find("hash", "MD5").is_none());
    assert_eq!(
        after.find("hash", "static-hash").unwrap().display_label,
        "静态摘要"
    );
}

fn setup() -> (Arc<Database>, ApiHandler) {
    let db = Arc::new(Database::in_memory().unwrap());
    let plugin = Plugin {
        id: "local".into(),
        name: "local".into(),
        version: "1".into(),
        path: "/unused/local".into(),
        enabled: true,
        manifest: serde_json::from_value(
            json!({"name":"local","features":[{"code":"reserved","cmds":["保留"]}]}),
        )
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    let handler = ApiHandler::new(db.clone(), "/unused".into());
    (db, handler)
}

#[tokio::test]
async fn standard_object_upsert_preserves_dynamic_json_and_identical_updates_keep_warm_catalog() {
    let (db, handler) = setup();
    let declaration = json!({"code":"open@fixed","explain":"网址", "cmds":["本地书签"],
        "icon":"tag.png","mainHide":true,"platform":["darwin","win32","linux"],"custom":{"kept":true}});
    assert_eq!(
        handler
            .handle("local", "features.set", vec![declaration.clone()])
            .await
            .unwrap(),
        json!(true)
    );
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert_eq!(snapshot.search("本地书签")[0].feature_code, "open@fixed");
    assert_eq!(
        handler
            .handle("local", "features.get", vec![])
            .await
            .unwrap(),
        json!([declaration.clone()])
    );
    assert_eq!(
        handler
            .handle("local", "features.get", vec![json!([])])
            .await
            .unwrap(),
        json!([])
    );
    assert_eq!(
        handler
            .handle("local", "features.set", vec![declaration])
            .await
            .unwrap(),
        json!(true)
    );
    assert!(Arc::ptr_eq(
        &snapshot,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert_eq!(
        handler
            .handle("local", "features.remove", vec![json!("open@fixed")])
            .await
            .unwrap(),
        json!(true)
    );
    assert_eq!(
        handler
            .handle("local", "features.remove", vec![json!("missing")])
            .await
            .unwrap(),
        json!(false)
    );
    assert!(db
        .feature_catalog_snapshot()
        .unwrap()
        .search("本地书签")
        .is_empty());
    assert!(db.get_feature("reserved").is_ok());
}

#[tokio::test]
async fn dispatcher_rejects_invalid_shapes_and_rolls_back_reserved_code_collisions() {
    let (db, handler) = setup();
    for (method, args) in [
        ("features.get", vec![json!("not-an-array")]),
        ("features.get", vec![json!([1])]),
        ("features.get", vec![json!([]), json!([])]),
        ("features.set", vec![]),
        ("features.set", vec![json!(null)]),
        ("features.remove", vec![json!([1])]),
    ] {
        assert!(handler.handle("local", method, args).await.is_err());
    }
    assert!(handler
        .handle(
            "local",
            "features.set",
            vec![json!([
                {"code":"uncommitted", "cmds":["未提交"]}, {"code":"reserved","cmds":["覆盖"]}
            ])]
        )
        .await
        .is_err());
    assert_eq!(
        handler
            .handle("local", "features.get", vec![])
            .await
            .unwrap(),
        json!([])
    );
    assert!(db.get_feature("uncommitted").is_err());
    assert_eq!(db.get_feature("reserved").unwrap().cmds.len(), 1);
}
