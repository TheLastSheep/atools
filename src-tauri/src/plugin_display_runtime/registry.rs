//! Display metadata has its own permission; it grants no pixels or input hooks.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde_json::json;
use sha2::{Digest, Sha256};
pub const SOURCE: &str = "plugin_display";
pub fn tool_name(plugin: &str) -> String {
    format!(
        "atools.host.display.{:.24}.read",
        format!("{:x}", Sha256::digest(plugin.as_bytes()))
    )
}
pub fn validate_tool(tool: &ToolDefinition) -> Result<(), String> {
    let plugin = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing display plugin identity")?;
    if tool.source != SOURCE
        || tool.name != tool_name(plugin)
        || tool.scopes != vec![PermissionScope::DisplayRead]
    {
        return Err("Invalid display capability identity".into());
    }
    Ok(())
}
pub fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(),
        description: format!("{}：读取显示器布局和当前指针位置。仅按调用读取元数据，不截屏、不监听输入；位置不会存入任务历史。", plugin.display_name()),
        input_schema: json!({"type":"object","properties":{
            "operation":{"type":"string","enum":["open","request"]},
            "intentId":{"type":"string"},"sessionId":{"type":"string"},"invocationId":{"type":"string"}
        },"required":["operation"],"additionalProperties":false}),
        output_schema: None, scopes: vec![PermissionScope::DisplayRead],
        enabled_by_default: true, enabled: true, source: SOURCE.into(), plugin_id: Some(plugin.id.clone()),
    }]).map_err(|_| "Unable to register display capability")?;
    Ok(name)
}
