use atools_core::{Database, Plugin};
use serde_json::{json, Value};

fn database(features: Value) -> Database {
    let db = Database::in_memory().unwrap();
    let plugin = Plugin {
        id: "main-push-provider".into(),
        name: "Provider".into(),
        version: "1".into(),
        path: "/nonexistent/provider".into(),
        enabled: true,
        manifest: serde_json::from_value(json!({
            "name": "main-push-provider", "title": "Provider", "features": features
        }))
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    db
}

#[test]
fn discovery_name_does_not_start_an_unmatched_dynamic_provider() {
    let db = database(json!([{
        "code": "internal", "explain": "独立展示名称", "mainPush": true,
        "cmds": [{"type": "regex", "match": "/^abc$/"}]
    }]));
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert_eq!(snapshot.search_checked("独立展示名称").unwrap().len(), 1);
    assert!(snapshot
        .search_commands_checked("独立展示名称")
        .unwrap()
        .is_empty());
    let matches = snapshot.search_commands_checked("abc").unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].feature_code, "internal");
    assert_eq!(matches[0].match_type, "regex");
}

#[test]
fn dynamic_query_keeps_original_regex_type_when_display_name_matches_better() {
    let db = database(json!([{
        "code": "numeric", "explain": "12", "mainPush": true,
        "cmds": [{"type": "regex", "match": "/^[0-9]+$/"}]
    }]));
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        snapshot.search_checked("12").unwrap()[0].match_type,
        "exact"
    );
    let matches = snapshot.search_commands_checked("12").unwrap();
    assert_eq!(matches[0].match_type, "regex");
    assert_eq!(matches[0].plugin_id, "main-push-provider");
    assert_eq!(matches[0].feature_code, "numeric");
}
