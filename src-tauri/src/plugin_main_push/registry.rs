//! Stable owner capability; empty scopes do not authorize any plugin resources.
use atools_core::{agent::ToolDefinition, Database, Plugin};
use serde_json::json;
use sha2::{Digest, Sha256};
pub(crate) const SOURCE: &str = "plugin_main_push";
pub(crate) fn tool_name(plugin: &str) -> String {
    format!("plugin_main_push_{:x}", Sha256::digest(plugin.as_bytes()))
}
pub(crate) fn validate(tool: &ToolDefinition) -> Result<(), String> {
    let plugin = tool
        .plugin_id
        .as_deref()
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .ok_or("ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE")?;
    if tool.source != SOURCE || tool.name != tool_name(plugin) || !tool.scopes.is_empty() {
        return Err("ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE".into());
    }
    Ok(())
}
pub(super) fn ensure(db: &Database, plugin: &Plugin) -> Result<String, String> {
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(), description: format!("{}：在搜索列表中执行动态查询与选择；本能力不授予文件、网络或剪贴板等资源访问。", plugin.display_name()),
        input_schema: json!({"type":"object","properties":{
            "requestId":{"type":"string"},"runnerId":{"type":"string"},
            "pluginId":{"type":"string"},"featureCode":{"type":"string"},
            "commandType":{"type":"string","enum":["text","regex","over"]},"codeRevision":{"type":"string"},
            "operation":{"type":"string","enum":["prepare","query","select"]},
            "inputBytes":{"type":"integer","minimum":0,"maximum":1048576},
            "queryGeneration":{"type":"integer","minimum":0,"maximum":4294967295u64}},
            "required":["requestId","runnerId","pluginId","featureCode","commandType","codeRevision","operation","inputBytes","queryGeneration"],"additionalProperties":false}),
        output_schema: None, scopes: vec![], enabled_by_default: true, enabled: true,
        source: SOURCE.into(), plugin_id: Some(plugin.id.clone()),
    }]).map_err(|_| "ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE")?;
    Ok(name)
}
pub(crate) fn prune(db: &Database) -> Result<(), String> {
    let enabled = db
        .list_plugins()
        .map_err(|_| "ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE")?
        .into_iter()
        .filter(|p| p.enabled)
        .map(|p| p.id)
        .collect::<std::collections::HashSet<_>>();
    let names = db
        .list_agent_tools()
        .map_err(|_| "ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE")?
        .into_iter()
        .filter(|t| {
            t.source == SOURCE && t.plugin_id.as_ref().is_some_and(|id| enabled.contains(id))
        })
        .map(|t| t.name)
        .collect::<Vec<_>>();
    db.delete_agent_tools_by_source_except(SOURCE, &names)
        .map_err(|_| "ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE")?;
    Ok(())
}
