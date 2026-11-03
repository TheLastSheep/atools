use super::*;
pub async fn execute_builtin_tool(
    app: &AppHandle,
    db: &Database,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    match tool_name {
        "ask_ai_model" => ask_ai_model(db, arguments).await,
        "search_clipboard" => search_clipboard(app, db, arguments).await,
        crate::plugin_source_build::registry::INSPECT_TOOL => {
            crate::plugin_source_build::inspect_tool(app, arguments).await
        }
        crate::launcher_media_clipboard::TOOL => {
            crate::launcher_media_clipboard::execute(arguments).await
        }
        crate::launcher_clipboard_context::TOOL => {
            crate::launcher_clipboard_context::execute(app, arguments).await
        }
        "find_local_files" => find_local_files_tool_call(arguments),
        "get_current_context" => get_current_context(),
        "open_or_reveal_path" => open_or_reveal_path(arguments),
        "open_url" => open_url(app, arguments),
        "rename_files" => rename_files_tool_call(arguments),
        "compress_images" => compress_images(arguments),
        "ocr_image" => ocr_image(arguments).await,
        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
}

pub(super) async fn execute_sidecar_plugin_tool(
    supervisor: &atools_plugin::SidecarSupervisor,
    plugin: &Plugin,
    tool: &ToolDefinition,
    arguments: Value,
) -> Result<Value, String> {
    if !plugin.enabled {
        return Err(format!("Plugin {} is disabled", plugin.id));
    }
    let manifest_tool_name = plugin
        .manifest
        .tools
        .keys()
        .find(|tool_name| {
            agent_plugin_tool_name(&plugin.id, tool_name)
                .is_some_and(|normalized| normalized == tool.name)
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "Plugin tool {} no longer exists in manifest for {}",
                tool.name, plugin.id
            )
        })?;
    let spec = atools_plugin::SidecarLaunchSpec::from_manifest(
        plugin.id.clone(),
        Path::new(&plugin.path),
        &plugin.manifest,
    )
    .map_err(|error| error.to_string())?;
    let process = supervisor
        .start(spec)
        .await
        .map_err(|error| format!("Plugin sidecar {} failed to start: {error}", plugin.id))?;
    let result = match plugin.manifest.effective_runtime_transport() {
        atools_core::PluginRuntimeTransport::JsonRpcStdio => {
            atools_plugin::JsonRpcSidecar::new(process)
                .map_err(|error| error.to_string())?
                .call(
                    "tools/call",
                    json!({ "name": manifest_tool_name, "arguments": arguments }),
                )
                .await
        }
        atools_core::PluginRuntimeTransport::McpStdio => {
            let client =
                atools_plugin::McpSidecar::new(process).map_err(|error| error.to_string())?;
            client
                .initialize()
                .await
                .map_err(|error| error.to_string())?;
            client.call_tool(&manifest_tool_name, arguments).await
        }
        atools_core::PluginRuntimeTransport::HostBridge => {
            return Err("Rust/Node sidecars cannot use host_bridge transport".to_string())
        }
    }
    .map_err(|error| format!("Plugin Agent tool {} failed: {error}", tool.name))?;
    if result.is_error {
        let message = result
            .content
            .iter()
            .filter_map(|content| content.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(if message.is_empty() {
            format!("Plugin Agent tool {} returned an error", tool.name)
        } else {
            message
        });
    }
    if let Some(structured) = result.structured_content.clone() {
        Ok(structured)
    } else {
        Ok(serde_json::to_value(result).unwrap_or(Value::Null))
    }
}

pub async fn execute_plugin_tool(
    runtime: &atools_plugin::runtime::JsRuntime,
    db: &Database,
    tool: &ToolDefinition,
    arguments: Value,
) -> Result<Value, String> {
    if tool.source != "plugin" {
        return Err(format!("Tool {} is not a plugin tool", tool.name));
    }
    let plugin_id = tool
        .plugin_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Plugin tool {} is missing plugin_id", tool.name))?;
    let plugin = db.get_plugin(plugin_id).map_err(|e| e.to_string())?;
    if !plugin.enabled {
        return Err(format!("Plugin {} is disabled", plugin_id));
    }
    let manifest_tool_name = plugin
        .manifest
        .tools
        .keys()
        .find(|tool_name| {
            agent_plugin_tool_name(&plugin.id, tool_name)
                .is_some_and(|normalized| normalized == tool.name)
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "Plugin tool {} no longer exists in manifest for {}",
                tool.name, plugin_id
            )
        })?;

    let payload = vec![json!({
        "tool": manifest_tool_name,
        "normalizedTool": tool.name,
        "arguments": arguments
    })];

    match runtime
        .call_function(plugin_id, "____callAgentTool____", payload.clone())
        .await
    {
        Ok(output) => Ok(output),
        Err(error) if error.to_string().contains("Context not found") => {
            load_plugin_preload_for_agent_tool(runtime, &plugin).await?;
            runtime
                .call_function(plugin_id, "____callAgentTool____", payload)
                .await
                .map_err(|error| format!("Plugin Agent tool {} failed: {}", tool.name, error))
        }
        Err(error) => Err(format!("Plugin Agent tool {} failed: {}", tool.name, error)),
    }
}

async fn load_plugin_preload_for_agent_tool(
    runtime: &atools_plugin::runtime::JsRuntime,
    plugin: &Plugin,
) -> Result<(), String> {
    let preload = plugin.manifest.preload.as_deref().ok_or_else(|| {
        format!(
            "Plugin {} runtime context is missing and manifest has no preload to register Agent tools",
            plugin.id
        )
    })?;
    let preload_path = Path::new(preload);
    if preload_path.is_absolute()
        || preload_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "Plugin {} preload path is outside the plugin directory: {}",
            plugin.id, preload
        ));
    }
    runtime
        .execute_preload_from_dir(&plugin.id, Path::new(&plugin.path), preload)
        .await
        .map_err(|error| {
            format!(
                "Failed to execute plugin preload for Agent tool {}: {}",
                plugin.id, error
            )
        })
}
