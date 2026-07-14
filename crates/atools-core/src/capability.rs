use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::{PermissionScope, ToolDefinition};
use crate::models::{Feature, Plugin};
use crate::skill::SkillDefinition;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySourceKind {
    BuiltinTool,
    PluginTool,
    PluginFeature,
    Skill,
    ExternalMcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityExecutorKind {
    Builtin,
    Plugin,
    SkillRecipe,
    ExternalMcp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySource {
    pub kind: CapabilitySourceKind,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityExecutor {
    pub kind: CapabilityExecutorKind,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityAvailability {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityCompatibility {
    pub tested_atools_version: String,
    pub platforms: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: CapabilitySource,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    pub permission_scopes: Vec<String>,
    pub human_invocable: bool,
    pub agent_invocable: bool,
    pub executor: CapabilityExecutor,
    pub availability: CapabilityAvailability,
    pub version: String,
    pub compatibility: CapabilityCompatibility,
}

impl Capability {
    pub fn from_tool(
        tool: &ToolDefinition,
        source_name: impl Into<String>,
        version: impl Into<String>,
        atools_version: &str,
    ) -> Self {
        let plugin_id = tool.plugin_id.clone();
        let is_plugin = plugin_id.is_some() || tool.source == "plugin";
        let available = tool.enabled;
        Self {
            id: tool.name.clone(),
            name: tool.name.clone(),
            description: tool.description.clone(),
            source: CapabilitySource {
                kind: if is_plugin {
                    CapabilitySourceKind::PluginTool
                } else {
                    CapabilitySourceKind::BuiltinTool
                },
                id: plugin_id.unwrap_or_else(|| "atools".to_string()),
                name: source_name.into(),
            },
            input_schema: tool.input_schema.clone(),
            output_schema: tool.output_schema.clone(),
            permission_scopes: tool.scopes.iter().map(permission_scope_id).collect(),
            human_invocable: !is_plugin && builtin_tool_human_invocable(&tool.name),
            agent_invocable: true,
            executor: CapabilityExecutor {
                kind: if is_plugin {
                    CapabilityExecutorKind::Plugin
                } else {
                    CapabilityExecutorKind::Builtin
                },
                id: tool.name.clone(),
            },
            availability: CapabilityAvailability {
                available,
                reason: (!available).then(|| "Tool is disabled".to_string()),
            },
            version: version.into(),
            compatibility: current_compatibility(atools_version),
        }
    }

    pub fn from_plugin_feature(plugin: &Plugin, feature: &Feature, atools_version: &str) -> Self {
        let capability_id = format!("plugin.feature.{}", feature.code);
        let mut permission_scopes = plugin
            .manifest
            .permissions
            .iter()
            .map(|scope| scope.trim())
            .filter(|scope| !scope.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        permission_scopes.sort();
        permission_scopes.dedup();
        Self {
            id: capability_id.clone(),
            name: feature
                .label
                .clone()
                .filter(|label| !label.trim().is_empty())
                .unwrap_or_else(|| feature.code.clone()),
            description: feature.explain.clone(),
            source: CapabilitySource {
                kind: CapabilitySourceKind::PluginFeature,
                id: plugin.id.clone(),
                name: plugin.name.clone(),
            },
            input_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "payload": { "description": "Plugin feature activation payload" }
                }
            }),
            output_schema: Some(json!({
                "type": "object",
                "properties": {
                    "plugin_id": { "type": "string" },
                    "feature_code": { "type": "string" },
                    "main_url": { "type": "string" }
                }
            })),
            permission_scopes,
            human_invocable: true,
            agent_invocable: false,
            executor: CapabilityExecutor {
                kind: CapabilityExecutorKind::Plugin,
                id: capability_id,
            },
            availability: CapabilityAvailability {
                available: plugin.enabled,
                reason: (!plugin.enabled).then(|| "Plugin is disabled".to_string()),
            },
            version: plugin.version.clone(),
            compatibility: current_compatibility(atools_version),
        }
    }

    pub fn from_skill(skill: &SkillDefinition, atools_version: &str) -> Self {
        let capability_id = format!("skill.{}", skill.id);
        Self {
            id: capability_id.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            source: CapabilitySource {
                kind: CapabilitySourceKind::Skill,
                id: skill.id.clone(),
                name: skill.source.clone(),
            },
            input_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "task": { "type": "string" }
                }
            }),
            output_schema: Some(json!({
                "type": "object",
                "properties": {
                    "runId": { "type": "string" },
                    "artifacts": { "type": "array" },
                    "validation": { "type": "object" }
                }
            })),
            permission_scopes: skill.permission_scopes.clone(),
            human_invocable: false,
            agent_invocable: true,
            executor: CapabilityExecutor {
                kind: CapabilityExecutorKind::SkillRecipe,
                id: capability_id,
            },
            availability: CapabilityAvailability {
                available: skill.enabled,
                reason: (!skill.enabled).then(|| "Skill is disabled".to_string()),
            },
            version: skill.version.clone(),
            compatibility: current_compatibility(atools_version),
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct CapabilityRegistry {
    capabilities: BTreeMap<String, Capability>,
}

impl CapabilityRegistry {
    pub fn register(&mut self, capability: Capability) {
        self.capabilities.insert(capability.id.clone(), capability);
    }

    pub fn get(&self, id: &str) -> Option<&Capability> {
        self.capabilities.get(id)
    }

    pub fn list_all(&self) -> Vec<Capability> {
        self.capabilities.values().cloned().collect()
    }

    pub fn list_available(&self) -> Vec<Capability> {
        self.capabilities
            .values()
            .filter(|capability| capability.availability.available)
            .cloned()
            .collect()
    }
}

pub fn capability_catalog(
    tools: &[ToolDefinition],
    plugins: &[Plugin],
    skills: &[SkillDefinition],
    atools_version: &str,
) -> Vec<Capability> {
    let plugin_context = plugins
        .iter()
        .map(|plugin| {
            (
                plugin.id.as_str(),
                (plugin.name.as_str(), plugin.version.as_str()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut registry = CapabilityRegistry::default();
    for tool in tools {
        let (source_name, version) = tool
            .plugin_id
            .as_deref()
            .and_then(|plugin_id| plugin_context.get(plugin_id).copied())
            .unwrap_or(("ATools", atools_version));
        registry.register(Capability::from_tool(
            tool,
            source_name,
            version,
            atools_version,
        ));
    }
    for plugin in plugins {
        for feature in &plugin.manifest.features {
            registry.register(Capability::from_plugin_feature(
                plugin,
                feature,
                atools_version,
            ));
        }
    }
    for skill in skills {
        registry.register(Capability::from_skill(skill, atools_version));
    }
    registry.list_all()
}

fn current_compatibility(atools_version: &str) -> CapabilityCompatibility {
    CapabilityCompatibility {
        tested_atools_version: atools_version.to_string(),
        platforms: vec!["macos".to_string()],
    }
}

fn permission_scope_id(scope: &PermissionScope) -> String {
    match scope {
        PermissionScope::ClipboardRead => "clipboard_read",
        PermissionScope::ClipboardWrite => "clipboard_write",
        PermissionScope::FileRead => "file_read",
        PermissionScope::FileWrite => "file_write",
        PermissionScope::Network => "network",
        PermissionScope::Shell => "shell",
        PermissionScope::Screenshot => "screenshot",
        PermissionScope::BrowserContext => "browser_context",
        PermissionScope::PluginData => "plugin_data",
        PermissionScope::SystemSettings => "system_settings",
    }
    .to_string()
}

fn builtin_tool_human_invocable(name: &str) -> bool {
    matches!(
        name,
        "compress_images" | "ocr_image" | "open_or_reveal_path" | "open_url"
    )
}
