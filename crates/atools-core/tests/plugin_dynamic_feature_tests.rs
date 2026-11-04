#![allow(dead_code, clippy::cloned_ref_to_slice_refs)]

use atools_core::{Database, Feature, Plugin};
use serde_json::{json, Value};
use std::sync::Arc;

fn plugin(id: &str) -> Plugin {
    Plugin {
        id: id.into(),
        name: id.into(),
        version: "1".into(),
        path: "/unused/plugin".into(),
        enabled: true,
        manifest: serde_json::from_value(json!({
            "name":id,"features":[{"code":format!("{id}-static"),"cmds":["static"]}]
        }))
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}
fn setup() -> (Database, Plugin) {
    let db = Database::in_memory().unwrap();
    let p = plugin("p");
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    (db, p)
}
fn dynamic(code: &str) -> Value {
    json!({"code":code,"label":"动态标题","cmds":["dynamic",{"type":"regex","match":"/^dyn[0-9]+$/i","label":"typed"}],
        "icon":"icon.png","mainHide":true,"platform":["darwin"],"custom":{"preserved":[1,true]}})
}

#[test]
fn dynamic_round_trip_preserves_json_and_joins_shared_catalog_without_manifest_mutation() {
    let (db, p) = setup();
    let original_manifest = serde_json::to_value(&p.manifest).unwrap();
    let before = db.feature_catalog_snapshot().unwrap();
    let value = dynamic("p-dynamic");
    assert_eq!(
        db.plugin_dynamic_features_set_with_change("p", &[value.clone()])
            .unwrap(),
        (true, true)
    );
    assert_eq!(
        db.plugin_dynamic_features("p", None).unwrap(),
        vec![value.clone()]
    );
    assert_eq!(
        db.plugin_dynamic_features("p", Some(&["p-dynamic".into()]))
            .unwrap(),
        vec![value]
    );
    assert!(db
        .plugin_dynamic_features("p", Some(&[]))
        .unwrap()
        .is_empty());
    assert!(db
        .plugin_dynamic_features("p", Some(&["p-static".into()]))
        .unwrap()
        .is_empty());
    let after = db.feature_catalog_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&before, &after));
    assert_eq!(
        after.find("p", "p-dynamic").unwrap().display_label,
        "动态标题"
    );
    assert!(after
        .search("dynamic")
        .iter()
        .any(|r| r.plugin_id == "p" && r.feature_code == "p-dynamic"));
    assert!(after
        .search("dyn123")
        .iter()
        .any(|r| r.feature_code == "p-dynamic"));
    assert_eq!(db.get_feature("p-dynamic").unwrap().plugin_id, "p");
    assert_eq!(db.features_by_plugin("p").unwrap().len(), 2);
    assert_eq!(
        serde_json::to_value(db.get_plugin("p").unwrap().manifest).unwrap(),
        original_manifest
    );
}

#[test]
fn identical_and_empty_sets_do_not_invalidate_and_removal_is_dynamic_only() {
    let (db, _) = setup();
    let one = dynamic("one");
    assert!(db.plugin_dynamic_features_set("p", &[one.clone()]).unwrap());
    let before = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        db.plugin_dynamic_features_set_with_change("p", &[one])
            .unwrap(),
        (true, false)
    );
    assert_eq!(
        db.plugin_dynamic_features_set_with_change("p", &[])
            .unwrap(),
        (true, false)
    );
    assert_eq!(
        db.plugin_dynamic_features_remove_with_change("p", &["unknown".into()])
            .unwrap(),
        (false, false)
    );
    assert_eq!(
        db.plugin_dynamic_features_remove_with_change("p", &[])
            .unwrap(),
        (false, false)
    );
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert!(db
        .plugin_dynamic_features_remove("p", &["one".into()])
        .unwrap());
    assert!(db.get_feature("one").is_err());
    assert!(db.get_feature("p-static").is_ok());
    assert!(db.plugin_dynamic_features("p", None).unwrap().is_empty());
}

