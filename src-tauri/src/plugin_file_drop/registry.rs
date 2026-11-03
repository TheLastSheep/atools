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
    format!("atools.host.file-drop.{}", &hex[..24])
}
pub(crate) fn validate(tool: &ToolDefinition) -> Result<&str, String> {
    let plugin = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing file-drop plugin identity")?;
    if tool.source != SOURCE
        || tool.name != tool_name(plugin)
        || tool.scopes != vec![PermissionScope::FileRead]
    {
        return Err("Invalid file-drop capability".into());
    }
    Ok(plugin)
}
pub(crate) fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(), description: format!("{}：读取你刚刚拖入此插件的本地文件。", plugin.display_name()),
        input_schema: json!({"type":"object","properties":{"operation":{"const":"read"},"requestId":{"type":"string","format":"uuid"}},"required":["operation","requestId"],"additionalProperties":false}),
        output_schema: None, scopes: vec![PermissionScope::FileRead], enabled_by_default: true,
        enabled: true, source: SOURCE.into(), plugin_id: Some(plugin.id.clone()),
    }]).map_err(|_| "Unable to register file-drop capability")?;
    Ok(name)
}
pub(super) fn validate_request_identity(
    request: &Request,
    tool: &ToolDefinition,
) -> Result<(), String> {
    if validate(tool)? != request.owner.plugin || request.tool != tool.name {
        return Err("File-drop capability owner mismatch".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn definition(plugin: &str) -> ToolDefinition {
        ToolDefinition {
            name: tool_name(plugin),
            description: "fixture".into(),
            input_schema: json!({}),
            output_schema: None,
            scopes: vec![PermissionScope::FileRead],
            enabled_by_default: true,
            enabled: true,
            source: SOURCE.into(),
            plugin_id: Some(plugin.into()),
        }
    }
    #[test]
    fn only_the_exact_plugin_hashed_file_read_capability_is_accepted() {
        let tool = definition("plugin-a");
        assert_eq!(tool.name.len(), "atools.host.file-drop.".len() + 24);
        assert_eq!(validate(&tool).unwrap(), "plugin-a");
        let mut wrong = tool.clone();
        wrong.name.push('x');
        assert!(validate(&wrong).is_err());
        let mut wrong = tool.clone();
        wrong.scopes.push(PermissionScope::Shell);
        assert!(validate(&wrong).is_err());
        let mut wrong = tool;
        wrong.plugin_id = None;
        assert!(validate(&wrong).is_err());
    }
}
