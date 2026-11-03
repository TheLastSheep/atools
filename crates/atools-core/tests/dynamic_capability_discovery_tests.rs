use atools_core::{
    agent::ToolRegistry,
    capability::{capability_catalog_from_db, CapabilitySourceKind},
    mcp::handle_mcp_message_with_capabilities,
    Database, Plugin,
};
use serde_json::{json, Value};

fn plugin() -> Plugin {
    Plugin {
        id: "memo".into(),
        name: "memo".into(),
        version: "1.2".into(),
        path: "/unused/memo".into(),
        enabled: true,
        manifest: serde_json::from_value(
            json!({"name":"memo","title":"备忘工具","permissions":["plugin_data"],
            "features":[{"code":"static-memo","label":"固定入口","cmds":["备忘"]}]}),
        )
        .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

fn resource(db: &Database) -> Vec<Value> {
    let capabilities = capability_catalog_from_db(db, "3.0.0").unwrap();
    let response = handle_mcp_message_with_capabilities(&ToolRegistry::default(), &[], &capabilities,
        json!({"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"atools://capabilities"}}),
        |_| panic!("Discovery must not execute a tool")).unwrap();
    let payload: Value =
        serde_json::from_str(response["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    payload
        .as_array()
        .cloned()
        .unwrap_or_else(|| payload["capabilities"].as_array().unwrap().clone())
}

#[test]
fn registration_and_removal_are_visible_through_real_mcp_resource_dispatch() {
    let db = Database::in_memory().unwrap();
    let installed = plugin();
    db.save_plugin_with_features(&installed, &installed.manifest.features)
        .unwrap();
    assert!(!resource(&db)
        .iter()
        .any(|cap| cap["id"] == "plugin.feature.tag-work"));
    db.plugin_dynamic_features_set(
        "memo",
        &[json!({"code":"tag-work","explain":"工作标签","cmds":["工作资料"]})],
    )
    .unwrap();
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert!(snapshot
        .search("工作资料")
        .iter()
        .any(|item| item.feature_code == "tag-work"));
    let live = resource(&db);
    let dynamic = live
        .iter()
        .find(|cap| cap["id"] == "plugin.feature.tag-work")
        .unwrap();
    assert_eq!(dynamic["source"]["id"], "memo");
    assert_eq!(dynamic["source"]["name"], "备忘工具");
    assert_eq!(dynamic["availability"]["available"], true);
    assert_eq!(dynamic["permissionScopes"], json!(["plugin_data"]));
    assert_eq!(dynamic["agentInvocable"], false); // Discovery cannot broaden execution permissions.
    assert_eq!(dynamic["executor"]["id"], "plugin.feature.tag-work");
    assert!(live
        .iter()
        .any(|cap| cap["id"] == "plugin.feature.static-memo"));
    db.plugin_dynamic_features_remove("memo", &["tag-work".into()])
        .unwrap();
    assert!(!resource(&db)
        .iter()
        .any(|cap| cap["id"] == "plugin.feature.tag-work"));
    assert!(db
        .feature_catalog_snapshot()
        .unwrap()
        .search("工作资料")
        .is_empty());
}

#[test]
fn discovery_reuses_live_index_ownership_and_preserves_static_descriptor_and_disabled_semantics() {
    let db = Database::in_memory().unwrap();
    let mut installed = plugin();
    db.save_plugin_with_features(&installed, &installed.manifest.features)
        .unwrap();
    db.plugin_dynamic_features_set("memo", &[json!({"code":"tag-work","cmds":["工作"]})])
        .unwrap();
    let active = capability_catalog_from_db(&db, "3.0.0").unwrap();
    let declared = active
        .iter()
        .find(|cap| cap.id == "plugin.feature.static-memo")
        .unwrap();
    assert_eq!(declared.name, "固定入口");
    assert_eq!(declared.source.kind, CapabilitySourceKind::PluginFeature);
    assert!(declared.availability.available);
    installed.enabled = false;
    db.save_plugin(&installed).unwrap();
    let disabled = resource(&db);
    assert!(!disabled
        .iter()
        .any(|cap| cap["id"] == "plugin.feature.tag-work"));
    assert_eq!(
        disabled
            .iter()
            .find(|cap| cap["id"] == "plugin.feature.static-memo")
            .unwrap()["availability"]["available"],
        false
    );
    installed.enabled = true;
    db.save_plugin(&installed).unwrap();
    assert!(resource(&db)
        .iter()
        .any(|cap| cap["id"] == "plugin.feature.tag-work"));
    db.delete_feature("memo", "static-memo").unwrap();
    assert!(!resource(&db)
        .iter()
        .any(|cap| cap["id"] == "plugin.feature.static-memo"));
    db.delete_plugin("memo").unwrap();
    assert!(!resource(&db)
        .iter()
        .any(|cap| cap["source"]["id"] == "memo"));
}

#[test]
fn resource_ids_and_fields_are_deterministic_when_no_registry_metadata_changed() {
    let db = Database::in_memory().unwrap();
    let installed = plugin();
    db.save_plugin_with_features(&installed, &installed.manifest.features)
        .unwrap();
    db.plugin_dynamic_features_set(
        "memo",
        &[
            json!({"code":"tag-b","cmds":["B"]}),
            json!({"code":"tag-a","cmds":["A"]}),
        ],
    )
    .unwrap();
    let first = resource(&db);
    assert_eq!(first, resource(&db));
    let ids = first
        .iter()
        .map(|value| value["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted);
}