#[test]
fn persistent_dynamic_features_survive_both_reindex_paths_and_uninstall_cascades() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("dynamic.db");
    let db = Database::open(&file).unwrap();
    let mut p = plugin("p");
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    db.plugin_dynamic_features_set("p", &[dynamic("persisted")])
        .unwrap();
    db.index_features("p", &p.manifest.features).unwrap();
    p.version = "2".into();
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    drop(db);
    let db = Database::open(&file).unwrap();
    assert_eq!(
        db.plugin_dynamic_features("p", None).unwrap(),
        vec![dynamic("persisted")]
    );
    assert_eq!(db.all_features().unwrap().len(), 2);
    db.delete_plugin("p").unwrap();
    let sql = rusqlite::Connection::open(file).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM plugin_dynamic_features", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}

#[test]
fn disabled_and_missing_plugins_cannot_read_or_mutate_but_disable_preserves_data() {
    let (db, mut p) = setup();
    db.plugin_dynamic_features_set("p", &[dynamic("saved")])
        .unwrap();
    p.enabled = false;
    db.save_plugin(&p).unwrap();
    for id in ["p", "missing", "", "bad\n"] {
        assert!(db.plugin_dynamic_features(id, None).is_err());
        assert!(db
            .plugin_dynamic_features_set(id, &[dynamic("new")])
            .is_err());
        assert!(db
            .plugin_dynamic_features_remove(id, &["saved".into()])
            .is_err());
    }
    assert!(db.feature_catalog_snapshot().unwrap().entries().is_empty());
    p.enabled = true;
    db.save_plugin(&p).unwrap();
    assert_eq!(
        db.plugin_dynamic_features("p", None).unwrap(),
        vec![dynamic("saved")]
    );
}

#[test]
fn dynamic_batches_reject_static_and_other_plugin_conflicts_without_partial_writes() {
    let (db, _) = setup();
    let other = plugin("other");
    db.save_plugin_with_features(&other, &other.manifest.features)
        .unwrap();
    db.plugin_dynamic_features_set("other", &[dynamic("other-dynamic")])
        .unwrap();
    db.plugin_dynamic_features_set("p", &[dynamic("existing")])
        .unwrap();
    for code in ["p-static", "other-static", "other-dynamic"] {
        assert!(db
            .plugin_dynamic_features_set("p", &[dynamic("new"), dynamic(code)])
            .is_err());
        assert!(db
            .plugin_dynamic_features_remove("p", &["existing".into(), code.into()])
            .is_err());
        assert!(db.get_feature("new").is_err());
        assert!(db.get_feature("existing").is_ok());
    }
    assert_eq!(db.get_feature("other-dynamic").unwrap().plugin_id, "other");
    // Even a static declaration temporarily absent from the index remains reserved.
    db.delete_feature("p", "p-static").unwrap();
    assert!(db
        .plugin_dynamic_features_set("p", &[dynamic("p-static")])
        .is_err());
}

#[test]
fn static_reindex_cannot_overwrite_own_or_foreign_dynamic_features() {
    let (db, p) = setup();
    db.plugin_dynamic_features_set("p", &[dynamic("reserved")])
        .unwrap();
    let other = plugin("other");
    db.save_plugin_with_features(&other, &other.manifest.features)
        .unwrap();
    let feature: Feature =
        serde_json::from_value(json!({"code":"reserved","cmds":["oops"]})).unwrap();
    assert!(db.index_features("other", &[feature.clone()]).is_err());
    assert!(db.index_features("p", &[feature.clone()]).is_err());
    let mut changed = p.clone();
    changed.version = "not-committed".into();
    changed.manifest.features = vec![feature];
    assert!(db
        .save_plugin_with_features(&changed, &changed.manifest.features)
        .is_err());
    assert_eq!(db.get_plugin("p").unwrap().version, p.version);
    assert_eq!(db.get_feature("reserved").unwrap().plugin_id, "p");
    assert!(db.get_feature("p-static").is_ok());
    assert!(db.get_feature("other-static").is_ok());
}

