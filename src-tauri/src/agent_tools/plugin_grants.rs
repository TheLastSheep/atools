//! Save a grant only against the currently locked capability and pending request.
use super::plugin_execution_snapshot;
use atools_core::db::Database;
use tauri::AppHandle;

pub(super) async fn grant(
    app: &AppHandle,
    db: &Database,
    client: &str,
    tool_name: &str,
    request_id: Option<&str>,
) -> Result<(), String> {
    let snapshot = plugin_execution_snapshot::resolve_tool_with_gate(app, db, tool_name)
        .await?
        .ok_or("Tool is no longer available")?;
    let plugin_execution_snapshot::ExecutionSnapshot {
        tool,
        guard: _execution,
    } = snapshot;
    if let Some(request_id) = request_id {
        return crate::permission_requests::with_request(app, request_id, |request| {
            if request.client_id != client || request.tool_name != tool_name {
                return Err("Permission request identity mismatch".into());
            }
            let run_id = request
                .run_id
                .as_deref()
                .ok_or("Permission TaskRun is no longer available")?;
            let run = db
                .get_task_run(run_id)
                .map_err(|error| error.to_string())?
                .ok_or("Permission TaskRun is no longer available")?;
            if tool.plugin_id.is_some() {
                let digest = plugin_execution_snapshot::snapshot_digest(db, &tool)?;
                plugin_execution_snapshot::validate_pending(&run, Some(request), &tool, &digest)?;
            } else if run.status != atools_core::task_run::TaskRunStatus::AwaitingPermission
                || run.capability_id != tool_name
                || run.initiator.client_id.as_deref() != Some(client)
                || run.input != request.arguments
                || request.scopes != tool.scopes
            {
                return Err("Permission request is no longer valid".into());
            }
            if !db
                .grant_agent_tool_for_pending_run(&run, client, tool_name)
                .map_err(|error| error.to_string())?
            {
                return Err("Permission TaskRun was cancelled or changed".into());
            }
            Ok(())
        });
    }
    db.grant_agent_tool(client, tool_name)
        .map_err(|error| error.to_string())
}
