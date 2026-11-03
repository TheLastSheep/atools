use atools_core::agent::{PermissionScope, ToolDefinition};
use atools_core::db::Database;
use atools_core::Plugin;
use serde_json::json;
use sha2::{Digest, Sha256};

pub const SOURCE: &str = "legacy_node";
pub fn tool_name(plugin_id: &str) -> String {
    format!("legacy_node_{:x}", Sha256::digest(plugin_id.as_bytes()))
}
pub fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    let tool = ToolDefinition {
        name: name.clone(),
        description: format!("{}：使用本机 Node 模块。插件可以读写文件、联网、启动进程及访问本机系统；独立进程不是权限沙箱。仅为信任的插件授权。", plugin.display_name()),
        input_schema: json!({"type":"object","properties":{
            "operation":{"type":"string","enum":["open","request","close"]},
            "intentId":{"type":"string"},"sessionId":{"type":"string"},
            "invocationId":{"type":"string"},"method":{"type":"string"}
        },"required":["operation"],"additionalProperties":false}),
        output_schema: None,
        scopes: vec![PermissionScope::FileRead, PermissionScope::FileWrite, PermissionScope::Network,
            PermissionScope::Shell, PermissionScope::ClipboardRead, PermissionScope::ClipboardWrite,
            PermissionScope::Screenshot, PermissionScope::BrowserContext, PermissionScope::PluginData,
            PermissionScope::SystemSettings],
        enabled_by_default: true, enabled: true, source: SOURCE.into(), plugin_id: Some(plugin.id.clone()),
    };
    // Existing user enable/disable preferences are preserved by the shared DB upsert.
    db.sync_agent_tools(&[tool]).map_err(|e| e.to_string())?;
    Ok(name)
}
pub fn prune(db: &Database) -> Result<(), String> {
    let enabled: std::collections::HashSet<_> = db
        .list_plugins()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|p| p.enabled)
        .map(|p| p.id)
        .collect();
    let names: Vec<_> = db
        .list_agent_tools()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|tool| {
            tool.source == SOURCE
                && tool
                    .plugin_id
                    .as_ref()
                    .is_some_and(|id| enabled.contains(id))
        })
        .map(|tool| tool.name)
        .collect();
    db.delete_agent_tools_by_source_except(SOURCE, &names)
        .map_err(|e| e.to_string())?;
    Ok(())
}
