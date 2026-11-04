//! Each plugin and clipboard direction has an independently granted capability.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    db::Database,
    Plugin,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const SOURCE: &str = "host_clipboard";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Read,
    Image,
    Write,
    ImageWrite,
    ContentWrite,
    Paste,
    HistoryRead,
    HistoryDelete,
}
impl Access {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "read" => Ok(Self::Read),
            "image" => Ok(Self::Image),
            "write" => Ok(Self::Write),
            "image_write" => Ok(Self::ImageWrite),
            "content_write" => Ok(Self::ContentWrite),
            "paste" => Ok(Self::Paste),
            "history_read" => Ok(Self::HistoryRead),
            "history_delete" => Ok(Self::HistoryDelete),
            _ => Err("Invalid clipboard access".into()),
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Image => "image",
            Self::Write => "write",
            Self::ImageWrite => "image_write",
            Self::ContentWrite => "content_write",
            Self::Paste => "paste",
            Self::HistoryRead => "history_read",
            Self::HistoryDelete => "history_delete",
        }
    }
    pub fn scopes(self) -> Vec<PermissionScope> {
        match self {
            Self::Read | Self::Image | Self::HistoryRead => vec![PermissionScope::ClipboardRead],
            Self::Write | Self::ImageWrite | Self::ContentWrite => {
                vec![PermissionScope::ClipboardWrite]
            }
            Self::Paste => vec![
                PermissionScope::ClipboardWrite,
                PermissionScope::InputKeyboard,
            ],
            Self::HistoryDelete => vec![PermissionScope::ClipboardDelete],
        }
    }
    /// Primary scope retained for older diagnostics; registration uses `scopes()`.
    #[cfg(test)]
    pub fn scope(self) -> PermissionScope {
        self.scopes()[0]
    }
}
pub fn tool_name(id: &str, access: Access) -> String {
    format!(
        "atools.host.clipboard.{:.24}.{}",
        format!("{:x}", Sha256::digest(id.as_bytes())),
        access.label()
    )
}
pub fn access_for(tool: &ToolDefinition) -> Result<Access, String> {
    let id = tool.plugin_id.as_deref().ok_or("Missing plugin identity")?;
    [
        Access::Read,
        Access::Image,
        Access::Write,
        Access::ImageWrite,
        Access::ContentWrite,
        Access::Paste,
        Access::HistoryRead,
        Access::HistoryDelete,
    ]
    .into_iter()
    .find(|access| {
        tool.source == SOURCE
            && tool.name == tool_name(id, *access)
            && tool.scopes == access.scopes()
    })
    .ok_or_else(|| "Invalid clipboard capability identity".into())
}
pub fn ensure_tool(db: &Database, plugin: &Plugin, access: Access) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id, access);
    let description = match access {
        Access::Read => "读取系统剪贴板文本、文件元数据或指定格式内容",
        Access::Image => "读取系统剪贴板中的图像",
        Access::Write => "写入系统剪贴板文本",
        Access::ImageWrite => "写入系统剪贴板图片",
        Access::ContentWrite => "写入系统剪贴板文本、HTML、图片或文件",
        Access::Paste => "写入剪贴板并粘贴到原前台应用",
        Access::HistoryRead => "读取剪贴板文本、图片和文件历史",
        Access::HistoryDelete => "删除剪贴板文本、图片和文件历史",
    };
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(),
        description: format!("{}：{}。只在插件实际调用时访问，正文、图像和路径不会存入任务历史。", plugin.display_name(), description),
        input_schema: json!({"type":"object","properties":{
            "operation":{"type":"string","enum":["open","request"]},
            "intentId":{"type":"string"},"sessionId":{"type":"string"},"invocationId":{"type":"string"}
        },"required":["operation"],"additionalProperties":false}),
        output_schema: None, scopes: access.scopes(), enabled_by_default: true, enabled: true,
        source: SOURCE.into(), plugin_id: Some(plugin.id.clone()),
    }]).map_err(|e| e.to_string())?;
    Ok(name)
}
