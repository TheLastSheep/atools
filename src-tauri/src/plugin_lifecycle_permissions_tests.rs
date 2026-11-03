use super::*;
use serde_json::json;

fn tool(name: &str, plugin: &str) -> atools_core::agent::ToolDefinition {
    serde_json::from_value(json!({
        "name":name,"description":"synthetic fixture", "input_schema":{"type":"object"},
        "scopes":[],"enabled":true,"source":"plugin","plugin_id":plugin,
        "enabled_by_default":true
    }))
    .unwrap()
}

#[test]
fn replacing_one_plugin_revokes_its_grants_for_every_client_and_preserves_others() {
    let db = Database::in_memory().unwrap();
    db.sync_agent_tools(&[
        tool("plugin.a.one", "a"),
        tool("plugin.a.two", "a"),
        tool("plugin.b.one", "b"),
    ])
    .unwrap();
    for (client, name) in [
        ("ui", "plugin.a.one"),
        ("agent", "plugin.a.one"),
        ("ui", "plugin.a.two"),
        ("ui", "plugin.b.one"),
    ] {
        db.grant_agent_tool(client, name).unwrap();
    }
    revoke_code_grants(&db, "a").unwrap();
    for (client, name) in [
        ("ui", "plugin.a.one"),
        ("agent", "plugin.a.one"),
        ("ui", "plugin.a.two"),
    ] {
        assert!(!db.is_agent_tool_granted(client, name).unwrap());
    }
    assert!(db.is_agent_tool_granted("ui", "plugin.b.one").unwrap());
    revoke_code_grants(&db, "absent").unwrap();
    assert!(db.is_agent_tool_granted("ui", "plugin.b.one").unwrap());
}

#[test]
fn code_replacement_revokes_private_grants_after_tool_rows_were_pruned() {
    let db = Database::in_memory().unwrap();
    let names = [
        crate::legacy_runtime::registry::tool_name("fixture"),
        crate::plugin_data_runtime::registry::tool_name("fixture"),
        crate::plugin_system_paths::registry::tool_name(
            "fixture",
            crate::plugin_system_paths::registry::Access::Standard,
        ),
        crate::plugin_system_paths::registry::tool_name(
            "fixture",
            crate::plugin_system_paths::registry::Access::PluginData,
        ),
        crate::host_runtime::registry::tool_name(
            "fixture",
            crate::host_runtime::registry::Access::Read,
        ),
        crate::host_runtime::registry::tool_name(
            "fixture",
            crate::host_runtime::registry::Access::Write,
        ),
    ];
    for name in &names {
        db.grant_agent_tool("ui", name).unwrap();
    }
    let unrelated = crate::legacy_runtime::registry::tool_name("other");
    db.grant_agent_tool("ui", &unrelated).unwrap();
    assert!(db.list_agent_tools().unwrap().is_empty());
    revoke_code_grants(&db, "fixture").unwrap();
    for name in &names {
        assert!(!db.is_agent_tool_granted("ui", name).unwrap());
    }
    assert!(db.is_agent_tool_granted("ui", &unrelated).unwrap());
}

#[test]
fn newly_installed_disabled_manifest_cannot_inherit_an_orphan_public_grant() {
    let db = Database::in_memory().unwrap();
    let plugin = serde_json::from_value(json!({
        "id":"fixture", "name":"Fixture", "version":"1", "path":"/fixture",
        "enabled":false, "created_at":"test", "updated_at":"test",
        "manifest":{"name":"fixture", "tools":{"new_tool":{"description":"fixture"}}}
    }))
    .unwrap();
    db.grant_agent_tool("ui", "plugin_fixture_new_tool")
        .unwrap();
    // The previous tool row was already removed. The replacement introduces
    // this name while disabled, so sync_plugin_tools does not register it yet.
    revoke_code_grants(&db, "fixture").unwrap();
    assert!(db
        .is_agent_tool_granted("ui", "plugin_fixture_new_tool")
        .unwrap());
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    crate::agent_tools::sync_plugin_tools(&db).unwrap();
    assert!(db
        .get_agent_tool("plugin_fixture_new_tool")
        .unwrap()
        .is_none());
    revoke_code_grants(&db, "fixture").unwrap();
    assert!(!db
        .is_agent_tool_granted("ui", "plugin_fixture_new_tool")
        .unwrap());
}
