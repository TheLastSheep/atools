use super::*;
use atools_core::{Database, Plugin};
use serde_json::json;
use std::sync::Arc;

fn db() -> Database {
    let db = Database::in_memory().unwrap();
    let plugin = Plugin {
        id: "content".into(), name: "content".into(), version: "1".into(), enabled: true,
        path: "/not-executed".into(), created_at: "now".into(), updated_at: "now".into(),
        manifest: serde_json::from_value(json!({"name":"content", "title":"格式工具", "features":[
            {"code":"mixed", "label":"JSON 整理", "explain":"整理文本", "cmds":["json", "别名", {"type":"regex", "label":"JSON 内容", "match":"/^json$/i"}, {"type":"over", "maxLength":20}]},
            {"code":"name", "cmds":["json"]}
        ]})).unwrap(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    db
}

#[test]
fn native_content_projection_keeps_identity_and_local_filter_aliases() {
    let db = db();
    let before = db.feature_catalog_snapshot().unwrap();
    let result = crate::launcher_catalog::search_text_content(&db, "json", None).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(
        (&*result[0].result.plugin_id, &*result[0].result.code),
        ("content", "mixed")
    );
    assert_eq!(result[0].result.match_type, "regex");
    for alias in [
        "JSON 整理",
        "格式工具",
        "整理文本",
        "json",
        "别名",
        "JSON 内容",
    ] {
        assert!(result[0]
            .content_search_terms
            .iter()
            .any(|term| term == alias));
    }
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
}

#[test]
fn content_activation_requires_a_current_typed_rule_and_expected_owner() {
    let db = db();
    assert_eq!(
        entry_type(&db, "mixed", "json", "content").unwrap(),
        "regex"
    );
    assert_eq!(entry_type(&db, "mixed", "body", "content").unwrap(), "over");
    for (code, content, owner) in [
        ("name", "json", "content"),
        ("mixed", "json", "other"),
        ("mixed", "", "content"),
        (
            "mixed",
            "too long for a maximum length of twenty",
            "content",
        ),
    ] {
        assert!(entry_type(&db, code, content, owner)
            .unwrap_err()
            .starts_with("TEXT_CONTENT_NOT_MATCHED:"));
    }
}

#[test]
fn dynamic_rule_change_and_disable_invalidate_old_content_candidates() {
    let db = db();
    db.plugin_dynamic_features_set(
        "content",
        &[json!({"code":"dynamic", "cmds":[{"type":"over"}]})],
    )
    .unwrap();
    assert_eq!(
        entry_type(&db, "dynamic", "body", "content").unwrap(),
        "over"
    );
    db.plugin_dynamic_features_remove("content", &["dynamic".into()])
        .unwrap();
    assert!(entry_type(&db, "dynamic", "body", "content").is_err());
    let mut plugin = db.get_plugin("content").unwrap();
    plugin.enabled = false;
    db.save_plugin(&plugin).unwrap();
    assert!(entry_type(&db, "mixed", "json", "content").is_err());
}
