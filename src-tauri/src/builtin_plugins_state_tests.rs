//! Persistent builtin state across real metadata startup registration.
use super::load_builtin_plugins_from_dir;
use atools_core::{db::Database, models::Document};
use serde_json::json;
use std::{fs, path::Path, sync::Arc};

const PLUGIN_NAME: &str = "restart-state-fixture";

fn write_builtin_manifest(plugin_dir: &Path, version: &str, feature_code: &str) {
    fs::create_dir_all(plugin_dir).unwrap();
    fs::write(
        plugin_dir.join("plugin.json"),
        serde_json::to_vec(&json!({
            "name": PLUGIN_NAME,
            "version": version,
            "main": "index.html",
            "features": [{"code": feature_code, "cmds": [feature_code]}]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        plugin_dir.join("index.html"),
        "<!doctype html><p>fixture</p>",
    )
    .unwrap();
}

#[tokio::test]
async fn builtin_disabled_state_survives_restart_and_metadata_upgrade() {
    let scratch = tempfile::tempdir().unwrap();
    let builtin_root = scratch.path().join("bundle/resources/plugins/builtin");
    let plugin_dir = builtin_root.join(PLUGIN_NAME);
    let db_path = scratch.path().join("profile/data.db");
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    write_builtin_manifest(&plugin_dir, "1.0.0", "before-upgrade");

    let first_db = Arc::new(Database::open(&db_path).unwrap());
    load_builtin_plugins_from_dir(Arc::clone(&first_db), &builtin_root)
        .await
        .unwrap();

    let first_record = first_db
        .list_plugins()
        .unwrap()
        .into_iter()
        .find(|plugin| plugin.name == PLUGIN_NAME)
        .expect("startup should register the local builtin manifest");
    let plugin_id = first_record.id.clone();
    assert_eq!(first_record.version, "1.0.0");
    assert!(
        first_record.enabled,
        "a newly registered builtin defaults enabled"
    );
    let original_created_at = first_record.created_at.clone();

    write_builtin_manifest(&plugin_dir, "1.1.0", "while-enabled-refresh");
    load_builtin_plugins_from_dir(Arc::clone(&first_db), &builtin_root)
        .await
        .unwrap();
    let refreshed_while_enabled = first_db.get_plugin(&plugin_id).unwrap();
    assert!(
        refreshed_while_enabled.enabled,
        "metadata refresh must not disable an already enabled builtin"
    );
    assert_eq!(refreshed_while_enabled.version, "1.1.0");
    assert_eq!(refreshed_while_enabled.created_at, original_created_at);

    let document = Document {
        id: "preferences".into(),
        rev: None,
        data: json!({"theme": "dark", "retained": true}),
    };
    first_db.plugin_data_put(&plugin_id, &document).unwrap();
    first_db
        .put_attachment(
            &plugin_id,
            &document.id,
            "state.bin",
            b"preserve-across-restart",
            "application/octet-stream",
        )
        .unwrap();

    let mut disabled = first_db.get_plugin(&plugin_id).unwrap();
    disabled.enabled = false;
    first_db
        .save_plugin_with_features(&disabled, &disabled.manifest.features)
        .unwrap();
    assert!(!first_db.get_plugin(&plugin_id).unwrap().enabled);

    // A real close/reopen prevents this test from relying on the in-memory DB cache.
    drop(first_db);
    write_builtin_manifest(&plugin_dir, "2.0.0", "after-upgrade");

    let reopened_db = Arc::new(Database::open(&db_path).unwrap());
    load_builtin_plugins_from_dir(Arc::clone(&reopened_db), &builtin_root)
        .await
        .unwrap();

    let upgraded = reopened_db.get_plugin(&plugin_id).unwrap();
    assert_eq!(
        upgraded.id, plugin_id,
        "builtin identity must remain stable"
    );
    assert!(
        !upgraded.enabled,
        "startup metadata refresh must preserve the user's disabled state"
    );
    assert_eq!(
        upgraded.version, "2.0.0",
        "metadata upgrades must be applied"
    );
    assert_eq!(upgraded.created_at, original_created_at);
    assert_eq!(upgraded.manifest.features.len(), 1);
    assert_eq!(upgraded.manifest.features[0].code, "after-upgrade");

    let indexed_codes: Vec<String> = reopened_db
        .features_by_plugin(&plugin_id)
        .unwrap()
        .into_iter()
        .map(|feature| feature.code)
        .collect();
    assert_eq!(indexed_codes, vec!["after-upgrade"]);

    let restored_document = reopened_db
        .plugin_data_get(&plugin_id, &document.id)
        .unwrap()
        .expect("plugin document should survive metadata refresh");
    assert_eq!(restored_document.data, document.data);
    assert_eq!(
        reopened_db
            .get_attachment(&plugin_id, &document.id, "state.bin")
            .unwrap()
            .unwrap(),
        (
            b"preserve-across-restart".to_vec(),
            "application/octet-stream".to_string()
        )
    );
}
