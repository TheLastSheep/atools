//! Selects the runtime that executes one agent tool invocation.
use super::node_startup_error_observation::AgentExecutionFailure;
use atools_core::{agent::ToolDefinition, db::Database};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub(super) async fn execute_agent_tool(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    arguments: Value,
    client_id: &str,
    run_id: &str,
    execution: Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
    grant: Option<crate::app_launch_fence::AppLaunchGrant>,
) -> Result<Value, AgentExecutionFailure> {
    if let Some(grant) = grant {
        if tool.source != "builtin"
            || tool.name != "open_or_reveal_path"
            || arguments.get("path").and_then(Value::as_str) != Some(grant.path())
            || arguments.get("reveal").and_then(Value::as_bool) != Some(false)
        {
            return Err("Invalid guarded app launch request".to_string().into());
        }
        return super::path_context_operations::guarded_app_open(arguments, grant)
            .await
            .map_err(Into::into);
    }
    if tool.source == "builtin" && tool.name == crate::plugin_source_build::registry::TOOL {
        return crate::plugin_source_build::execute(app, db, arguments, run_id)
            .await
            .map_err(AgentExecutionFailure::SourceBuild);
    }
    if tool.source == "builtin" && crate::plugin_source_build::is_dependency_tool_name(&tool.name) {
        return crate::plugin_source_build::execute_dependency_tool(
            app, db, &tool.name, arguments, run_id,
        )
        .await
        .map_err(AgentExecutionFailure::Message);
    }
    if tool.source == crate::plugin_ai_runtime::SOURCE {
        return crate::plugin_ai_runtime::executor::execute(
            app, db, tool, arguments, client_id, run_id, execution,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::plugin_file_drop::SOURCE {
        return crate::plugin_file_drop::commands::execute(
            app, db, tool, arguments, client_id, run_id,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::plugin_file_drag::SOURCE {
        return crate::plugin_file_drag::execute(
            app, db, tool, arguments, client_id, run_id, execution,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::plugin_main_push::registry::SOURCE {
        return crate::plugin_main_push::execute(app, db, tool, arguments, client_id, execution)
            .await
            .map_err(Into::into);
    }
    if tool.source == crate::plugin_dialog_runtime::registry::SOURCE {
        return crate::plugin_dialog_runtime::execute(
            app, db, tool, arguments, client_id, run_id, execution,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::plugin_system_paths::registry::SOURCE {
        return crate::plugin_system_paths::execute(app, db, tool, arguments, client_id, execution)
            .await
            .map_err(Into::into);
    }
    if tool.source == crate::plugin_data_runtime::registry::SOURCE {
        return crate::plugin_data_runtime::execute(
            app, db, tool, arguments, client_id, run_id, execution,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::plugin_secret_storage_runtime::registry::SOURCE {
        return crate::plugin_secret_storage_runtime::execute(
            app, db, tool, arguments, client_id, run_id, execution,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::host_runtime::registry::SOURCE {
        return crate::host_runtime::execute(app, db, tool, arguments, client_id, run_id)
            .await
            .map_err(Into::into);
    }
    if tool.source == crate::plugin_display_runtime::registry::SOURCE {
        return crate::plugin_display_runtime::execute(app, db, tool, arguments, client_id, run_id)
            .await
            .map_err(Into::into);
    }
    if tool.source == crate::plugin_browser_window_runtime::SOURCE {
        return crate::plugin_browser_window_runtime::execute(
            app, db, tool, arguments, client_id, run_id, execution,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::plugin_background_runtime::SOURCE {
        return crate::plugin_background_runtime::execute(
            app, db, tool, arguments, client_id, run_id,
        )
        .await
        .map_err(Into::into);
    }
    if tool.source == crate::legacy_runtime::registry::SOURCE {
        return crate::legacy_runtime::execute(app, db, tool, arguments, client_id, run_id)
            .await
            .map_err(Into::into);
    }
    if tool.source == "plugin" {
        return execute_plugin(app, db, tool, arguments).await;
    }
    super::execute_builtin_tool(app, db, &tool.name, arguments)
        .await
        .map_err(Into::into)
}

async fn execute_plugin(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    arguments: Value,
) -> Result<Value, AgentExecutionFailure> {
    let plugin_id = tool
        .plugin_id
        .as_deref()
        .ok_or_else(|| format!("Plugin tool {} is missing plugin_id", tool.name))?;
    let plugin = db
        .get_plugin(plugin_id)
        .map_err(|error| error.to_string())?;
    if matches!(
        plugin.manifest.effective_runtime_kind(),
        atools_core::PluginRuntimeKind::Rust | atools_core::PluginRuntimeKind::Node
    ) {
        let supervisor = app
            .try_state::<Arc<atools_plugin::SidecarSupervisor>>()
            .ok_or_else(|| "Plugin sidecar supervisor is not available".to_string())?;
        return super::executors::execute_sidecar_plugin_tool(
            supervisor.inner().as_ref(),
            &plugin,
            tool,
            arguments,
        )
        .await
        .map_err(Into::into);
    }
    let runtime = app
        .try_state::<Arc<atools_plugin::runtime::JsRuntime>>()
        .ok_or_else(|| "Plugin runtime is not available for Agent tool execution".to_string())?;
    super::execute_plugin_tool(runtime.inner().as_ref(), db, tool, arguments)
        .await
        .map_err(Into::into)
}
