//! One narrow, plugin-owned capability for native BrowserWindow operations.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) fn tool_name(plugin_id: &str) -> String {
    format!(
        "atools.host.browser-window.{:.24}",
        format!("{:x}", Sha256::digest(plugin_id.as_bytes()))
    )
}

pub(crate) fn validate(tool: &ToolDefinition) -> Result<(), String> {
    let plugin = tool
        .plugin_id
        .as_deref()
        .ok_or("Missing BrowserWindow plugin identity")?;
    if tool.source != super::SOURCE
        || tool.name != tool_name(plugin)
        || tool.scopes != [PermissionScope::PluginWindow]
        || tool.input_schema != input_schema()
        || tool.output_schema.is_some()
    {
        return Err("Invalid BrowserWindow capability identity".into());
    }
    Ok(())
}

pub(crate) fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(),
        description: format!(
            "{}：管理当前插件自己的独立窗口。窗口内容与插件代码版本绑定；此权限不管理其他插件或应用窗口。",
            plugin.display_name()
        ),
        input_schema: input_schema(),
        output_schema: None,
        scopes: vec![PermissionScope::PluginWindow],
        enabled_by_default: true,
        enabled: true,
        source: super::SOURCE.into(),
        plugin_id: Some(plugin.id.clone()),
    }])
    .map_err(|_| "Unable to register BrowserWindow capability")?;
    Ok(name)
}

fn input_schema() -> serde_json::Value {
    json!({
        "type":"object",
        "properties":{
            "operation":{"type":"string","enum":["open","action"]},
            "intentId":{"type":"string","pattern":"^[0-9a-f]{64}$"}
        },
        "required":["operation","intentId"],
        "additionalProperties":false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(plugin: &str) -> ToolDefinition {
        ToolDefinition {
            name: tool_name(plugin),
            description: String::new(),
            input_schema: input_schema(),
            output_schema: None,
            scopes: vec![PermissionScope::PluginWindow],
            enabled_by_default: true,
            enabled: true,
            source: super::super::SOURCE.into(),
            plugin_id: Some(plugin.into()),
        }
    }

    #[test]
    fn tool_identity_requires_hash_source_owner_and_only_plugin_window_scope() {
        let mut definition = tool("fixture-plugin");
        assert!(validate(&definition).is_ok());
        definition.source = "plugin".into();
        assert!(validate(&definition).is_err());
        definition = tool("fixture-plugin");
        definition.name = tool_name("other-plugin");
        assert!(validate(&definition).is_err());
        definition = tool("fixture-plugin");
        definition.scopes.push(PermissionScope::Shell);
        assert!(validate(&definition).is_err());
        definition = tool("fixture-plugin");
        definition.plugin_id = None;
        assert!(validate(&definition).is_err());
        definition = tool("fixture-plugin");
        definition.input_schema = json!({"type":"object","additionalProperties":true});
        assert!(validate(&definition).is_err());
    }
}
