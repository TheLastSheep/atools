use super::*;
use serde_json::json;

fn regex_feature(code: &str, pattern: &str) -> Feature {
    let mut feature = create_test_feature(code);
    feature.cmds = vec![serde_json::from_value(json!({
        "type": "regex",
        "match": pattern,
    }))
    .unwrap()];
    feature
}

#[test]
fn first_metadata_refresh_uses_the_incoming_enabled_value() {
    let db = Database::in_memory().unwrap();

    for (id, enabled) in [("first-enabled", true), ("first-disabled", false)] {
        let mut plugin = create_test_plugin(id, id);
        plugin.enabled = enabled;
        let feature = create_test_feature(&format!("{id}-feature"));
        plugin.manifest.features = vec![feature.clone()];

        db.refresh_builtin_plugin_metadata_with_features(&plugin, &plugin.manifest.features)
            .unwrap();

        assert_eq!(db.get_plugin(id).unwrap().enabled, enabled);
        assert_eq!(db.features_by_plugin(id).unwrap().len(), 1);
        let catalog = db.feature_catalog_snapshot().unwrap();
        assert_eq!(catalog.find(id, &feature.code).is_some(), enabled);
    }
}

#[test]
fn existing_enabled_state_drives_metadata_refresh_and_warm_catalog() {
    let db = Database::in_memory().unwrap();
    let mut stored = create_test_plugin("refresh-enabled", "Before refresh");
    stored.created_at = "2026-06-01T00:00:00Z".into();
    stored.updated_at = stored.created_at.clone();
    let old_feature = regex_feature("refresh-old", "/^old$/");
    stored.manifest.features = vec![old_feature.clone()];
    db.refresh_builtin_plugin_metadata_with_features(&stored, &stored.manifest.features)
        .unwrap();
    let dynamic_declaration = json!({
        "code": "refresh-dynamic",
        "cmds": [{"type": "regex", "match": "/^dynamic$/"}],
    });
    db.plugin_dynamic_features_set(&stored.id, std::slice::from_ref(&dynamic_declaration))
        .unwrap();
    let before = db.feature_catalog_snapshot().unwrap();
    assert!(before.find(&stored.id, &old_feature.code).is_some());
    assert!(before.find(&stored.id, "refresh-dynamic").is_some());
    let compile_count = crate::matcher::typed_text_compile_count();

    let mut incoming = stored.clone();
    incoming.enabled = false;
    incoming.created_at = "2030-01-01T00:00:00Z".into();
    incoming.name = "After refresh".into();
    incoming.version = "2.0.0".into();
    incoming.path = "/builtin/refresh-enabled-v2".into();
    incoming.updated_at = "2026-07-10T00:00:00Z".into();
    incoming.manifest.name = incoming.name.clone();
    incoming.manifest.version = incoming.version.clone();
    let new_feature = regex_feature("refresh-new", "/^new$/");
    incoming.manifest.features = vec![new_feature.clone()];

    db.refresh_builtin_plugin_metadata_with_features(&incoming, &incoming.manifest.features)
        .unwrap();

    assert_eq!(
        crate::matcher::typed_text_compile_count(),
        compile_count + 1,
        "the persisted-enabled plugin's new rules are admitted during the write"
    );
    let saved = db.get_plugin(&stored.id).unwrap();
    assert!(
        saved.enabled,
        "stored enabled state must win over loader defaults"
    );
    assert_eq!(saved.created_at, "2026-06-01T00:00:00Z");
    assert_eq!(saved.updated_at, incoming.updated_at);
    assert_eq!(saved.name, incoming.name);
    assert_eq!(saved.version, incoming.version);
    assert_eq!(saved.path, incoming.path);
    assert_eq!(saved.manifest.features[0].code, new_feature.code);

    let after = db.feature_catalog_snapshot().unwrap();
    assert!(after.find(&stored.id, &old_feature.code).is_none());
    assert!(after.find(&stored.id, &new_feature.code).is_some());
    assert!(after.find(&stored.id, "refresh-dynamic").is_some());
    assert!(after.generation > before.generation);
    assert_eq!(
        db.plugin_dynamic_features(&stored.id, None).unwrap(),
        vec![dynamic_declaration]
    );
}

#[test]
fn existing_disabled_state_is_preserved_when_incoming_metadata_is_enabled() {
    let db = Database::in_memory().unwrap();
    let mut stored = create_test_plugin("refresh-disabled", "Disabled plugin");
    stored.enabled = false;
    let old_feature = create_test_feature("disabled-old");
    stored.manifest.features = vec![old_feature.clone()];
    db.refresh_builtin_plugin_metadata_with_features(&stored, &stored.manifest.features)
        .unwrap();
    let before = db.feature_catalog_snapshot().unwrap();
    assert!(before.find(&stored.id, &old_feature.code).is_none());

    let mut incoming = stored.clone();
    incoming.enabled = true;
    incoming.name = "Still disabled".into();
    let new_feature = create_test_feature("disabled-new");
    incoming.manifest.features = vec![new_feature.clone()];
    db.refresh_builtin_plugin_metadata_with_features(&incoming, &incoming.manifest.features)
        .unwrap();

    let saved = db.get_plugin(&stored.id).unwrap();
    assert!(!saved.enabled);
    assert_eq!(saved.name, incoming.name);
    assert!(db
        .feature_catalog_snapshot()
        .unwrap()
        .find(&stored.id, &new_feature.code)
        .is_none());
    assert_eq!(
        db.features_by_plugin(&stored.id).unwrap()[0].code,
        new_feature.code
    );
}

