use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database, Plugin,
};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const SOURCE: &str = "plugin_secret_storage";
pub(crate) const MAX_TEXT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_CIPHER_BYTES: usize = MAX_TEXT_BYTES + 64;
pub(crate) const MAX_WIRE_BYTES: usize = 128 * 1024;
pub(crate) const MAX_SESSIONS: usize = 64;
pub(crate) const MAX_PER_WINDOW: usize = 4;
pub(crate) const MAX_INTENTS: usize = 64;
pub(crate) const MAX_INFLIGHT: usize = 32;

pub(crate) fn tool_name(id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("atools.host.secret-storage.{}", &hex[..24])
}
pub(crate) fn validate(tool: &ToolDefinition) -> Result<&str, String> {
    let id = tool.plugin_id.as_deref().ok_or("Missing plugin identity")?;
    if tool.source != SOURCE
        || tool.name != tool_name(id)
        || tool.scopes != vec![PermissionScope::SecretStorage]
    {
        return Err("Invalid plugin secret storage capability".into());
    }
    Ok(id)
}
pub(crate) fn ensure_tool(db: &Database, plugin: &Plugin) -> Result<String, String> {
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let name = tool_name(&plugin.id);
    db.sync_agent_tools(&[ToolDefinition {
        name: name.clone(),
        description: format!("{}：访问此插件专属的系统安全存储。", plugin.display_name()),
        input_schema: json!({"type":"object","properties":{"operation":{"enum":["open","request"]},
            "intentId":{"type":"string"},"sessionId":{"type":"string"},"invocationId":{"type":"string"},"method":{"enum":["encrypt","decrypt"]}},
            "required":["operation"],"additionalProperties":false}),
        output_schema: None, scopes: vec![PermissionScope::SecretStorage], enabled_by_default: true,
        enabled: true, source: SOURCE.into(), plugin_id: Some(plugin.id.clone()),
    }]).map_err(|_| "Unable to register plugin secret storage capability")?;
    Ok(name)
}
