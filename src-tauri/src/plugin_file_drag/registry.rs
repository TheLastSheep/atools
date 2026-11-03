//! One FileRead capability per plugin; paths stay outside the tool definition.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::types::{Invocation, Session};
use super::SOURCE;

pub(super) const MAX_WIRE_BYTES: usize = 64 * 1024;
pub(super) const MAX_FILES: usize = 16;
pub(super) const MAX_PATH_BYTES: usize = 8 * 1024;
pub(super) const MAX_TOTAL_PATH_BYTES: usize = 64 * 1024;

pub(crate) fn tool_name(plugin: &str) -> String {
    let digest = Sha256::digest(plugin.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("atools.host.file-drag.{}", &hex[..24])
}

pub(crate) fn validate(tool: &ToolDefinition) -> Result<&str, String> {
    let plugin = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing file-drag plugin identity")?;
    if tool.source != SOURCE
        || tool.name != tool_name(plugin)
        || tool.scopes != vec![PermissionScope::FileRead]
    {
        return Err("Invalid native file-drag capability".into());
    }
    Ok(plugin)
}

pub(crate) fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(),
        description: format!(
            "{}：将插件明确提供的本地文件拖到其他应用；只保留内存中的临时路径，不读取文件内容。",
            plugin.display_name()
        ),
        input_schema: json!({
            "type":"object",
            "properties":{
                "operation":{"type":"string","enum":["open","request"]},
                "intentId":{"type":"string"},
                "sessionId":{"type":"string"},
            "invocationId":{"type":"string"}
            },
            "required":["operation"],
            "additionalProperties":false
        }),
        output_schema: None,
        scopes: vec![PermissionScope::FileRead],
        enabled_by_default: true,
        enabled: true,
        source: SOURCE.into(),
        plugin_id: Some(plugin.id.clone()),
    }])
    .map_err(|_| "Unable to register native file-drag capability")?;
    Ok(name)
}

pub(super) fn validate_session_identity(
    session: &Session,
    tool: &ToolDefinition,
) -> Result<(), String> {
    if validate(tool)? != session.owner.plugin || session.tool != tool.name {
        return Err("File-drag session capability owner mismatch".into());
    }
    Ok(())
}

pub(super) fn validate_invocation_identity(
    invocation: &Invocation,
    session: &Session,
    tool: &ToolDefinition,
) -> Result<(), String> {
    validate_session_identity(session, tool)?;
    if invocation.session != session.id
        || invocation.owner != session.owner
        || invocation.plugin != session.owner.plugin
        || invocation.document.as_ref().map(|document| document.id())
            != session.document.as_ref().map(|document| document.id())
    {
        return Err("File-drag invocation identity mismatch".into());
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
        assert_eq!(tool.name.len(), "atools.host.file-drag.".len() + 24);
        assert_eq!(validate(&tool).unwrap(), "plugin-a");

        let mut wrong = tool.clone();
        wrong.name.push('x');
        assert!(validate(&wrong).is_err());

        let mut wrong = tool.clone();
        wrong.source = "plugin".into();
        assert!(validate(&wrong).is_err());

        let mut wrong = tool.clone();
        wrong.scopes.push(PermissionScope::Shell);
        assert!(validate(&wrong).is_err());

        let mut wrong = tool;
        wrong.plugin_id = None;
        assert!(validate(&wrong).is_err());
    }
}
