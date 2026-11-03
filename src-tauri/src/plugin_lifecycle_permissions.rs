//! Invalidate authorizations tied to code that is being replaced.
use atools_core::{agent::PendingAgentToolRequest, db::Database, task_run::TaskRunStatus};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Manager};

fn belongs_to(db: &Database, tool_name: &str, id: &str) -> bool {
    db.get_agent_tool(tool_name)
        .ok()
        .flatten()
        .is_some_and(|tool| tool.plugin_id.as_deref() == Some(id))
}

pub(crate) fn cancel_pending(app: &AppHandle, db: &Database, id: &str) -> Result<(), String> {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return Ok(());
    };
    let pending: Vec<PendingAgentToolRequest> = state
        .pending_agent_requests
        .lock()
        .values()
        .cloned()
        .collect();
    for request in pending
        .into_iter()
        .filter(|request| belongs_to(db, &request.tool_name, id))
    {
        if let Some(run_id) = request.run_id.as_deref() {
            if let Some(mut run) = db.get_task_run(run_id).map_err(|error| error.to_string())? {
                if matches!(
                    run.status,
                    TaskRunStatus::Created | TaskRunStatus::AwaitingPermission
                ) {
                    run.summary = Some(
                        "Plugin changed before authorization completed; start a new request".into(),
                    );
                    run.transition(TaskRunStatus::Cancelled)
                        .map_err(|error| error.to_string())?;
                    if db
                        .update_pending_task_run(&run)
                        .map_err(|error| error.to_string())?
                    {
                        let _ = app.emit("task-run-updated", run_id);
                    }
                }
            }
        }
        crate::permission_requests::remove(app, &request.id);
    }
    Ok(())
}

/// Code replacement cannot inherit an approval issued for the previous bytes.
/// Enable/disable alone keeps saved grants; every pending request is still cancelled.
pub(crate) fn revoke_code_grants(db: &Database, id: &str) -> Result<(), String> {
    let mut names: HashSet<_> = db
        .list_agent_tools()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|tool| tool.plugin_id.as_deref() == Some(id))
        .map(|tool| tool.name)
        .collect();
    names.insert(crate::plugin_display_runtime::registry::tool_name(id));
    // Private tool rows can have been pruned while a plugin was disabled. Their
    // stable names must not recover grants issued for previously installed code.
    names.insert(crate::plugin_main_push::registry::tool_name(id));
    names.insert(crate::legacy_runtime::registry::tool_name(id));
    names.insert(crate::plugin_data_runtime::registry::tool_name(id));
    names.insert(crate::plugin_background_runtime::registry::tool_name(
        id,
        crate::plugin_background_runtime::registry::Access::Start,
    ));
    names.insert(crate::plugin_background_runtime::registry::tool_name(
        id,
        crate::plugin_background_runtime::registry::Access::Stop,
    ));
    names.insert(crate::plugin_file_drop::registry::tool_name(id));
    names.insert(crate::plugin_file_drag::registry::tool_name(id));
    names.insert(crate::plugin_ai_runtime::registry::tool_name(id));
    for access in [
        crate::plugin_dialog_runtime::registry::Access::Open,
        crate::plugin_dialog_runtime::registry::Access::Save,
    ] {
        names.insert(crate::plugin_dialog_runtime::registry::tool_name(
            id, access,
        ));
    }
    for access in [
        crate::plugin_system_paths::registry::Access::Standard,
        crate::plugin_system_paths::registry::Access::PluginData,
    ] {
        names.insert(crate::plugin_system_paths::registry::tool_name(id, access));
    }
    for access in [
        crate::host_runtime::registry::Access::Read,
        crate::host_runtime::registry::Access::Write,
        crate::host_runtime::registry::Access::HistoryRead,
        crate::host_runtime::registry::Access::HistoryDelete,
    ] {
        names.insert(crate::host_runtime::registry::tool_name(id, access));
    }
    if let Ok(plugin) = db.get_plugin(id) {
        for tool in crate::agent_tools::plugin_manifest_tool_definitions(&plugin) {
            let owner = db
                .get_agent_tool(&tool.name)
                .map_err(|error| error.to_string())?;
            if owner.is_none_or(|current| current.plugin_id.as_deref() == Some(id)) {
                names.insert(tool.name);
            }
        }
    }
    for grant in db
        .list_agent_tool_grants()
        .map_err(|error| error.to_string())?
    {
        if names.contains(&grant.tool_name) {
            db.revoke_agent_tool(&grant.client_id, &grant.tool_name)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "plugin_lifecycle_permissions_tests.rs"]
mod tests;