#[test]
fn schema_validation_and_batch_limits_reject_before_any_partial_write() {
    let (db, _) = setup();
    let invalid = [
        json!(null),
        json!({}),
        json!({"code":""}),
        json!({"code":" "}),
        json!({"code":"bad\n"}),
        json!({"code":"x".repeat(257)}),
        json!({"code":"bad","cmds":{}}),
        json!({"code":"bad","cmds":[42]}),
        json!({"code":"bad","cmds":[{"type":"unknown"}]}),
        json!({"code":"too-large","unused":"x".repeat(16*1024)}),
    ];
    for value in invalid {
        assert!(db
            .plugin_dynamic_features_set("p", &[dynamic("valid"), value])
            .is_err());
        assert!(db.plugin_dynamic_features("p", None).unwrap().is_empty());
    }
    assert!(db
        .plugin_dynamic_features_set("p", &[dynamic("duplicate"), dynamic("duplicate")])
        .is_err());
    let too_many = (0..129)
        .map(|n| json!({"code":format!("x{n}")}))
        .collect::<Vec<_>>();
    assert!(db.plugin_dynamic_features_set("p", &too_many).is_err());
    let codes = vec!["x".into(); 129];
    assert!(db.plugin_dynamic_features_remove("p", &codes).is_err());
    assert!(db.plugin_dynamic_features("p", Some(&codes)).is_err());
    assert!(db
        .plugin_dynamic_features("p", Some(&["\0".into()]))
        .is_err());
    assert!(db
        .plugin_dynamic_features_remove("p", &["\0".into()])
        .is_err());
}

#[test]
fn per_plugin_count_and_json_storage_budgets_are_atomic() {
    let (db, _) = setup();
    for start in (0..1000).step_by(128) {
        let values = (start..(start + 128).min(1000))
            .map(|n| json!({"code":format!("n{n}")}))
            .collect::<Vec<_>>();
        db.plugin_dynamic_features_set("p", &values).unwrap();
    }
    assert!(db
        .plugin_dynamic_features_set("p", &[dynamic("overflow")])
        .is_err());
    assert_eq!(db.plugin_dynamic_features("p", None).unwrap().len(), 1000);
    let (db, _) = setup();
    let large = (0..16)
        .map(|n| json!({"code":format!("large-{n}"),"extra":"x".repeat(16_000)}))
        .collect::<Vec<_>>();
    db.plugin_dynamic_features_set("p", &large).unwrap();
    assert!(db
        .plugin_dynamic_features_set(
            "p",
            &[json!({"code":"large-overflow","extra":"x".repeat(16_000)})]
        )
        .is_err());
    assert_eq!(db.plugin_dynamic_features("p", None).unwrap().len(), 16);
}

#[test]
fn another_connection_observes_catalog_mutations_and_same_code_updates_replace_only_dynamic() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("shared.db");
    let first = Database::open(&path).unwrap();
    let p = plugin("p");
    first
        .save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let warm = first.feature_catalog_snapshot().unwrap();
    let second = Database::open(&path).unwrap();
    second
        .plugin_dynamic_features_set("p", &[dynamic("shared")])
        .unwrap();
    let current = first.feature_catalog_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&warm, &current));
    assert!(current.find("p", "shared").is_some());
    let updated = json!({"code":"shared","label":"新标题","cmds":["replacement"]});
    second
        .plugin_dynamic_features_set("p", &[updated.clone()])
        .unwrap();
    assert_eq!(
        first.plugin_dynamic_features("p", None).unwrap(),
        vec![updated]
    );
    assert_eq!(
        first
            .feature_catalog_snapshot()
            .unwrap()
            .find("p", "shared")
            .unwrap()
            .display_label,
        "新标题"
    );
    assert!(first.get_feature("p-static").is_ok());
    second
        .plugin_dynamic_features_remove("p", &["shared".into()])
        .unwrap();
    assert!(first
        .feature_catalog_snapshot()
        .unwrap()
        .find("p", "shared")
        .is_none());
}

