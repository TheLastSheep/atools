use atools_core::{Database, Plugin};
use serde_json::{json, Value};
use std::sync::Arc;

fn save(db: &Database, features: Value) {
    let plugin = Plugin {
        id: "content-plugin".into(),
        name: "content-plugin".into(),
        version: "1".into(),
        enabled: true,
        path: "/not-executed".into(),
        created_at: "now".into(),
        updated_at: "now".into(),
        manifest: serde_json::from_value(
            json!({"name":"content-plugin", "title":"json", "features":features}),
        )
        .unwrap(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
}

#[test]
fn content_candidates_keep_typed_matches_hidden_by_keyword_or_presentation_matches() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([
            {"code":"mixed", "cmds":["json", {"type":"regex", "match":"/^json$/i"}, {"type":"over"}]},
            {"code":"display-only", "label":"json", "cmds":["another"]},
            {"code":"over", "cmds":[{"type":"over"}]},
            {"code":"image", "cmds":[{"type":"img"}, {"type":"files"}]}
        ]),
    );
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert_eq!(snapshot.search("json")[0].match_type, "exact");
    let matches = snapshot.search_text_content("json").unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(
        (&*matches[0].feature_code, matches[0].match_type),
        ("mixed", "regex")
    );
    assert_eq!(
        (&*matches[1].feature_code, matches[1].match_type),
        ("over", "over")
    );
    assert!(matches
        .iter()
        .all(|item| item.plugin_id == "content-plugin"));
    assert!(Arc::ptr_eq(
        &snapshot,
        &db.feature_catalog_snapshot().unwrap()
    ));
}

#[test]
fn content_lengths_use_utf16_and_preserve_bounds_flags_and_regex_alias_through_sqlite() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([
            {"code":"emoji", "cmds":[{"type":"over", "minLength":2, "maxLength":2}]},
            {"code":"alias", "cmds":[{"type":"regex", "regex":"/^ABC$/i", "minLength":3}]},
        {"code":"both-keys", "cmds":[{"type":"regex", "match":"/^ABC$/i", "regex":"^other$"}]},
            {"code":"regex-min", "cmds":[{"type":"regex", "match":"/.*/", "minLength":4}]},
            {"code":"default-max", "cmds":[{"type":"over"}]}
        ]),
    );
    let snapshot = db.feature_catalog_snapshot().unwrap();
    let codes = |text: &str| {
        snapshot
            .search_text_content(text)
            .unwrap()
            .into_iter()
            .map(|m| m.feature_code)
            .collect::<Vec<_>>()
    };
    assert!(codes("😀").contains(&"emoji".into()));
    assert!(!codes("😀a").contains(&"emoji".into()));
    assert!(codes("abc").contains(&"alias".into()));
    assert!(codes("abc").contains(&"both-keys".into()));
    assert!(!codes("other").contains(&"both-keys".into()));
    assert!(!codes("abc").contains(&"regex-min".into()));
    assert!(codes(&"x".repeat(10_000)).contains(&"default-max".into()));
    assert!(!codes(&"x".repeat(10_001)).contains(&"default-max".into()));
    assert!(codes("").is_empty());
}

#[test]
fn dynamic_rules_refresh_the_same_catalogue_without_running_plugin_code() {
    let db = Database::in_memory().unwrap();
    save(&db, json!([{"code":"keyword", "cmds":["open"]}]));
    let original = db.feature_catalog_snapshot().unwrap();
    assert!(original.search_text_content("hello").unwrap().is_empty());
    db.plugin_dynamic_features_set(
        "content-plugin",
        &[json!({"code":"dynamic", "cmds":[{"type":"over", "maxLength":5}]})],
    )
    .unwrap();
    let changed = db.feature_catalog_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&original, &changed));
    assert_eq!(
        changed.search_text_content("hello").unwrap()[0].feature_code,
        "dynamic"
    );
    assert!(changed.search_text_content("longer").unwrap().is_empty());
    db.set_setting("theme", "dark").unwrap();
    assert!(Arc::ptr_eq(
        &changed,
        &db.feature_catalog_snapshot().unwrap()
    ));
    db.plugin_dynamic_features_remove("content-plugin", &["dynamic".into()])
        .unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap()
        .search_text_content("hello")
        .unwrap()
        .is_empty());
    db.plugin_dynamic_features_set(
        "content-plugin",
        &[json!({"code":"dynamic", "cmds":[{"type":"over"}]})],
    )
    .unwrap();
    let mut plugin = db.get_plugin("content-plugin").unwrap();
    plugin.enabled = false;
    db.save_plugin(&plugin).unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap()
        .search_text_content("hello")
        .unwrap()
        .is_empty());
}

#[test]
fn content_input_limit_is_in_bytes_and_errors_do_not_echo_original_text() {
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([{"code":"content", "cmds":[{"type":"over", "maxLength":262144}]}]),
    );
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        snapshot
            .search_text_content(&"x".repeat(262144))
            .unwrap()
            .len(),
        1
    );
    let secret = format!("DO_NOT_LOG_THIS{}", "😀".repeat(65536));
    let error = snapshot
        .search_text_content(&secret)
        .unwrap_err()
        .to_string();
    assert!(error.contains("262144"));
    assert!(!error.contains("DO_NOT_LOG_THIS"));
}

#[test]
fn ordinary_and_fixed_text_share_bounds_but_apply_distinct_sticky_policies() {
    use atools_core::matcher::search_all;
    let db = Database::in_memory().unwrap();
    save(
        &db,
        json!([
            {"code":"bounds", "cmds":[{"type":"over", "minLength":2, "maxLength":2}]},
            {"code":"minimum", "cmds":[{"type":"regex", "match":"/^abc$/", "minLength":4}]},
            {"code":"sticky", "cmds":[{"type":"regex", "match":"/x/y"}]},
            {"code":"sticky-m", "cmds":[{"type":"regex", "match":"/^x/my"}]}
        ]),
    );
    let snapshot = db.feature_catalog_snapshot().unwrap();
    let features = db.all_features().unwrap();
    for query in ["😀", "abcdef", "abc", "ax", "x", "\nx"] {
        let expected = snapshot.search_text_content(query).unwrap();
        let ordinary = snapshot.search(query);
        let legacy = search_all(&features, query);
        assert_eq!(legacy, ordinary, "legacy vs cached ordinary: {query:?}");
        if !["ax", "\nx"].contains(&query) {
            assert_eq!(ordinary, expected, "shared bounds: {query:?}");
        }
    }
    assert!(snapshot
        .search("ax")
        .iter()
        .any(|m| m.feature_code == "sticky"));
    assert!(!snapshot
        .search_text_content("ax")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "sticky"));
    assert!(!snapshot
        .search_text_content("\nx")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "sticky-m"));
    assert!(snapshot
        .search("😀")
        .iter()
        .any(|m| m.feature_code == "bounds"));
}
