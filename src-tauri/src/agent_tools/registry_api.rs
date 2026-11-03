use super::*;
use atools_core::agent::ToolRegistry;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentScopePolicy {
    pub scope: String,
    pub label: String,
    pub description: String,
    pub decision: String,
    pub high_risk: bool,
}

pub fn builtin_tool_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    for tool in [
        ask_ai_model_tool(),
        compress_images_tool(),
        find_local_files_tool(),
        get_current_context_tool(),
        ocr_image_tool(),
        open_or_reveal_path_tool(),
        open_url_tool(),
        rename_files_tool(),
        search_clipboard_tool(),
        crate::launcher_media_clipboard::tool_definition(),
        crate::launcher_clipboard_context::tool_definition(),
        crate::plugin_source_build::registry::tool_definition(),
        crate::plugin_source_build::registry::inspection_tool_definition(),
        crate::plugin_source_build::dependency_tool_definitions()[0].clone(),
        crate::plugin_source_build::dependency_tool_definitions()[1].clone(),
        crate::plugin_source_build::dependency_tool_definitions()[2].clone(),
    ] {
        registry.register(tool);
    }
    registry
}

pub fn sync_builtin_tools(db: &Database) -> Result<(), String> {
    db.sync_agent_tools(&builtin_tool_registry().list_all())
        .map_err(|e| e.to_string())
}

pub fn sync_plugin_tools(db: &Database) -> Result<(), String> {
    let tools = db
        .list_plugins()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|plugin| plugin.enabled)
        .flat_map(|plugin| plugin_manifest_tool_definitions(&plugin))
        .collect::<Vec<_>>();
    db.sync_agent_tools(&tools).map_err(|e| e.to_string())?;
    let names = tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    db.delete_agent_tools_by_source_except("plugin", &names)
        .map_err(|e| e.to_string())?;
    crate::legacy_runtime::registry::prune(db)?;
    crate::plugin_main_push::registry::prune(db)?;
    Ok(())
}

pub fn list_enabled_tools(db: &Database) -> Result<Vec<ToolDefinition>, String> {
    Ok(db
        .list_agent_tools()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|tool| tool.enabled)
        .collect())
}

pub fn enabled_tool_registry(db: &Database) -> Result<ToolRegistry, String> {
    let mut registry = ToolRegistry::default();
    for tool in list_enabled_tools(db)? {
        registry.register(tool);
    }
    Ok(registry)
}

pub fn plugin_manifest_tool_definitions(plugin: &Plugin) -> Vec<ToolDefinition> {
    let mut tools = plugin
        .manifest
        .tools
        .iter()
        .filter_map(|(tool_name, manifest)| {
            let normalized_tool_name = agent_plugin_tool_name(&plugin.id, tool_name)?;
            let description = if manifest.description.trim().is_empty() {
                format!("{}: {}", plugin.name, tool_name)
            } else {
                format!("{}: {}", plugin.name, manifest.description.trim())
            };
            let input_schema = if manifest.input_schema.is_null() {
                json!({ "type": "object", "additionalProperties": true })
            } else {
                manifest.input_schema.clone()
            };
            Some(ToolDefinition {
                name: normalized_tool_name,
                description,
                input_schema,
                output_schema: manifest.output_schema.clone(),
                scopes: vec![PermissionScope::PluginData],
                enabled_by_default: false,
                enabled: false,
                source: "plugin".to_string(),
                plugin_id: Some(plugin.id.clone()),
            })
        })
        .collect::<Vec<_>>();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    tools
}

pub(super) fn agent_plugin_tool_name(plugin_id: &str, tool_name: &str) -> Option<String> {
    let plugin = tool_name_part(plugin_id)?;
    let tool = tool_name_part(tool_name)?;
    Some(format!("plugin_{}_{}", plugin, tool))
}

pub(super) fn tool_name_part(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let sanitized = atools_core::utils::sanitize_id(trimmed)
        .replace('-', "_")
        .to_lowercase();
    (!sanitized.is_empty()).then_some(sanitized)
}

pub fn list_agent_scope_policies(db: &Database) -> Result<Vec<AgentScopePolicy>, String> {
    let policy = persisted_scope_policy(db)?;
    Ok(all_permission_scopes()
        .into_iter()
        .map(|scope| {
            let scope_id = permission_scope_id(scope);
            let decision = policy
                .get(scope_id)
                .cloned()
                .unwrap_or_else(|| "confirm".to_string());
            AgentScopePolicy {
                scope: scope_id.to_string(),
                label: permission_scope_label(scope).to_string(),
                description: permission_scope_description(scope).to_string(),
                decision,
                high_risk: permission_scope_is_high_risk(scope),
            }
        })
        .collect())
}

pub fn set_agent_scope_policy(
    db: &Database,
    scope: &str,
    decision: &str,
) -> Result<Vec<AgentScopePolicy>, String> {
    let normalized_scope = normalize_scope_id(scope)?;
    let normalized_decision = match decision {
        "deny" => "deny",
        "confirm" | "allow" | "default" => "confirm",
        _ => return Err(format!("Unsupported scope decision: {}", decision)),
    };
    let mut policy = persisted_scope_policy(db)?;
    if normalized_decision == "deny" {
        policy.insert(
            normalized_scope.to_string(),
            normalized_decision.to_string(),
        );
    } else {
        policy.remove(normalized_scope);
    }
    let value = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
    db.set_setting(AGENT_SCOPE_POLICY_SETTING, &value)
        .map_err(|e| e.to_string())?;
    list_agent_scope_policies(db)
}