#[test]
fn global_feature_and_command_budgets_reject_before_commit() {
    for budget in ["features", "commands", "metadata", "index"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("budget.db");
        let db = Database::open(&path).unwrap();
        let p = plugin("p");
        db.save_plugin_with_features(&p, &p.manifest.features)
            .unwrap();
        let mut sql = rusqlite::Connection::open(&path).unwrap();
        if budget == "features" {
            let tx = sql.transaction().unwrap();
            for n in 1..20_000 {
                tx.execute(
                    "INSERT INTO features(code,plugin_id,label,explain) VALUES(?1,'p','small','')",
                    [format!("raw-{n}")],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        } else if budget == "commands" {
            sql.execute(
                "UPDATE features SET cmds=?1",
                [serde_json::to_string(&vec![""; 65_536]).unwrap()],
            )
            .unwrap();
        } else if budget == "metadata" {
            sql.execute(
                "UPDATE features SET explain=?1,label='fixed',label_declared=1",
                ["x".repeat(8 * 1024 * 1024 - 1024)],
            )
            .unwrap();
        } else {
            sql.execute(
                "UPDATE features SET cmds=?1",
                [serde_json::to_string(&vec!["x".repeat(2 * 1024 * 1024 - 128)]).unwrap()],
            )
            .unwrap();
        }
        let before = db
            .feature_catalog_snapshot()
            .unwrap_or_else(|error| panic!("invalid {budget} baseline: {error}"));
        let result = db.plugin_dynamic_features_set(
            "p",
            &[json!({"code":"over-budget","cmds":["x".repeat(2000)],"explain":"y".repeat(1000)})],
        );
        let error = result.unwrap_err().to_string();
        let expected = match budget {
            "features" => "20000 features",
            "commands" => "65536 command",
            "metadata" => "metadata exceeds",
            _ => "search index exceeds",
        };
        assert!(error.contains(expected), "{budget}: {error}");
        assert!(Arc::ptr_eq(
            &before,
            &db.feature_catalog_snapshot().unwrap()
        ));
        assert!(
            db.plugin_dynamic_features("p", None).unwrap().is_empty(),
            "{budget}"
        );
        assert!(db.get_feature("over-budget").is_err(), "{budget}");
    }
}

#[test]
fn read_preflight_bounds_filtered_and_unfiltered_results_before_json_materialization() {
    for corrupt in ["count", "single", "total"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("corrupt.db");
        let db = Database::open(&path).unwrap();
        db.save_plugin(&plugin("p")).unwrap();
        let mut sql = rusqlite::Connection::open(&path).unwrap();
        let tx = sql.transaction().unwrap();
        let count = if corrupt == "count" {
            1001
        } else if corrupt == "total" {
            17
        } else {
            1
        };
        let json = if corrupt == "count" {
            "{}".to_string()
        } else if corrupt == "total" {
            "x".repeat(16_000)
        } else {
            "x".repeat(16_385)
        };
        for n in 0..count {
            tx.execute(
                "INSERT INTO plugin_dynamic_features(plugin_id,code,declaration) VALUES('p',?1,?2)",
                rusqlite::params![format!("raw-{n}"), json],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert!(db
            .plugin_dynamic_features("p", None)
            .unwrap_err()
            .to_string()
            .contains("budget"));
        assert!(db
            .plugin_dynamic_features("p", Some(&[]))
            .unwrap_err()
            .to_string()
            .contains("budget"));
    }
}

#[test]
fn index_write_failure_rolls_back_json_and_preserves_warm_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("trigger.db");
    let db = Database::open(&path).unwrap();
    let p = plugin("p");
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    db.plugin_dynamic_features_set("p", &[dynamic("existing")])
        .unwrap();
    let before = db.feature_catalog_snapshot().unwrap();
    let sql = rusqlite::Connection::open(path).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_dynamic BEFORE INSERT ON features WHEN NEW.code='reject' BEGIN SELECT RAISE(ABORT,'fixed fixture failure'); END;").unwrap();
    let previous = db.feature_catalog_snapshot().unwrap();
    assert!(db
        .plugin_dynamic_features_set("p", &[dynamic("new"), dynamic("reject")])
        .is_err());
    assert_eq!(
        db.plugin_dynamic_features("p", None).unwrap(),
        vec![dynamic("existing")]
    );
    assert!(db.get_feature("new").is_err());
    assert_eq!(before.entries().len(), previous.entries().len());
    assert!(Arc::ptr_eq(
        &previous,
        &db.feature_catalog_snapshot().unwrap()
    ));
}
