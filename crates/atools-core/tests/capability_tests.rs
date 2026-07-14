use std::collections::HashMap;

use atools_core::agent::{PermissionScope, ToolDefinition};
use atools_core::capability::{capability_catalog, CapabilityExecutorKind, CapabilitySourceKind};
use atools_core::models::{Cmd, Feature, Plugin, PluginManifest};
use atools_core::skill::{SkillDefinition, SkillResultSuggestion, SkillStep, SkillValidationRule};
use serde_json::json;

#[test]
fn catalog_normalizes_tools_plugin_features_and_skills() {
    let tool = ToolDefinition {
        name: "find_local_files".to_string(),
        description: "Find files".to_string(),
        input_schema: json!({ "type": "object" }),
        output_schema: Some(json!({ "type": "object" })),
        scopes: vec![PermissionScope::FileRead],
        enabled_by_default: true,
        enabled: true,
        source: "builtin".to_string(),
        plugin_id: None,
    };
    let plugin = sample_plugin();
    let skill = sample_skill();

    let catalog = capability_catalog(&[tool], &[plugin], &[skill], "3.0.0");

    assert_eq!(catalog.len(), 3);
    let tool = catalog
        .iter()
        .find(|capability| capability.id == "find_local_files")
        .expect("builtin tool capability");
    assert_eq!(tool.source.kind, CapabilitySourceKind::BuiltinTool);
    assert_eq!(tool.executor.kind, CapabilityExecutorKind::Builtin);
    assert_eq!(tool.permission_scopes, vec!["file_read"]);
    assert!(tool.agent_invocable);
    assert!(!tool.human_invocable);

    let feature = catalog
        .iter()
        .find(|capability| capability.id == "plugin.feature.timestamp")
        .expect("plugin feature capability");
    assert_eq!(feature.source.kind, CapabilitySourceKind::PluginFeature);
    assert_eq!(feature.source.id, "timestamp-plugin");
    assert_eq!(feature.version, "2.1.0");
    assert_eq!(
        feature.permission_scopes,
        vec!["clipboard.read", "shell.open"]
    );
    assert!(feature.human_invocable);
    assert!(!feature.agent_invocable);

    let skill = catalog
        .iter()
        .find(|capability| capability.id == "skill.compress-for-web")
        .expect("skill capability");
    assert_eq!(skill.source.kind, CapabilitySourceKind::Skill);
    assert_eq!(skill.executor.kind, CapabilityExecutorKind::SkillRecipe);
    assert_eq!(skill.version, "1.0.0");
    assert!(skill.agent_invocable);
}

#[test]
fn catalog_serializes_the_north_star_minimum_contract() {
    let mut catalog = capability_catalog(
        &[ToolDefinition {
            name: "open_url".to_string(),
            description: "Open an http URL".to_string(),
            input_schema: json!({ "type": "object" }),
            output_schema: None,
            scopes: vec![PermissionScope::Network],
            enabled_by_default: true,
            enabled: false,
            source: "builtin".to_string(),
            plugin_id: None,
        }],
        &[],
        &[],
        "3.0.0",
    );
    let capability = catalog.remove(0);
    let value = serde_json::to_value(capability).expect("serialize capability");

    assert_eq!(value["id"], "open_url");
    assert_eq!(value["inputSchema"]["type"], "object");
    assert_eq!(value["permissionScopes"][0], "network");
    assert_eq!(value["agentInvocable"], true);
    assert_eq!(value["humanInvocable"], true);
    assert_eq!(value["availability"]["available"], false);
    assert_eq!(value["compatibility"]["testedAtoolsVersion"], "3.0.0");
}

fn sample_plugin() -> Plugin {
    Plugin {
        id: "timestamp-plugin".to_string(),
        name: "Timestamp".to_string(),
        version: "2.1.0".to_string(),
        path: "/tmp/timestamp-plugin".to_string(),
        enabled: true,
        manifest: PluginManifest {
            name: "timestamp-plugin".to_string(),
            version: "2.1.0".to_string(),
            main: Some("index.html".to_string()),
            logo: None,
            preload: None,
            description: Some("Timestamp utilities".to_string()),
            author: None,
            homepage: None,
            plugin_setting: None,
            features: vec![Feature {
                code: "timestamp".to_string(),
                label: Some("Timestamp converter".to_string()),
                explain: "Convert timestamps".to_string(),
                icon: None,
                main_push: true,
                main_hide: false,
                cmds: vec![Cmd::Text("timestamp".to_string())],
            }],
            development: None,
            tools: HashMap::new(),
            permissions: vec![
                "shell.open".to_string(),
                "clipboard.read".to_string(),
                "shell.open".to_string(),
            ],
        },
        created_at: "2026-07-14T00:00:00Z".to_string(),
        updated_at: "2026-07-14T00:00:00Z".to_string(),
    }
}

fn sample_skill() -> SkillDefinition {
    SkillDefinition::new(
        "compress-for-web".to_string(),
        "Compress for web".to_string(),
        "Compress and validate images".to_string(),
        "1.0.0".to_string(),
        vec!["compress images".to_string()],
        vec!["compress_images".to_string()],
        vec![SkillStep {
            id: "compress".to_string(),
            capability_id: "compress_images".to_string(),
            description: "Compress files".to_string(),
            input: json!({}),
            optional: false,
        }],
        vec!["file_read".to_string(), "file_write".to_string()],
        vec![],
        vec![SkillValidationRule {
            id: "result".to_string(),
            label: "Result".to_string(),
            description: "Outputs exist".to_string(),
            kind: "manual".to_string(),
            config: json!({}),
            required: true,
        }],
        vec![SkillResultSuggestion {
            id: "images".to_string(),
            label: "Images".to_string(),
            kind: "artifact_renderer".to_string(),
            config: json!({ "renderer": "image_grid" }),
        }],
        "local".to_string(),
    )
    .expect("valid sample skill")
}