#[test]
fn file_refresh_preserves_plugin_data_and_attachments_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("metadata-refresh.db");
    let db = Database::open(&database_path).unwrap();
    let mut stored = create_test_plugin("refresh-file", "Before file refresh");
    stored.enabled = false;
    stored.created_at = "2026-06-01T00:00:00Z".into();
    stored.updated_at = stored.created_at.clone();
    let old_feature = create_test_feature("file-old");
    stored.manifest.features = vec![old_feature];
    db.refresh_builtin_plugin_metadata_with_features(&stored, &stored.manifest.features)
        .unwrap();

    let document = Document {
        id: "preferences".into(),
        rev: None,
        data: json!({"theme": "dark", "keep": true}),
    };
    db.plugin_data_put(&stored.id, &document).unwrap();
    db.put_attachment(
        &stored.id,
        &document.id,
        "state.bin",
        b"preserved-state",
        "application/octet-stream",
    )
    .unwrap();

    let mut incoming = stored.clone();
    incoming.enabled = true;
    incoming.created_at = "2030-01-01T00:00:00Z".into();
    incoming.name = "After file refresh".into();
    incoming.version = "2.0.0".into();
    incoming.path = "/builtin/refresh-file-v2".into();
    incoming.updated_at = "2026-07-10T00:00:00Z".into();
    incoming.manifest.name = incoming.name.clone();
    incoming.manifest.version = incoming.version.clone();
    incoming.manifest.title = Some("Refreshed title".into());
    let new_feature = create_test_feature("file-new");
    incoming.manifest.features = vec![new_feature.clone()];
    db.refresh_builtin_plugin_metadata_with_features(&incoming, &incoming.manifest.features)
        .unwrap();
    drop(db);

    let reopened = Database::open(&database_path).unwrap();
    let saved = reopened.get_plugin(&stored.id).unwrap();
    assert!(!saved.enabled);
    assert_eq!(saved.created_at, "2026-06-01T00:00:00Z");
    assert_eq!(saved.updated_at, incoming.updated_at);
    assert_eq!(saved.name, incoming.name);
    assert_eq!(saved.version, incoming.version);
    assert_eq!(saved.path, incoming.path);
    assert_eq!(saved.manifest.title.as_deref(), Some("Refreshed title"));
    assert_eq!(saved.manifest.features[0].code, new_feature.code);
    assert_eq!(
        reopened
            .plugin_data_get(&stored.id, &document.id)
            .unwrap()
            .unwrap()
            .data,
        document.data
    );
    assert_eq!(
        reopened
            .get_attachment(&stored.id, &document.id, "state.bin")
            .unwrap()
            .unwrap(),
        (
            b"preserved-state".to_vec(),
            "application/octet-stream".into()
        )
    );
}

#[test]
fn feature_failure_rolls_back_metadata_index_and_keeps_child_rows() {
    let db = Database::in_memory().unwrap();
    let mut stored = create_test_plugin("refresh-rollback", "Before rollback");
    stored.enabled = false;
    stored.created_at = "2026-06-01T00:00:00Z".into();
    stored.updated_at = stored.created_at.clone();
    let old_feature = create_test_feature("rollback-old");
    stored.manifest.features = vec![old_feature.clone()];
    db.refresh_builtin_plugin_metadata_with_features(&stored, &stored.manifest.features)
        .unwrap();

    let document = Document {
        id: "state".into(),
        rev: None,
        data: json!({"preserved": true}),
    };
    db.plugin_data_put(&stored.id, &document).unwrap();
    db.put_attachment(
        &stored.id,
        &document.id,
        "state.bin",
        b"rollback-attachment",
        "application/octet-stream",
    )
    .unwrap();
    {
        let conn = db.conn.lock();
        conn.execute_batch(
            r#"
            CREATE TEMP TRIGGER fail_builtin_refresh_feature_insert
            BEFORE INSERT ON features
            WHEN NEW.plugin_id = 'refresh-rollback' AND NEW.code = 'rollback-fail'
            BEGIN
                SELECT RAISE(ABORT, 'injected builtin refresh feature failure');
            END;
            "#,
        )
        .unwrap();
    }

    let mut incoming = stored.clone();
    incoming.enabled = true;
    incoming.created_at = "2030-01-01T00:00:00Z".into();
    incoming.name = "Must roll back".into();
    incoming.version = "2.0.0".into();
    incoming.updated_at = "2026-07-10T00:00:00Z".into();
    incoming.manifest.name = incoming.name.clone();
    incoming.manifest.version = incoming.version.clone();
    incoming.manifest.features = vec![
        create_test_feature("rollback-new"),
        create_test_feature("rollback-fail"),
    ];
    let error = db
        .refresh_builtin_plugin_metadata_with_features(&incoming, &incoming.manifest.features)
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("injected builtin refresh feature failure"));

    let saved = db.get_plugin(&stored.id).unwrap();
    assert_eq!(saved.name, stored.name);
    assert_eq!(saved.version, stored.version);
    assert_eq!(saved.path, stored.path);
    assert_eq!(saved.enabled, stored.enabled);
    assert_eq!(saved.created_at, stored.created_at);
    assert_eq!(saved.updated_at, stored.updated_at);
    assert_eq!(saved.manifest.features[0].code, old_feature.code);
    assert_eq!(
        db.features_by_plugin(&stored.id).unwrap()[0].code,
        old_feature.code
    );
    assert!(db.get_feature("rollback-new").is_err());
    assert_eq!(
        db.plugin_data_get(&stored.id, &document.id)
            .unwrap()
            .unwrap()
            .data,
        document.data
    );
    assert_eq!(
        db.get_attachment(&stored.id, &document.id, "state.bin")
            .unwrap()
            .unwrap()
            .0,
        b"rollback-attachment"
    );
}
