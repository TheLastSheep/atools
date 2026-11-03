//! Small prompt-only lookup; the UI cannot choose a different plugin identity.
use crate::state::AppState;
use atools_core::agent::{PermissionScope, ToolDefinition};
use serde_json::{json, Value};

fn clipboard_access(tool: &ToolDefinition) -> Option<&'static str> {
    match crate::host_runtime::registry::access_for(tool).ok()? {
        crate::host_runtime::registry::Access::Read => Some("read"),
        crate::host_runtime::registry::Access::Image => Some("image"),
        crate::host_runtime::registry::Access::Write => Some("write"),
        crate::host_runtime::registry::Access::ImageWrite => Some("image_write"),
        crate::host_runtime::registry::Access::ContentWrite => Some("content_write"),
        crate::host_runtime::registry::Access::Paste => Some("paste"),
        crate::host_runtime::registry::Access::HistoryRead => Some("history_read"),
        crate::host_runtime::registry::Access::HistoryDelete => Some("history_delete"),
    }
}

fn dialog_kind(tool: &ToolDefinition) -> Option<&'static str> {
    match crate::plugin_dialog_runtime::registry::access_for(tool).ok()? {
        crate::plugin_dialog_runtime::registry::Access::Open => Some("plugin_dialog_open"),
        crate::plugin_dialog_runtime::registry::Access::Save => Some("plugin_dialog_save"),
    }
}

fn path_kind(tool: &ToolDefinition) -> Option<&'static str> {
    match crate::plugin_system_paths::registry::access_for(tool).ok()? {
        crate::plugin_system_paths::registry::Access::Standard => Some("plugin_paths_standard"),
        crate::plugin_system_paths::registry::Access::PluginData => Some("plugin_paths_data"),
    }
}
fn file_drop_kind(tool: &ToolDefinition) -> Option<&'static str> {
    crate::plugin_file_drop::registry::validate(tool)
        .ok()
        .map(|_| "plugin_file_drop")
}

fn display_kind(tool: &ToolDefinition) -> Option<&'static str> {
    crate::plugin_display_runtime::registry::validate_tool(tool)
        .ok()
        .map(|_| "plugin_display")
}

fn browser_window_kind(tool: &ToolDefinition) -> Option<&'static str> {
    crate::plugin_browser_window_runtime::registry::validate(tool)
        .ok()
        .map(|_| "plugin_browser_window")
}

fn background_kind(tool: &ToolDefinition) -> Option<&'static str> {
    match crate::plugin_background_runtime::registry::access_for(tool).ok()? {
        (plugin_id, crate::plugin_background_runtime::registry::Access::Start)
            if !plugin_id.is_empty() && tool.scopes == [PermissionScope::PluginBackground] =>
        {
            Some("plugin_background")
        }
        _ => None,
    }
}

