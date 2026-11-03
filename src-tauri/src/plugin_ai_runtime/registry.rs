use super::types::{Request, SOURCE};
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) fn tool_name(plugin: &str) -> String {
    let digest = Sha256::digest(plugin.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("atools.plugin.ai.{}", &hex[..24])
}
pub(crate) fn validate(tool: &ToolDefinition) -> Result<&str, String> {
    let plugin = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing AI plugin identity")?;
    if tool.source != SOURCE
        || tool.name != tool_name(plugin)
        || tool.scopes != [PermissionScope::Network]
    {
        return Err("Invalid plugin AI capability".into());
    }
    Ok(plugin)
}
pub(crate) fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition { name: name.clone(),
        description: format!("{}：按用户配置调用 AI 服务。", plugin.display_name()),
        input_schema: json!({"type":"object","properties":{"operation":{"const":"execute"},"requestId":{"type":"string","format":"uuid"}},"required":["operation","requestId"],"additionalProperties":false}),
        output_schema: None, scopes: vec![PermissionScope::Network], enabled_by_default: true, enabled: true,
        source: SOURCE.into(), plugin_id: Some(plugin.id.clone()) }]).map_err(|_| "Unable to register plugin AI capability")?;
    let registered = db
        .get_agent_tool(&name)
        .map_err(|_| "AI capability unavailable")?
        .ok_or("AI capability unavailable")?;
    if !registered.enabled {
        return Err("AI capability is disabled".into());
    }
    Ok(name)
}
pub(super) fn validate_request_identity(
    request: &Request,
    tool: &ToolDefinition,
) -> Result<(), String> {
    if validate(tool)? != request.owner.plugin || request.tool != tool.name {
        return Err("AI capability owner mismatch".into());
    }
    Ok(())
}
