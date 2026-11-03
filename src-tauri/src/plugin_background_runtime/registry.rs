//! Stable per-plugin private capabilities for start and trusted cleanup.
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const SOURCE: &str = "plugin_background";
const PREFIX: &str = "atools.host.plugin-background.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    Start,
    Stop,
}

impl Access {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
        }
    }

    pub(super) fn operation(self) -> super::dto::Operation {
        match self {
            Self::Start => super::dto::Operation::Start,
            Self::Stop => super::dto::Operation::Stop,
        }
    }

    fn scopes(self) -> Vec<PermissionScope> {
        match self {
            Self::Start => vec![PermissionScope::PluginBackground],
            Self::Stop => Vec::new(),
        }
    }
}

pub(crate) fn tool_name(plugin_id: &str, access: Access) -> String {
    let digest = format!("{:x}", Sha256::digest(plugin_id.as_bytes()));
    format!("{PREFIX}{}.{}", &digest[..24], access.name())
}

pub(crate) fn access_for(tool: &ToolDefinition) -> Result<(&str, Access), String> {
    let plugin_id = tool
        .plugin_id
        .as_deref()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or("ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE")?;
    let access = if tool.name == tool_name(plugin_id, Access::Start) {
        Access::Start
    } else if tool.name == tool_name(plugin_id, Access::Stop) {
        Access::Stop
    } else {
        return Err("ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE".into());
    };
    if tool.source != SOURCE || tool.scopes != access.scopes() || !tool.enabled {
        return Err("ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE".into());
    }
    if tool.input_schema != schema(access) {
        return Err("ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE".into());
    }
    Ok((plugin_id, access))
}

pub(crate) fn validate(tool: &ToolDefinition) -> Result<(&str, Access), String> {
    access_for(tool)
}

pub(crate) fn ensure_tools(db: &Database, plugin: &Plugin) -> Result<[String; 2], String> {
    if !super::candidates::supported(plugin) {
        return Err("ERR_PLUGIN_BACKGROUND_OWNER_CHANGED".into());
    }
    let start = definition(plugin, Access::Start);
    let stop = definition(plugin, Access::Stop);
    let names = [start.name.clone(), stop.name.clone()];
    let mut tools = vec![stop];
    if super::candidates::requested(db, plugin)? {
        tools.push(start);
    }
    db.sync_agent_tools(&tools)
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE")?;
    Ok(names)
}

pub(crate) fn sync(db: &Database) -> Result<(), String> {
    let plugins = db
        .list_plugins()
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE")?;
    let mut tools = Vec::new();
    for plugin in plugins
        .iter()
        .filter(|plugin| super::candidates::supported(plugin))
    {
        tools.push(definition(plugin, Access::Stop));
        if super::candidates::requested(db, plugin)? {
            tools.push(definition(plugin, Access::Start));
        }
    }
    let names = tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    db.sync_agent_tools(&tools)
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE")?;
    db.delete_agent_tools_by_source_except(SOURCE, &names)
        .map_err(|_| "ERR_PLUGIN_BACKGROUND_CAPABILITY_UNAVAILABLE")?;
    Ok(())
}

fn definition(plugin: &Plugin, access: Access) -> ToolDefinition {
    let name = tool_name(&plugin.id, access);
    let description = match access {
        Access::Start => format!(
            "{}：在你授权后保持原插件预加载运行。",
            plugin.display_name()
        ),
        Access::Stop => format!(
            "{}：关闭此插件自己已授权的后台会话。",
            plugin.display_name()
        ),
    };
    ToolDefinition {
        name,
        description,
        input_schema: schema(access),
        output_schema: None,
        scopes: access.scopes(),
        enabled_by_default: true,
        enabled: true,
        source: SOURCE.into(),
        plugin_id: Some(plugin.id.clone()),
    }
}

fn schema(access: Access) -> Value {
    json!({
        "type":"object",
        "properties":{
            "requestId":{"type":"string"},
            "sessionId":{"type":"string"},
            "pluginId":{"type":"string"},
            "codeRevision":{"type":"string"},
            "operation":{"type":"string","enum":[access.operation().as_str()]}
        },
        "required":["requestId","sessionId","pluginId","codeRevision","operation"],
        "additionalProperties":false
    })
}
