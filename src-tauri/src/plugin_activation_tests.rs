//! Cached feature codes must obey the current persisted plugin state.
use atools_core::{Database, Plugin};
use serde_json::json;

#[test]
fn a_cached_code_cannot_activate_a_disabled_plugin() {
    let db = Database::in_memory().unwrap();
    let manifest = serde_json::from_value(json!({"name":"activation-fixture","main":"index.html","features":[{"code":"cached-code","cmds":["cached"]}]})).unwrap();
    let mut plugin = Plugin {
        id: "activation-fixture".into(),
        name: "activation-fixture".into(),
        version: "1".into(),
        path: "/synthetic/never-executed".into(),
        enabled: true,
        manifest,
        created_at: "old".into(),
        updated_at: "old".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    assert_eq!(
        crate::commands::activate_feature_inner(&db, "cached-code", None)
            .unwrap()
            .plugin_id,
        plugin.id
    );
    plugin.enabled = false;
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    assert!(
        crate::commands::activate_feature_inner(&db, "cached-code", None)
            .err()
            .expect("disabled cached feature must be rejected")
            .contains("disabled")
    );
}

#[test]
fn activation_projects_a_manifest_label_without_changing_identity_or_payload() {
    let db = Database::in_memory().unwrap();
    let manifest = serde_json::from_value(json!({
        "name":"presentation-fixture",
        "main":"index.html",
        "features":[{"code":"stable-code","label":"  可读名称  ","cmds":[]}]
    }))
    .unwrap();
    let plugin = Plugin {
        id: "presentation-plugin".into(),
        name: "presentation-fixture".into(),
        version: "1".into(),
        path: "/synthetic/never-executed".into(),
        enabled: true,
        manifest,
        created_at: "old".into(),
        updated_at: "old".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();

    let payload = json!({"text":"原样 payload", "nested":{"value":7}});
    let action =
        crate::commands::activate_feature_inner(&db, "stable-code", Some(payload.clone())).unwrap();
    assert_eq!(action.feature_code, "stable-code");
    assert_eq!(action.feature_label.as_deref(), Some("可读名称"));
    assert_eq!(action.feature_label_source, Some("declared"));
    assert_eq!(action.payload, payload);

    let serialized = serde_json::to_value(&action).unwrap();
    assert_eq!(serialized["feature_code"], json!("stable-code"));
    assert_eq!(serialized["feature_label"], json!("可读名称"));
    assert_eq!(serialized["feature_label_source"], json!("declared"));
    assert_eq!(serialized["payload"], payload);
}

#[test]
fn activation_does_not_project_the_database_code_fallback_as_a_label() {
    let db = Database::in_memory().unwrap();
    let manifest = serde_json::from_value(json!({
        "name":"fallback-fixture",
        "main":"index.html",
        "features":[{"code":"opaque-code","cmds":[]}]
    }))
    .unwrap();
    let plugin = Plugin {
        id: "fallback-plugin".into(),
        name: "fallback-fixture".into(),
        version: "1".into(),
        path: "/synthetic/never-executed".into(),
        enabled: true,
        manifest,
        created_at: "old".into(),
        updated_at: "old".into(),
    };
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();

    let action = crate::commands::activate_feature_inner(&db, "opaque-code", None).unwrap();
    assert_eq!(action.feature_code, "opaque-code");
    assert_eq!(action.feature_label, None);
    assert_eq!(action.feature_label_source, None);
    let serialized = serde_json::to_value(action).unwrap();
    assert!(serialized.get("feature_label").is_none());
    assert!(serialized.get("feature_label_source").is_none());
}
