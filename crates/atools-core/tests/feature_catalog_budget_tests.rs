use atools_core::{Database, Plugin};
use serde_json::json;

fn plugin() -> Plugin {
    Plugin {
        id: "budget".into(),
        name: "budget".into(),
        version: "1".into(),
        path: "/unused".into(),
        enabled: true,
        manifest: serde_json::from_value(
            json!({"name":"budget","features":[{"code":"one","cmds":["one"]}]}),
        )
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

#[test]
fn sql_byte_preflight_rejects_oversized_invalid_json_before_rust_deserialization() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("budget.db");
    let db = Database::open(&file).unwrap();
    let p = plugin();
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let _warm = db.feature_catalog_snapshot().unwrap();
    let sql = rusqlite::Connection::open(&file).unwrap();
    let invalid = format!("{{{}", "x".repeat(17 * 1024 * 1024));
    sql.execute("UPDATE plugins SET config=?1", rusqlite::params![invalid])
        .unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap_err()
        .to_string()
        .contains("metadata exceeds"));
    sql.execute(
        "UPDATE plugins SET config=?1",
        rusqlite::params![serde_json::to_string(&p.manifest).unwrap()],
    )
    .unwrap();
    sql.execute("UPDATE features SET cmds=?1", rusqlite::params![invalid])
        .unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap_err()
        .to_string()
        .contains("metadata exceeds"));
    sql.execute("UPDATE features SET cmds='[\"one\"]'", [])
        .unwrap();
    assert_eq!(db.feature_catalog_snapshot().unwrap().entries().len(), 1);
}

#[test]
fn sql_rule_count_preflight_bounds_small_json_arrays_before_command_vector_allocation() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("legacy-rules.db");
    let db = Database::open(&file).unwrap();
    let p = plugin();
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let commands = vec![""; 65_537];
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute(
        "UPDATE features SET cmds=?1",
        [serde_json::to_string(&commands).unwrap()],
    )
    .unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap_err()
        .to_string()
        .contains("65536 command"));
}

#[test]
fn manifest_declaration_count_is_bounded_even_when_indexed_feature_count_is_small() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("legacy-declarations.db");
    let db = Database::open(&file).unwrap();
    let mut p = plugin();
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let declarations = (0..20_001)
        .map(|index| json!({"code":format!("unused-{index}")}))
        .collect::<Vec<_>>();
    p.manifest.features = serde_json::from_value(serde_json::Value::Array(declarations)).unwrap();
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute(
        "UPDATE plugins SET config=?1",
        [serde_json::to_string(&p.manifest).unwrap()],
    )
    .unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap_err()
        .to_string()
        .contains("20000 declarations"));
}

#[test]
fn legacy_oversized_owned_index_is_rejected_without_caching_failure() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("legacy-index.db");
    let db = Database::open(&file).unwrap();
    let p = plugin();
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute(
        "UPDATE features SET cmds=?1",
        [json!(["x".repeat(3 * 1024 * 1024)]).to_string()],
    )
    .unwrap();
    assert!(db
        .feature_catalog_snapshot()
        .unwrap_err()
        .to_string()
        .contains("index"));
    sql.execute("UPDATE features SET cmds='[\"one\"]'", [])
        .unwrap();
    assert_eq!(db.feature_catalog_snapshot().unwrap().entries().len(), 1);
}
