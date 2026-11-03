use atools_core::{Database, Plugin};
use serde_json::{json, Value};
use std::sync::Arc;

fn plugin(id: &str, enabled: bool, features: Value) -> Plugin {
    serde_json::from_value(
        json!({"id":id,"name":id,"version":"1","path":"/unused","enabled":enabled,
        "manifest":{"name":id,"features":features},"created_at":"now","updated_at":"now"}),
    )
    .unwrap()
}
fn huge() -> Value {
    json!({"code":"poison","cmds":[{"type":"regex","match":"/a{10000000}/"}]})
}
fn healthy() -> Value {
    json!({"code":"healthy","cmds":["open",{"type":"regex","match":"/^safe$/"}]})
}
fn setup() -> (Database, Plugin) {
    let db = Database::in_memory().unwrap();
    let p = plugin("p", true, json!([healthy()]));
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    (db, p)
}
fn budget<T: std::fmt::Debug>(result: atools_core::Result<T>) {
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("TYPED_TEXT_REGEX_COMPILE_BUDGET"));
}

#[test]
fn dynamic_add_and_replace_reject_before_commit_and_keep_last_good_snapshot() {
    let (db, _) = setup();
    let original = db.feature_catalog_snapshot().unwrap();
    budget(db.plugin_dynamic_features_set("p", &[huge()]));
    assert!(db.plugin_dynamic_features("p", None).unwrap().is_empty());
    assert!(Arc::ptr_eq(
        &original,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert_eq!(original.search_checked("safe").unwrap().len(), 1);
    let valid = json!({"code":"poison","cmds":[{"type":"regex","match":"/^public$/"}]});
    db.plugin_dynamic_features_set("p", &[valid.clone()])
        .unwrap();
    let before = db.feature_catalog_snapshot().unwrap();
    budget(db.plugin_dynamic_features_set("p", &[huge()]));
    assert_eq!(db.plugin_dynamic_features("p", None).unwrap(), vec![valid]);
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert!(before
        .search_checked("public")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "poison"));
}

#[test]
fn static_install_and_reindex_reject_atomically_without_invalidating_good_catalog() {
    let (db, p) = setup();
    let before = db.feature_catalog_snapshot().unwrap();
    let bad = plugin("bad", true, json!([huge()]));
    budget(db.save_plugin_with_features(&bad, &bad.manifest.features));
    assert!(db.get_plugin("bad").is_err());
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    let bad_features: Vec<atools_core::Feature> = serde_json::from_value(json!([huge()])).unwrap();
    budget(db.index_features("p", &bad_features));
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert_eq!(db.features_by_plugin("p").unwrap()[0].code, "healthy");
    let mut updated = p.clone();
    updated.manifest.title = Some("should rollback".into());
    budget(db.save_plugin_with_features(&updated, &bad_features));
    assert!(db.get_plugin("p").unwrap().manifest.title.is_none());
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
}

#[test]
fn disabled_declarations_can_be_stored_but_enabling_cannot_poison_active_catalog() {
    let (db, _) = setup();
    let mut bad = plugin("bad", false, json!([huge()]));
    db.save_plugin_with_features(&bad, &bad.manifest.features)
        .unwrap();
    let before = db.feature_catalog_snapshot().unwrap();
    bad.enabled = true;
    budget(db.save_plugin(&bad));
    assert!(!db.get_plugin("bad").unwrap().enabled);
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert_eq!(before.search_checked("safe").unwrap().len(), 1);
}

#[test]
fn deleting_or_disabling_legacy_bad_declarations_remains_available_for_recovery() {
    for disable in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy.db");
        let db = Database::open(&path).unwrap();
        let mut p = plugin("legacy", true, json!([healthy()]));
        db.save_plugin_with_features(&p, &p.manifest.features)
            .unwrap();
        let sql = rusqlite::Connection::open(&path).unwrap();
        sql.execute(
            "UPDATE features SET cmds=?1 WHERE plugin_id='legacy'",
            [json!([{"type":"regex","match":"/a{10000000}/"}]).to_string()],
        )
        .unwrap();
        assert!(db
            .feature_catalog_snapshot()
            .unwrap_err()
            .to_string()
            .contains("TYPED_TEXT_REGEX_COMPILE_BUDGET"));
        if disable {
            p.enabled = false;
            db.save_plugin(&p).unwrap();
        } else {
            assert!(db.delete_feature("legacy", "healthy").unwrap());
        }
        assert!(db.feature_catalog_snapshot().unwrap().entries().is_empty());
    }
}

#[test]
fn real_ecosystem_rule_admission_reports_mutation_cost_and_preserves_rejected_update() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/launcher-typed-text-ecosystem-rules.json"
    ))
    .unwrap();
    let features = fixture["commands"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, c)| json!({"code":format!("rule-{i}"),"cmds":[c]}))
        .collect::<Vec<_>>();
    let db = Database::in_memory().unwrap();
    let mut p = plugin("ecology", true, Value::Array(features));
    let started = std::time::Instant::now();
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    eprintln!(
        "typedtext_mutation operation=install rules=70 elapsed_ns={}",
        started.elapsed().as_nanos()
    );
    let started = std::time::Instant::now();
    let _snapshot = db.feature_catalog_snapshot().unwrap();
    eprintln!(
        "typedtext_mutation operation=first_snapshot rules=70 elapsed_ns={}",
        started.elapsed().as_nanos()
    );
    let started = std::time::Instant::now();
    db.plugin_dynamic_features_set(
        "ecology",
        &[json!({"code":"dynamic","cmds":[{"type":"over","maxLength":40}]})],
    )
    .unwrap();
    eprintln!(
        "typedtext_mutation operation=dynamic_add rules=71 elapsed_ns={}",
        started.elapsed().as_nanos()
    );
    let started = std::time::Instant::now();
    p.manifest.title = Some("changed".into());
    db.save_plugin(&p).unwrap();
    eprintln!(
        "typedtext_mutation operation=metadata_update rules=71 elapsed_ns={}",
        started.elapsed().as_nanos()
    );
    let before = db.feature_catalog_snapshot().unwrap();
    let started = std::time::Instant::now();
    budget(db.plugin_dynamic_features_set("ecology", &[huge()]));
    eprintln!(
        "typedtext_mutation operation=rejected_program rules=72 elapsed_ns={}",
        started.elapsed().as_nanos()
    );
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert!(!db
        .plugin_dynamic_features("ecology", None)
        .unwrap()
        .iter()
        .any(|f| f["code"] == "poison"));
}
