//! A private PluginData capability per plugin, independent of Node and clipboard.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const SOURCE: &str = "plugin_data";
pub(crate) fn tool_name(id: &str) -> String {
    format!(
        "atools.host.data.{:.24}",
        format!("{:x}", Sha256::digest(id.as_bytes()))
    )
}
pub(super) fn validate(tool: &ToolDefinition) -> Result<&str, String> {
    let id = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing data plugin identity")?;
    if tool.source != SOURCE
        || tool.name != tool_name(id)
        || tool.scopes != vec![PermissionScope::PluginData]
    {
        return Err("Invalid plugin data capability".into());
    }
    Ok(id)
}
pub(crate) fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition { name:name.clone(),
        description:format!("{}：读取和保存此插件的本地数据。数据正文不会存入任务历史。",plugin.display_name()),
        input_schema:json!({"type":"object","properties":{"operation":{"enum":["open","request"]},
            "intentId":{"type":"string"},"sessionId":{"type":"string"},"invocationId":{"type":"string"},
            "method":{"type":"string"}},"required":["operation"],"additionalProperties":false}),
        output_schema:None,scopes:vec![PermissionScope::PluginData],enabled_by_default:true,enabled:true,
        source:SOURCE.into(),plugin_id:Some(plugin.id.clone()) }]).map_err(|_| "Unable to register plugin data capability")?;
    Ok(name)
}
