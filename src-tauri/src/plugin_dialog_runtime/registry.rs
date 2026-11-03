//! Independent picker grants; choosing a path does not grant content access.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const SOURCE: &str = "plugin_dialog";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Access {
    Open,
    Save,
}
impl Access {
    pub fn label(self) -> &'static str {
        if self == Self::Open {
            "open"
        } else {
            "save"
        }
    }
    pub fn method(self) -> &'static str {
        if self == Self::Open {
            "showOpenDialog"
        } else {
            "showSaveDialog"
        }
    }
    pub fn scope(self) -> PermissionScope {
        if self == Self::Open {
            PermissionScope::FileRead
        } else {
            PermissionScope::FileWrite
        }
    }
}
pub(crate) fn tool_name(plugin: &str, access: Access) -> String {
    format!(
        "atools.host.dialog.{:.24}.{}",
        format!("{:x}", Sha256::digest(plugin.as_bytes())),
        access.label()
    )
}
pub(crate) fn access_for(tool: &ToolDefinition) -> Result<Access, String> {
    let id = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing dialog plugin identity")?;
    [Access::Open, Access::Save]
        .into_iter()
        .find(|a| {
            tool.source == SOURCE
                && tool.name == tool_name(id, *a)
                && tool.scopes == vec![a.scope()]
        })
        .ok_or_else(|| "Invalid dialog capability identity".into())
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
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(), description: format!("{}：{}。每次由你在系统窗口中选择；文件路径不写入执行历史，文件内容操作仍需其他能力。", plugin.display_name(), if access == Access::Open { "打开文件或文件夹选择窗口" } else { "打开保存位置选择窗口" }),
        input_schema: json!({"type":"object","properties":{"operation":{"enum":["open","request"]},"intentId":{"type":"string"},"sessionId":{"type":"string"},"invocationId":{"type":"string"},"method":{"enum":[access.method()]}},"required":["operation"],"additionalProperties":false}),
        output_schema: None, scopes: vec![access.scope()], enabled_by_default: true,
        enabled: true, source: SOURCE.into(), plugin_id: Some(plugin.id.clone()),
    }]).map_err(|_| "Unable to register dialog capability")?;
    Ok(name)
}
