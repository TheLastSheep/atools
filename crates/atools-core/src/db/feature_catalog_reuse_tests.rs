//! Admission reuse must be observable without timing-dependent pass criteria.
use crate::{matcher::typed_text_compile_count, Database, Plugin};
use serde_json::{json, Value};
use std::sync::Arc;

fn plugin(id: &str, features: Value) -> Plugin {
    serde_json::from_value(json!({"id":id,"name":id,"version":"1","path":"/unused",
        "enabled":true,"manifest":{"name":id,"features":features},
        "created_at":"now","updated_at":"now"}))
    .unwrap()
}
fn rule(code: &str, pattern: &str) -> Value {
    json!({"code":code,"cmds":[{"type":"regex","match":pattern}]})
}
fn install(db: &Database, plugin: &Plugin) {
    db.save_plugin_with_features(plugin, &plugin.manifest.features)
        .unwrap();
}

#[test]
fn admitted_program_is_compiled_once_and_reused_by_snapshot_and_metadata() {
    let db = Database::in_memory().unwrap();
    let mut p = plugin("p", json!([rule("f", "/^safe$/i")]));
    let initial = typed_text_compile_count();
    install(&db, &p);
    assert_eq!(typed_text_compile_count() - initial, 1);
    let old = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        typed_text_compile_count() - initial,
        1,
        "snapshot must consume admitted program"
    );
    p.manifest.title = Some("new title".into());
    db.save_plugin(&p).unwrap();
    let current = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        typed_text_compile_count() - initial,
        1,
        "metadata must retain compiled program"
    );
    assert!(!Arc::ptr_eq(&old, &current));
    assert_eq!(current.entries()[0].plugin_display_name, "new title");
    assert_eq!(
        old.search_checked("safe").unwrap(),
        current.search_checked("safe").unwrap()
    );
    assert_eq!(current.search_text_content("SAFE").unwrap().len(), 1);
}

#[test]
fn duplicate_cross_plugin_rules_and_new_bindings_reuse_one_admitted_program() {
    let db = Database::in_memory().unwrap();
    let p = plugin("p", json!([rule("a", "/x/g")]));
    install(&db, &p);
    let old = db.feature_catalog_snapshot().unwrap();
    let count = typed_text_compile_count();
    let q = plugin("q", json!([rule("b", "/x/")]));
    install(&db, &q);
    db.plugin_dynamic_features_set("p", &[rule("dynamic", "/x/")])
        .unwrap();
    let current = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        typed_text_compile_count(),
        count,
        "a new binding is not a new expression"
    );
    assert_eq!(old.search_text_content("x").unwrap().len(), 1);
    assert_eq!(current.search_text_content("x").unwrap().len(), 3);
}

#[test]
fn selectors_rebuild_while_flags_exclusions_and_length_predicates_keep_exact_keys() {
    let db = Database::in_memory().unwrap();
    let mut p = plugin(
        "p",
        json!([rule("a", "/^x$/i"),
        {"code":"over","cmds":[{"type":"over","exclude":"/deny/i","maxLength":4}]},
        rule("length", r"/[\s\S]{2}/u")]),
    );
    install(&db, &p);
    let before = db.feature_catalog_snapshot().unwrap();
    let count = typed_text_compile_count();
    p.manifest.features[0].cmds = serde_json::from_value(json!([
        {"type":"regex","match":"/^x$/i","length":2}]))
    .unwrap();
    install(&db, &p);
    let selected = db.feature_catalog_snapshot().unwrap();
    assert_eq!(typed_text_compile_count(), count);
    assert!(before
        .search_text_content("X")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "a"));
    assert!(!selected
        .search_text_content("X")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "a"));
    // Changing i affects only FixedText, but must change the combined bank.
    p.manifest.features[0].cmds = serde_json::from_value(json!([
        {"type":"regex","match":"/^x$/","length":1}]))
    .unwrap();
    install(&db, &p);
    let flags = db.feature_catalog_snapshot().unwrap();
    assert_eq!(typed_text_compile_count(), count + 1);
    assert!(!flags
        .search_text_content("X")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "a"));
    p.manifest.features[1].cmds = serde_json::from_value(json!([
        {"type":"over","exclude":"/block/","maxLength":5}]))
    .unwrap();
    install(&db, &p);
    let exclude = db.feature_catalog_snapshot().unwrap();
    assert_eq!(typed_text_compile_count(), count + 2);
    assert!(!exclude
        .search_checked("block")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "over"));
    assert!(exclude
        .search_checked("deny")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "over"));
    assert!(!exclude
        .search_text_content("😀")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "length"));
    assert!(exclude
        .search_checked("😀")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "length"));
}

