//! A read-only metadata grant and a separate plugin-directory grant.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const SOURCE: &str = "plugin_system_paths";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Access {
    Standard,
    PluginData,
}
impl Access {
    pub(super) fn scope(self) -> PermissionScope {
        match self {
            Self::Standard => PermissionScope::FileRead,
            Self::PluginData => PermissionScope::PluginData,
        }
    }
    pub(super) fn names(self) -> Vec<&'static str> {
        match self {
            Self::Standard => super::resolver::STANDARD_NAMES.to_vec(),
            Self::PluginData => vec!["pluginData"],
        }
    }
}
pub(crate) fn tool_name(id: &str, access: Access) -> String {
    format!(
        "atools.host.paths.{:.24}.{}",
        format!("{:x}", Sha256::digest(id.as_bytes())),
        if access == Access::Standard {
            "standard"
        } else {
            "plugin-data"
        }
    )
}
pub(crate) fn access_for(tool: &ToolDefinition) -> Result<Access, String> {
    let id = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing path plugin identity")?;
    [Access::Standard, Access::PluginData]
        .into_iter()
        .find(|a| {
            tool.source == SOURCE
                && tool.name == tool_name(id, *a)
                && tool.scopes == vec![a.scope()]
        })
        .ok_or_else(|| "Invalid path capability identity".into())
}
pub(crate) fn ensure_tool(
    db: &Database,
    plugin: &Plugin,
    access: Access,
) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id, access);
    db.sync_agent_tools(&[ToolDefinition { name: name.clone(), description: format!("{}：{}。真实路径不会存入任务历史。", plugin.display_name(), if access == Access::Standard { "读取常用系统目录路径，不读取文件内容" } else { "获取并创建此插件的专属数据目录" }),
        input_schema: json!({"type":"object","properties":{"operation":{"const":"prepare"},"intentId":{"type":"string"}},"required":["operation","intentId"],"additionalProperties":false}),
        output_schema: None, scopes: vec![access.scope()], enabled_by_default: true, enabled: true, source: SOURCE.into(), plugin_id: Some(plugin.id.clone())
    }]).map_err(|_| "Unable to register path capability")?;
    Ok(name)
}
