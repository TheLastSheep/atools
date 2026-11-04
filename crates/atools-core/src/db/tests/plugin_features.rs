use super::*;

#[test]
fn test_database_operations() {
    let db = Database::in_memory().unwrap();

    // Test plugin operations
    let plugin = create_test_plugin("test-plugin-id", "Test Plugin");
    db.save_plugin(&plugin).unwrap();
    let retrieved = db.get_plugin("test-plugin-id").unwrap();
    assert_eq!(retrieved.name, "Test Plugin");

    // Test feature indexing
    let features = vec![create_test_feature("feature1")];
    db.index_features("test-plugin-id", &features).unwrap();
    let all = db.all_features().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].code, "feature1");

    // Test plugin data
    let doc = crate::models::Document {
        id: "doc1".to_string(),
        rev: None,
        data: serde_json::json!({"key": "value"}),
    };

    db.plugin_data_put("test-plugin-id", &doc).unwrap();
    let retrieved = db
        .plugin_data_get("test-plugin-id", "doc1")
        .unwrap()
        .unwrap();
    assert_eq!(retrieved.data["key"], "value");

    // Test settings
    db.set_setting("theme", "dark").unwrap();
    let theme = db.get_setting("theme").unwrap();
    assert_eq!(theme, Some("dark".to_string()));

    // Test attachments
    db.put_attachment(
        "test-plugin-id",
        "doc1",
        "file.txt",
        b"content",
        "text/plain",
    )
    .unwrap();
    let attachment = db
        .get_attachment("test-plugin-id", "doc1", "file.txt")
        .unwrap()
        .unwrap();
    assert_eq!(attachment.0, b"content");
    assert_eq!(attachment.1, "text/plain");
}

#[test]
fn test_plugin_crud_operations() {
    let db = Database::in_memory().unwrap();

    // Create
    let plugin = create_test_plugin("crud-plugin", "CRUD Plugin");
    db.save_plugin(&plugin).unwrap();

    // Read
    let retrieved = db.get_plugin("crud-plugin").unwrap();
    assert_eq!(retrieved.name, "CRUD Plugin");
    assert_eq!(retrieved.version, "1.0.0");

    // Update
    let mut updated = retrieved;
    updated.version = "2.0.0".to_string();
    updated.updated_at = crate::utils::now_iso();
    db.save_plugin(&updated).unwrap();
    let re_retrieved = db.get_plugin("crud-plugin").unwrap();
    assert_eq!(re_retrieved.version, "2.0.0");

    // Delete
    db.delete_plugin("crud-plugin").unwrap();
    assert!(db.get_plugin("crud-plugin").is_err());
}

#[test]
fn plugin_upsert_preserves_documents_and_attachments() {
    let db = Database::in_memory().unwrap();
    let mut plugin = create_test_plugin("persistent-plugin", "Persistent Plugin");
    plugin.created_at = "2026-06-01T00:00:00Z".to_string();
    plugin.updated_at = plugin.created_at.clone();
    db.save_plugin(&plugin).unwrap();

    let document = Document {
        id: "preferences".to_string(),
        rev: None,
        data: serde_json::json!({"theme": "dark"}),
    };
    db.plugin_data_put(&plugin.id, &document).unwrap();
    db.put_attachment(
        &plugin.id,
        &document.id,
        "avatar.png",
        b"preserved-image",
        "image/png",
    )
    .unwrap();

    plugin.version = "2.0.0".to_string();
    plugin.enabled = false;
    plugin.created_at = "2030-01-01T00:00:00Z".to_string();
    plugin.updated_at = "2026-07-10T00:00:00Z".to_string();
    db.save_plugin(&plugin).unwrap();

    let saved = db.get_plugin(&plugin.id).unwrap();
    assert_eq!(saved.version, "2.0.0");
    assert!(!saved.enabled);
    assert_eq!(saved.created_at, "2026-06-01T00:00:00Z");
    assert_eq!(saved.updated_at, "2026-07-10T00:00:00Z");
    assert_eq!(
        db.plugin_data_get(&plugin.id, &document.id)
            .unwrap()
            .unwrap()
            .data,
        document.data
    );
    assert_eq!(
        db.get_attachment(&plugin.id, &document.id, "avatar.png")
            .unwrap()
            .unwrap(),
        (b"preserved-image".to_vec(), "image/png".to_string())
    );
}

