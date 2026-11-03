//! Bind plugin authorization and approval to the code and capability metadata
//! protected by the per-plugin execution gate.

use atools_core::{
    agent::{PendingAgentToolRequest, ToolDefinition},
    db::Database,
    task_run::{TaskRun, TaskRunStatus},
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::sync::OwnedRwLockReadGuard;

pub(super) struct ExecutionSnapshot {
    pub(super) tool: ToolDefinition,
    pub(super) guard: Option<OwnedRwLockReadGuard<()>>,
}

/// Resolve the current tool, wait for its owning plugin's execution permit, and
/// resolve it again while holding that permit. Builtins do not take a plugin
/// lock. A changed owner/source is rejected so a waiter cannot execute a tool
/// that moved to another identity while it was queued.
pub(super) async fn resolve_tool_with_gate(
    app: &AppHandle,
    db: &Database,
    tool_name: &str,
) -> Result<Option<ExecutionSnapshot>, String> {
    let Some(initial) = resolve_tool(db, tool_name)? else {
        return Ok(None);
    };
    let Some(plugin_id) = initial.plugin_id.clone() else {
        return Ok(Some(ExecutionSnapshot {
            tool: initial,
            guard: None,
        }));
    };

    if plugin_id.trim().is_empty() {
        return Err(format!(
            "Plugin tool {tool_name} has an empty plugin identity"
        ));
    }
    let guard = crate::plugin_lifecycle::execution(app, &plugin_id).await;
    let current = db
        .get_agent_tool(tool_name)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Plugin tool {tool_name} changed while waiting for execution"))?;
    if current.plugin_id.as_deref() != Some(plugin_id.as_str()) || current.source != initial.source
    {
        return Err(format!(
            "Plugin tool {tool_name} changed owner while waiting for execution"
        ));
    }

    Ok(Some(ExecutionSnapshot {
        tool: current,
        guard: Some(guard),
    }))
}

fn resolve_tool(db: &Database, tool_name: &str) -> Result<Option<ToolDefinition>, String> {
    if let Some(tool) = db
        .get_agent_tool(tool_name)
        .map_err(|error| error.to_string())?
    {
        return Ok(Some(tool));
    }
    Ok(super::builtin_tool_registry().get(tool_name).cloned())
}

/// Hash the current executable identity and the capability contract shown to
/// the permission system. File paths are included only in the digest input and
/// are never stored in a TaskRun snapshot.
pub(super) fn snapshot_digest(db: &Database, tool: &ToolDefinition) -> Result<String, String> {
    let plugin_id = tool
        .plugin_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| format!("Plugin tool {} has no plugin identity", tool.name))?;
    let plugin = db
        .get_plugin(plugin_id)
        .map_err(|error| error.to_string())?;
    if plugin.id != plugin_id {
        return Err(format!("Plugin identity mismatch for tool {}", tool.name));
    }

    let mut scopes = tool
        .scopes
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    scopes.sort_by_key(Value::to_string);
    let snapshot = canonicalize(json!({
        "tool": {
            "name": tool.name,
            "source": tool.source,
            "pluginId": plugin_id,
            "enabled": tool.enabled,
            "enabledByDefault": tool.enabled_by_default,
            "scopes": scopes,
            "inputSchema": tool.input_schema,
            "outputSchema": tool.output_schema,
        },
        "plugin": {
            "id": plugin.id,
            "path": plugin.path,
            "enabled": plugin.enabled,
            "version": plugin.version,
            "updatedAt": plugin.updated_at,
            "codeRevision": crate::plugin_code_revision::current(db, plugin_id)?,
        }
    }));
    let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Attach an opaque capability digest to the persisted pending TaskRun. Keep
/// the permission payload returned to the UI unchanged.
pub(super) fn record_snapshot(run: &mut TaskRun, digest: &str) {
    if !run.output.is_object() {
        run.output = Value::Object(Map::new());
    }
    if let Some(output) = run.output.as_object_mut() {
        output.insert("capabilitySnapshot".into(), Value::String(digest.into()));
    }
}

pub(super) fn binds_created(tool: &ToolDefinition) -> bool {
    tool.plugin_id.is_some()
        && tool.source != crate::legacy_runtime::registry::SOURCE
        && tool.source != crate::host_runtime::registry::SOURCE
        && tool.source != crate::plugin_display_runtime::registry::SOURCE
        && tool.source != crate::plugin_data_runtime::registry::SOURCE
        && tool.source != crate::plugin_secret_storage_runtime::registry::SOURCE
        && tool.source != crate::plugin_system_paths::registry::SOURCE
        && tool.source != crate::plugin_dialog_runtime::registry::SOURCE
        && tool.source != crate::plugin_browser_window_runtime::SOURCE
        && tool.source != crate::plugin_background_runtime::SOURCE
        && tool.source != crate::plugin_file_drop::SOURCE
        && tool.source != crate::plugin_file_drag::SOURCE
        && tool.source != crate::plugin_ai_runtime::SOURCE
}

/// Public plugin calls may sit in the background dispatcher before obtaining a
/// read gate. Bind them before persistence. Private transport calls already
/// carry generation-bound intents/tickets, so their frequent RPCs avoid hashing.
pub(super) fn bind_created(db: &Database, run: &mut TaskRun) -> Result<(), String> {
    if let Some(tool) = resolve_tool(db, &run.capability_id)?.filter(binds_created) {
        record_snapshot(run, &snapshot_digest(db, &tool)?);
    }
    Ok(())
}

pub(super) fn validate_created(run: &TaskRun, current_digest: &str) -> Result<(), String> {
    if run.output.get("capabilitySnapshot").and_then(Value::as_str) != Some(current_digest) {
        return Err("Plugin changed while this task was queued; start a new request".into());
    }
    Ok(())
}

/// Verify that an approval still refers to the exact pending request and the
/// current capability snapshot. Call this while holding the plugin read gate.
pub(super) fn validate_pending(
    run: &TaskRun,
    request: Option<&PendingAgentToolRequest>,
    current_tool: &ToolDefinition,
    current_digest: &str,
) -> Result<(), String> {
    if run.status != TaskRunStatus::AwaitingPermission {
        return Err("Permission request is no longer awaiting approval".into());
    }
    let request = request.ok_or_else(|| "Permission request is no longer available".to_string())?;
    let client_id = run.initiator.client_id.as_deref().unwrap_or_default();
    if request.run_id.as_deref() != Some(run.id.as_str())
        || request.client_id != client_id
        || request.tool_name != run.capability_id
        || request.arguments != run.input
    {
        return Err("Permission request no longer matches this TaskRun".into());
    }
    if current_tool.name != run.capability_id
        || current_tool.plugin_id.is_none()
        || request.scopes != current_tool.scopes
    {
        return Err("Plugin permissions changed; review the request again".into());
    }
    let stored_digest = run
        .output
        .get("capabilitySnapshot")
        .and_then(Value::as_str)
        .ok_or_else(|| "Permission request has no capability snapshot".to_string())?;
    if stored_digest != current_digest {
        return Err("Plugin capability changed; review the request again".into());
    }
    Ok(())
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(object) => {
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize(value)))
                    .collect(),
            )
        }
        other => other,
    }
}

#[cfg(test)]
#[path = "plugin_execution_snapshot_tests.rs"]
mod tests;