#[test]
fn external_sql_rechecks_complete_key_and_independent_database_handles_do_not_share_state() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("external.db");
    let first = Database::open(&path).unwrap();
    let p = plugin("p", json!([rule("a", "/old/")]));
    install(&first, &p);
    let old = first.feature_catalog_snapshot().unwrap();
    let count = typed_text_compile_count();
    let second = Database::open(&path).unwrap();
    second.feature_catalog_snapshot().unwrap();
    assert_eq!(
        typed_text_compile_count(),
        count + 1,
        "separate handles admit independently"
    );
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute("UPDATE features SET explain='renamed'", [])
        .unwrap();
    let metadata = first.feature_catalog_snapshot().unwrap();
    assert_eq!(typed_text_compile_count(), count + 1);
    assert_eq!(metadata.entries()[0].feature.explain, "renamed");
    sql.execute(
        "UPDATE features SET cmds=?1",
        [json!([
        {"type":"regex","match":"/new/"}])
        .to_string()],
    )
    .unwrap();
    let current = first.feature_catalog_snapshot().unwrap();
    assert_eq!(typed_text_compile_count(), count + 2);
    assert!(current.search_text_content("old").unwrap().is_empty());
    assert_eq!(current.search_text_content("new").unwrap().len(), 1);
    assert_eq!(old.search_text_content("old").unwrap().len(), 1);
    second.feature_catalog_snapshot().unwrap();
    assert_eq!(typed_text_compile_count(), count + 3);
    let other = Database::in_memory().unwrap();
    install(&other, &plugin("p", json!([rule("a", "/different/")])));
    assert_eq!(
        other
            .feature_catalog_snapshot()
            .unwrap()
            .search_text_content("different")
            .unwrap()
            .len(),
        1
    );
    assert!(current.search_text_content("different").unwrap().is_empty());
}

#[test]
fn failed_program_or_deferred_commit_never_publishes_candidate_bank() {
    let db = Database::in_memory().unwrap();
    let mut p = plugin("p", json!([rule("a", "/old/")]));
    install(&db, &p);
    let old = db.feature_catalog_snapshot().unwrap();
    let count = typed_text_compile_count();
    let bad = plugin("p", json!([rule("a", "/a{10000000}/")]));
    assert!(db
        .save_plugin_with_features(&bad, &bad.manifest.features)
        .unwrap_err()
        .to_string()
        .contains("TYPED_TEXT_REGEX_COMPILE_BUDGET"));
    assert!(Arc::ptr_eq(&old, &db.feature_catalog_snapshot().unwrap()));
    assert_eq!(typed_text_compile_count(), count + 1);
    db.conn.lock().execute_batch("CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_plugin_commit AFTER UPDATE ON plugins BEGIN
        INSERT INTO commit_child(id) VALUES(99); END;").unwrap();
    p.manifest.features = serde_json::from_value(json!([rule("a", "/new/")])).unwrap();
    assert!(db
        .save_plugin_with_features(&p, &p.manifest.features)
        .is_err());
    assert!(Arc::ptr_eq(&old, &db.feature_catalog_snapshot().unwrap()));
    assert_eq!(typed_text_compile_count(), count + 2);
    assert_eq!(
        serde_json::to_value(&db.features_by_plugin("p").unwrap()[0].cmds).unwrap()[0]["match"],
        "/old/"
    );
    db.conn
        .lock()
        .execute_batch("DROP TRIGGER reject_plugin_commit")
        .unwrap();
    install(&db, &p);
    let new = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        typed_text_compile_count(),
        count + 3,
        "rolled-back program must be readmitted"
    );
    assert_eq!(new.search_text_content("new").unwrap().len(), 1);
    assert_eq!(old.search_text_content("old").unwrap().len(), 1);
}

#[test]
fn external_bad_state_can_recover_to_last_verified_bank_without_polluting_live_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("recover.db");
    let db = Database::open(&path).unwrap();
    install(&db, &plugin("p", json!([rule("a", "/old/")])));
    let old = db.feature_catalog_snapshot().unwrap();
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute(
        "UPDATE features SET cmds=?1",
        [json!([
        {"type":"regex","match":"/a{10000000}/"}])
        .to_string()],
    )
    .unwrap();
    let count = typed_text_compile_count();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap_err()
        .to_string()
        .contains("COMPILE_BUDGET"));
    assert_eq!(old.search_text_content("old").unwrap().len(), 1);
    sql.execute(
        "UPDATE features SET cmds=?1",
        [json!([
        {"type":"regex","match":"/old/"}])
        .to_string()],
    )
    .unwrap();
    let restored = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        typed_text_compile_count(),
        count + 1,
        "failed candidate cannot replace old admitted bank"
    );
    assert_eq!(restored.search_text_content("old").unwrap().len(), 1);
}