#[test]
fn save_plugin_with_features_rolls_back_metadata_features_and_data_on_feature_failure() {
    let db = Database::in_memory().unwrap();

    let competing_plugin = create_test_plugin("competing-plugin", "Competing Plugin");
    db.save_plugin_with_features(&competing_plugin, &[create_test_feature("shared-feature")])
        .unwrap();

    let mut plugin = create_test_plugin("atomic-plugin", "Atomic Plugin");
    plugin.created_at = "2026-06-01T00:00:00Z".to_string();
    plugin.updated_at = plugin.created_at.clone();
    let old_feature = create_test_feature("old-feature");
    db.save_plugin_with_features(&plugin, std::slice::from_ref(&old_feature))
        .unwrap();

    let document = Document {
        id: "state".to_string(),
        rev: None,
        data: serde_json::json!({"preserved": true}),
    };
    db.plugin_data_put(&plugin.id, &document).unwrap();
    db.put_attachment(
        &plugin.id,
        &document.id,
        "state.bin",
        b"atomic-attachment",
        "application/octet-stream",
    )
    .unwrap();

    {
        let conn = db.conn.lock();
        conn.execute_batch(
            r#"
                CREATE TEMP TRIGGER fail_atomic_plugin_feature_insert
                BEFORE INSERT ON features
                WHEN NEW.plugin_id = 'atomic-plugin' AND NEW.code = 'fail-feature'
                BEGIN
                    SELECT RAISE(ABORT, 'injected feature insert failure');
                END;
                "#,
        )
        .unwrap();
    }

    let mut updated = plugin.clone();
    updated.version = "2.0.0".to_string();
    updated.enabled = false;
    updated.updated_at = "2026-07-10T00:00:00Z".to_string();
    let error = db
        .save_plugin_with_features(
            &updated,
            &[
                create_test_feature("shared-feature"),
                create_test_feature("fail-feature"),
            ],
        )
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("injected feature insert failure"));

    let saved = db.get_plugin(&plugin.id).unwrap();
    assert_eq!(saved.version, "1.0.0");
    assert!(saved.enabled);
    assert_eq!(saved.created_at, "2026-06-01T00:00:00Z");
    assert_eq!(saved.updated_at, "2026-06-01T00:00:00Z");
    assert_eq!(
        db.get_feature(&old_feature.code).unwrap().plugin_id,
        plugin.id
    );
    assert_eq!(
        db.get_feature("shared-feature").unwrap().plugin_id,
        competing_plugin.id
    );
    assert!(db.get_feature("fail-feature").is_err());
    assert_eq!(
        db.plugin_data_get(&plugin.id, &document.id)
            .unwrap()
            .unwrap()
            .data,
        document.data
    );
    assert_eq!(
        db.get_attachment(&plugin.id, &document.id, "state.bin")
            .unwrap()
            .unwrap()
            .0,
        b"atomic-attachment"
    );
}

#[test]
fn test_list_plugins() {
    let db = Database::in_memory().unwrap();

    let plugin1 = create_test_plugin("plugin1", "Plugin 1");
    let plugin2 = create_test_plugin("plugin2", "Plugin 2");
    let plugin3 = create_test_plugin("plugin3", "Plugin 3");

    db.save_plugin(&plugin1).unwrap();
    db.save_plugin(&plugin2).unwrap();
    db.save_plugin(&plugin3).unwrap();

    let all = db.list_plugins().unwrap();
    assert_eq!(all.len(), 3);
    assert!(all.iter().any(|p| p.id == "plugin1"));
    assert!(all.iter().any(|p| p.id == "plugin2"));
    assert!(all.iter().any(|p| p.id == "plugin3"));
}

#[test]
fn test_feature_indexing_and_search() {
    let db = Database::in_memory().unwrap();

    let plugin = create_test_plugin("search-plugin", "Search Plugin");
    db.save_plugin(&plugin).unwrap();

    let features = vec![
        create_test_feature("calc"),
        create_test_feature("weather"),
        create_test_feature("translate"),
    ];

    db.index_features("search-plugin", &features).unwrap();

    let all = db.all_features().unwrap();
    assert_eq!(all.len(), 3);

    let calc = db.get_feature("calc").unwrap();
    assert_eq!(calc.code, "calc");
    assert_eq!(calc.plugin_id, "search-plugin");

    assert!(db.get_feature("nonexistent").is_err());
}

#[test]
fn test_feature_indexing_reassigns_duplicate_code_to_latest_plugin() {
    let db = Database::in_memory().unwrap();

    let old_plugin = create_test_plugin("json", "JSON");
    let new_plugin = create_test_plugin("json-viewer", "JSON Viewer");
    db.save_plugin(&old_plugin).unwrap();
    db.save_plugin(&new_plugin).unwrap();

    db.index_features("json", &[create_test_feature("json")])
        .unwrap();
    db.index_features("json-viewer", &[create_test_feature("json")])
        .unwrap();

    let feature = db.get_feature("json").unwrap();
    assert_eq!(feature.plugin_id, "json-viewer");
    assert_eq!(feature.plugin_name, "JSON Viewer");

    let all = db.all_features().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].code, "json");
    assert_eq!(all[0].plugin_id, "json-viewer");
}
