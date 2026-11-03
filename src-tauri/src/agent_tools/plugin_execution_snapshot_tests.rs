use super::*;
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    models::{Plugin, PluginManifest},
    task_run::TaskRunInitiator,
};
use serde_json::json;

fn fixture_plugin() -> Plugin {
    Plugin {
        id: "plugin-fixture".into(),
        name: "Fixture".into(),
        version: "1.0.0".into(),
        path: "/plugins/fixture".into(),
        enabled: true,
        manifest: PluginManifest {
            platform: vec![],
            name: "fixture".into(),
            title: None,
            version: "1.0.0".into(),
            main: None,
            logo: None,
            preload: None,
            description: None,
            author: None,
            homepage: None,
            plugin_setting: None,
            features: vec![],
            development: None,
            tools: Default::default(),
            providers: Default::default(),
            permissions: vec![],
            runtime: None,
        },
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    }
}

fn fixture_tool() -> ToolDefinition {
    ToolDefinition {
        name: "plugin_fixture_run".into(),
        description: "fixture".into(),
        input_schema: json!({"type":"object","properties":{"x":{"type":"string"}}}),
        output_schema: Some(json!({"type":"object"})),
        scopes: vec![PermissionScope::PluginData],
        enabled_by_default: false,
        enabled: true,
        source: "plugin".into(),
        plugin_id: Some("plugin-fixture".into()),
    }
}

#[test]
fn digest_is_canonical_and_binds_scopes_schemas_and_plugin_update_time() {
    let db = Database::in_memory().unwrap();
    let plugin = fixture_plugin();
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    let tool = fixture_tool();
    let base = snapshot_digest(&db, &tool).unwrap();

    let reordered = ToolDefinition {
        input_schema: json!({"properties":{"x":{"type":"string"}},"type":"object"}),
        ..tool.clone()
    };
    assert_eq!(snapshot_digest(&db, &reordered).unwrap(), base);

    let mut changed_scope = tool.clone();
    changed_scope.scopes.push(PermissionScope::FileRead);
    assert_ne!(snapshot_digest(&db, &changed_scope).unwrap(), base);

    let mut changed_schema = tool.clone();
    changed_schema.input_schema["properties"]["x"]["maxLength"] = json!(8);
    assert_ne!(snapshot_digest(&db, &changed_schema).unwrap(), base);

    let mut changed_plugin = plugin;
    changed_plugin.updated_at = "2026-01-02T00:00:00Z".into();
    db.save_plugin_with_features(&changed_plugin, &[]).unwrap();
    assert_ne!(snapshot_digest(&db, &tool).unwrap(), base);
}

#[test]
fn missing_or_mismatched_pending_approval_is_rejected() {
    let db = Database::in_memory().unwrap();
    db.save_plugin_with_features(&fixture_plugin(), &[])
        .unwrap();
    let tool = fixture_tool();
    let digest = snapshot_digest(&db, &tool).unwrap();
    let mut run = TaskRun::new(
        tool.name.clone(),
        TaskRunInitiator::agent("test-client"),
        json!({"x":"approved input"}),
    );
    run.transition(TaskRunStatus::AwaitingPermission).unwrap();
    record_snapshot(&mut run, &digest);

    assert!(validate_pending(&run, None, &tool, &digest).is_err());

    let request = PendingAgentToolRequest {
        id: "request-1".into(),
        run_id: Some(run.id.clone()),
        client_id: "test-client".into(),
        tool_name: tool.name.clone(),
        arguments: run.input.clone(),
        scopes: tool.scopes.clone(),
        created_at: run.created_at.clone(),
    };
    validate_pending(&run, Some(&request), &tool, &digest).unwrap();
    assert!(validate_pending(&run, Some(&request), &tool, "different-digest").is_err());

    let mut changed_request = request;
    changed_request.arguments = json!({"x":"different input"});
    assert!(validate_pending(&run, Some(&changed_request), &tool, &digest).is_err());
}

#[test]
fn created_public_task_rejects_code_replacement_with_identical_manifest_and_timestamp() {
    let db = Database::in_memory().unwrap();
    let plugin = fixture_plugin();
    let tool = fixture_tool();
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    db.sync_agent_tools(&[tool.clone()]).unwrap();
    let mut run = TaskRun::new(
        tool.name.clone(),
        TaskRunInitiator::agent("client"),
        json!({}),
    );
    bind_created(&db, &mut run).unwrap();
    db.upsert_task_run(&run).unwrap();
    let persisted = db.get_task_run(&run.id).unwrap().unwrap();
    validate_created(&persisted, &snapshot_digest(&db, &tool).unwrap()).unwrap();
    let revision = crate::plugin_code_revision::CodeRevision::begin(&db, &plugin.id).unwrap();
    assert!(
        snapshot_digest(&db, &tool).is_err(),
        "new tasks reject an incomplete code write"
    );
    revision.finish(&db).unwrap();
    assert_eq!(
        serde_json::to_value(db.get_plugin(&plugin.id).unwrap()).unwrap(),
        serde_json::to_value(&plugin).unwrap()
    );
    assert_eq!(plugin.version, "1.0.0");
    assert!(validate_created(&persisted, &snapshot_digest(&db, &tool).unwrap()).is_err());
}

#[test]
fn private_transport_created_calls_use_intent_generation_instead_of_a_metadata_digest() {
    let db = Database::in_memory().unwrap();
    for source in [
        crate::legacy_runtime::registry::SOURCE,
        crate::host_runtime::registry::SOURCE,
        crate::plugin_data_runtime::registry::SOURCE,
        crate::plugin_system_paths::registry::SOURCE,
        crate::plugin_dialog_runtime::registry::SOURCE,
    ] {
        let tool = ToolDefinition {
            source: source.into(),
            ..fixture_tool()
        };
        db.sync_agent_tools(&[tool.clone()]).unwrap();
        let mut run = TaskRun::new(
            tool.name.clone(),
            TaskRunInitiator::agent("client"),
            json!({}),
        );
        // There is deliberately no plugin record to hash on this hot path.
        bind_created(&db, &mut run).unwrap();
        assert!(run.output.get("capabilitySnapshot").is_none());
        assert!(!binds_created(&tool));
    }
}
