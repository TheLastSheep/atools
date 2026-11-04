#![allow(dead_code, clippy::cloned_ref_to_slice_refs)]

use atools_core::{Database, Feature, Plugin, PluginManifest};
use serde_json::{json, Value};

fn plugin(manifest: Value) -> Plugin {
    Plugin {
        id: "platform-provider".into(),
        name: "Platform provider".into(),
        version: "1".into(),
        path: "/nonexistent/platform-provider".into(),
        enabled: true,
        manifest: serde_json::from_value(manifest).unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

#[test]
fn declared_plugin_and_feature_platforms_survive_database_persistence() {
    let db = Database::in_memory().unwrap();
    let p = plugin(json!({
        "name": "platform-provider", "platform": ["darwin", "win32"],
        "features": [{"code": "windows-only", "platform": ["win32"], "cmds": ["find"]}]
    }));
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let restored = db.get_plugin(&p.id).unwrap();
    assert_eq!(restored.manifest.platform, ["darwin", "win32"]);
    assert_eq!(restored.manifest.features[0].platform, ["win32"]);
    assert_eq!(
        serde_json::to_value(restored.manifest).unwrap()["features"][0]["platform"],
        json!(["win32"])
    );
}

#[test]
fn omitted_platforms_remain_unrestricted_and_do_not_change_legacy_serialization() {
    let p = plugin(json!({"name": "platform-provider", "features": [{"code": "any"}]}));
    assert!(p.manifest.platform.is_empty());
    assert!(p.manifest.features[0].platform.is_empty());
    let serialized = serde_json::to_value(p.manifest).unwrap();
    assert!(serialized.get("platform").is_none());
    assert!(serialized["features"][0].get("platform").is_none());
}

#[test]
fn dynamic_feature_platforms_are_available_from_authoritative_declarations() {
    let db = Database::in_memory().unwrap();
    let p = plugin(json!({"name": "platform-provider"}));
    db.save_plugin_with_features(&p, &[]).unwrap();
    let value = json!({"code": "dynamic", "mainPush": true,
        "platform": ["linux"], "cmds": ["dynamic"]});
    db.plugin_dynamic_features_set(&p.id, &[value.clone()])
        .unwrap();
    let declarations = db
        .plugin_dynamic_features(&p.id, Some(&["dynamic".into()]))
        .unwrap();
    assert_eq!(declarations, [value]);
    let feature: Feature = serde_json::from_value(declarations[0].clone()).unwrap();
    assert_eq!(feature.platform, ["linux"]);
    assert!(db.get_plugin(&p.id).unwrap().manifest.features.is_empty());
}

#[test]
fn invalid_platform_shapes_cannot_silently_become_unrestricted() {
    for platform in [json!("darwin"), json!([true]), json!(null), json!({})] {
        assert!(serde_json::from_value::<PluginManifest>(json!({
            "name": "p", "platform": platform
        }))
        .is_err());
        assert!(serde_json::from_value::<Feature>(json!({
            "code": "f", "platform": platform
        }))
        .is_err());
    }
}