#[tauri::command]
pub fn get_permission_request_context(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<Value, String> {
    let request = state
        .pending_agent_requests
        .lock()
        .get(&request_id)
        .cloned()
        .ok_or("Permission request is no longer pending")?;
    let tool = state
        .db
        .get_agent_tool(&request.tool_name)
        .map_err(|_| "Unable to read requested capability")?
        .ok_or("Requested capability is unavailable")?;
    let plugin_name = tool
        .plugin_id
        .as_deref()
        .and_then(|id| state.db.get_plugin(id).ok())
        .map(|plugin| plugin.display_name().to_string());
    let access = (request.scopes == tool.scopes)
        .then(|| clipboard_access(&tool))
        .flatten();
    let kind = if let Some(kind) = dialog_kind(&tool).filter(|_| request.scopes == tool.scopes) {
        kind
    } else if let Some(kind) = path_kind(&tool).filter(|_| request.scopes == tool.scopes) {
        kind
    } else if let Some(kind) = display_kind(&tool).filter(|_| request.scopes == tool.scopes) {
        kind
    } else if let Some(kind) = browser_window_kind(&tool).filter(|_| request.scopes == tool.scopes)
    {
        kind
    } else if background_kind(&tool).is_some() && request.scopes == tool.scopes {
        "plugin_background"
    } else if crate::plugin_main_push::registry::validate(&tool).is_ok()
        && request.scopes == tool.scopes
        && request.scopes.is_empty()
    {
        "plugin_main_push"
    } else if access.is_some() {
        "host_clipboard"
    } else if tool.source == "legacy_node" {
        "legacy_node"
    } else if tool.source == "plugin_data" && tool.scopes == [PermissionScope::PluginData] {
        "plugin_data"
    } else if file_drop_kind(&tool).is_some() && request.scopes == tool.scopes {
        "plugin_file_drop"
    } else if crate::plugin_secret_storage_runtime::registry::validate(&tool).is_ok()
        && request.scopes == tool.scopes
    {
        "plugin_secret_storage"
    } else if crate::plugin_ai_runtime::registry::validate(&tool).is_ok()
        && request.scopes == tool.scopes
    {
        "plugin_ai"
    } else {
        "tool"
    };
    Ok(
        json!({"pluginName":plugin_name,"kind":kind,"clipboardAccess":access,"pluginId":tool.plugin_id}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::{Database, Plugin};
    fn tool(source: &str, scopes: Vec<PermissionScope>) -> ToolDefinition {
        ToolDefinition {
            name: "fixture".into(),
            description: "fixture".into(),
            input_schema: json!({}),
            output_schema: None,
            scopes,
            enabled_by_default: true,
            enabled: true,
            source: source.into(),
            plugin_id: Some("plugin".into()),
        }
    }
    #[test]
    fn display_prompt_requires_its_exact_owner_source_and_dedicated_scope() {
        let mut definition = tool(
            crate::plugin_display_runtime::registry::SOURCE,
            vec![PermissionScope::DisplayRead],
        );
        definition.name = crate::plugin_display_runtime::registry::tool_name("plugin");
        assert_eq!(display_kind(&definition), Some("plugin_display"));
        definition.scopes = vec![PermissionScope::Screenshot];
        assert_eq!(display_kind(&definition), None);
        definition.scopes = vec![PermissionScope::DisplayRead];
        definition.plugin_id = Some("other".into());
        assert_eq!(display_kind(&definition), None);
    }
    #[test]
    fn exact_stored_host_clipboard_access_and_scopes_select_the_prompt_kind() {
        use crate::host_runtime::registry::{self, Access};
        let canonical = |access: Access| {
            let mut definition = tool(registry::SOURCE, access.scopes());
            definition.name = registry::tool_name("plugin", access);
            definition
        };
        assert_eq!(clipboard_access(&canonical(Access::Read)), Some("read"));
        assert_eq!(clipboard_access(&canonical(Access::Write)), Some("write"));
        assert_eq!(clipboard_access(&canonical(Access::Image)), Some("image"));
        assert_eq!(
            clipboard_access(&canonical(Access::ImageWrite)),
            Some("image_write")
        );
        assert_eq!(
            clipboard_access(&canonical(Access::ContentWrite)),
            Some("content_write")
        );
        assert_eq!(clipboard_access(&canonical(Access::Paste)), Some("paste"));
        assert_eq!(
            canonical(Access::Paste).scopes,
            [
                PermissionScope::ClipboardWrite,
                PermissionScope::InputKeyboard
            ]
        );
        assert_eq!(
            clipboard_access(&canonical(Access::HistoryRead)),
            Some("history_read")
        );
        assert_eq!(
            clipboard_access(&canonical(Access::HistoryDelete)),
            Some("history_delete")
        );
        let mut wrong_name = canonical(Access::Image);
        wrong_name.name = "fixture".into();
        assert_eq!(clipboard_access(&wrong_name), None);
        let mut wrong_owner = canonical(Access::Image);
        wrong_owner.plugin_id = Some("other".into());
        assert_eq!(clipboard_access(&wrong_owner), None);
        assert_eq!(
            clipboard_access(&tool("plugin", vec![PermissionScope::ClipboardRead])),
            None
        );
        assert_eq!(
            clipboard_access(&tool(
                "host_clipboard",
                vec![PermissionScope::ClipboardRead, PermissionScope::Shell]
            )),
            None
        );
        assert_eq!(clipboard_access(&tool("host_clipboard", vec![])), None);
    }
    #[test]
    fn path_prompt_requires_exact_registered_identity_source_and_scope() {
        use crate::plugin_system_paths::registry::{self, Access};
        for (access, scope, kind) in [
            (
                Access::Standard,
                PermissionScope::FileRead,
                "plugin_paths_standard",
            ),
            (
                Access::PluginData,
                PermissionScope::PluginData,
                "plugin_paths_data",
            ),
        ] {
            let mut definition = tool(registry::SOURCE, vec![scope]);
            definition.name = registry::tool_name("plugin", access);
            assert_eq!(path_kind(&definition), Some(kind));
            definition.plugin_id = Some("other".into());
            assert_eq!(path_kind(&definition), None);
            definition.plugin_id = Some("plugin".into());
            definition.scopes.push(PermissionScope::Shell);
            assert_eq!(path_kind(&definition), None);
        }
        assert_eq!(
            path_kind(&tool("plugin", vec![PermissionScope::FileRead])),
            None
        );
    }
    #[test]
    fn file_drop_prompt_uses_the_exact_hashed_tool_and_file_read_scope() {
        let mut definition = tool(
            crate::plugin_file_drop::SOURCE,
            vec![PermissionScope::FileRead],
        );
        definition.name = crate::plugin_file_drop::registry::tool_name("plugin");
        assert_eq!(file_drop_kind(&definition), Some("plugin_file_drop"));
        definition.scopes.push(PermissionScope::Shell);
        assert_eq!(file_drop_kind(&definition), None);
        definition.scopes = vec![PermissionScope::FileRead];
        definition.plugin_id = Some("other".into());
        assert_eq!(file_drop_kind(&definition), None);
        assert_eq!(
            file_drop_kind(&tool("plugin", vec![PermissionScope::FileRead])),
            None
        );
    }
    #[test]
    fn main_push_prompt_requires_exact_stored_owner_tool_and_empty_resource_scopes() {
        let mut definition = tool(crate::plugin_main_push::registry::SOURCE, vec![]);
        definition.name = crate::plugin_main_push::registry::tool_name("plugin");
        assert!(crate::plugin_main_push::registry::validate(&definition).is_ok());
        definition.plugin_id = Some("other".into());
        assert!(crate::plugin_main_push::registry::validate(&definition).is_err());
        definition.plugin_id = Some("plugin".into());
        definition.scopes.push(PermissionScope::Shell);
        assert!(crate::plugin_main_push::registry::validate(&definition).is_err());
    }

    #[test]
    fn background_prompt_requires_the_exact_start_capability_and_scope() {
        let db = Database::in_memory().unwrap();
        let plugin: Plugin = serde_json::from_value(json!({
            "id":"plugin",
            "name":"Plugin",
            "version":"1.0.0",
            "path":"/inert",
            "enabled":true,
            "manifest":{"name":"plugin","version":"1.0.0","main":"index.html"},
            "created_at":"now",
            "updated_at":"now"
        }))
        .unwrap();
        db.save_plugin(&plugin).unwrap();
        db.plugin_storage_set(
            &plugin.id,
            crate::plugin_data_runtime::BACKGROUND_STARTUP_KEY,
            &json!(["plugin"]),
        )
        .unwrap();
        crate::plugin_background_runtime::registry::sync(&db).unwrap();
        let start = crate::plugin_background_runtime::registry::tool_name(
            "plugin",
            crate::plugin_background_runtime::registry::Access::Start,
        );
        let mut definition = db.get_agent_tool(&start).unwrap().unwrap();
        assert_eq!(background_kind(&definition), Some("plugin_background"));
        definition.name = crate::plugin_background_runtime::registry::tool_name(
            "plugin",
            crate::plugin_background_runtime::registry::Access::Stop,
        );
        definition.scopes.clear();
        assert_eq!(background_kind(&definition), None);
        definition.name = "unrelated".into();
        definition.scopes = vec![PermissionScope::PluginBackground];
        assert_eq!(background_kind(&definition), None);
    }
}