#[test]
fn ecosystem_cold_warm_and_complete_mutation_samples_report_compile_counts() {
    fn sample<T>(operation: &str, expected_compiles: usize, action: impl FnOnce() -> T) -> T {
        let before = typed_text_compile_count();
        let started = std::time::Instant::now();
        let value = action();
        let elapsed = started.elapsed().as_nanos();
        let compiles = typed_text_compile_count() - before;
        eprintln!(
            "typedtext_catalog operation={operation} elapsed_ns={elapsed} compiles={compiles}"
        );
        assert_eq!(compiles, expected_compiles, "{operation}");
        value
    }
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/launcher-typed-text-ecosystem-rules.json"
    ))
    .unwrap();
    let features = fixture["commands"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, command)| json!({"code":format!("rule-{i}"),"cmds":[command]}))
        .collect::<Vec<_>>();
    let db = Database::in_memory().unwrap();
    let mut p = plugin("ecology", Value::Array(features));
    sample("cold_install", 1, || install(&db, &p));
    sample("first_snapshot", 0, || {
        db.feature_catalog_snapshot().unwrap()
    });
    for _ in 0..3 {
        sample("warm_snapshot", 0, || {
            db.feature_catalog_snapshot().unwrap()
        });
    }
    p.manifest.title = Some("new presentation".into());
    sample("metadata", 0, || db.save_plugin(&p).unwrap());
    sample("metadata_snapshot", 0, || {
        db.feature_catalog_snapshot().unwrap()
    });
    sample("dynamic_nonregex", 0, || {
        db.plugin_dynamic_features_set(
            "ecology",
            &[json!({"code":"over","cmds":[{"type":"over","maxLength":40}]})],
        )
        .unwrap()
    });
    sample("dynamic_nonregex_snapshot", 0, || {
        db.feature_catalog_snapshot().unwrap()
    });
    sample("changed_rule", 1, || {
        db.plugin_dynamic_features_set("ecology", &[rule("new", "/^batch36-new$/i")])
            .unwrap()
    });
    let before = sample("changed_rule_snapshot", 0, || {
        db.feature_catalog_snapshot().unwrap()
    });
    assert!(before
        .search_text_content("BATCH36-NEW")
        .unwrap()
        .iter()
        .any(|m| m.feature_code == "new"));
    sample("rejected_program", 1, || {
        assert!(db
            .plugin_dynamic_features_set("ecology", &[rule("poison", "/a{10000000}/")])
            .unwrap_err()
            .to_string()
            .contains("COMPILE_BUDGET"))
    });
    let after = sample("post_rejection_snapshot", 0, || {
        db.feature_catalog_snapshot().unwrap()
    });
    assert!(Arc::ptr_eq(&before, &after));
}

#[test]
fn retained_unsupported_keys_are_charged_and_overflow_rejects_before_commit() {
    let db = Database::in_memory().unwrap();
    install(&db, &plugin("p", json!([rule("a", "/old/")])));
    let old = db.feature_catalog_snapshot().unwrap();
    let p = plugin("p", json!([rule("a", "/(?=unsupported)/i")]));
    install(&db, &p);
    let unsupported = db.feature_catalog_snapshot().unwrap();
    let cache = db.feature_catalog.lock();
    let added = cache.text_regex.as_ref().unwrap().unsupported_key_bytes();
    assert!(added > 2 * std::mem::size_of::<usize>());
    assert_eq!(
        unsupported.index_budget_bytes,
        super::validate_index_budget(unsupported.entries()).unwrap() + added
    );
    drop(cache);
    let pattern = format!("/(?=x){}/i", "a".repeat(1_200_000));
    let big = plugin("p", json!([rule("a", &pattern)]));
    let error = db
        .save_plugin_with_features(&big, &big.manifest.features)
        .unwrap_err();
    assert!(
        error.to_string().contains("32 MiB owned-data allowance"),
        "{error}"
    );
    assert!(Arc::ptr_eq(
        &unsupported,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert_eq!(old.search_text_content("old").unwrap().len(), 1);
    assert_eq!(
        serde_json::to_value(&db.features_by_plugin("p").unwrap()[0].cmds).unwrap()[0]["match"],
        "/(?=unsupported)/i"
    );
}
