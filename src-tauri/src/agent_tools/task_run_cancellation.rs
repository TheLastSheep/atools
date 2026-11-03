//! Cancel durable TaskRuns and release source-bound execution resources.
use crate::state::AppState;
use atools_core::task_run::{TaskRun, TaskRunStatus};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn cancel_task_run_by_id(app: &AppHandle, id: &str) -> Result<TaskRun, String> {
    let state = app.state::<AppState>();
    let mut run = state
        .db
        .get_task_run(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("TaskRun not found: {id}"))?;
    let abort_handle = state.active_task_runs.lock().get(id).cloned();
    if run.status == TaskRunStatus::Running
        && run.capability_id == crate::plugin_source_build::registry::TOOL
    {
        return crate::plugin_source_build::request_cancel(app, &run);
    }
    if run.status == TaskRunStatus::Running
        && crate::plugin_source_build::is_dependency_tool_name(&run.capability_id)
    {
        return crate::plugin_source_build::request_dependency_cancel(app, &run);
    }
    let native_window_run = if run.status == TaskRunStatus::Running && abort_handle.is_none() {
        state
            .db
            .get_agent_tool(&run.capability_id)
            .map_err(|error| error.to_string())?
            .is_some_and(|tool| {
                tool.source == crate::plugin_browser_window_runtime::SOURCE
                    && crate::plugin_browser_window_runtime::registry::validate(&tool).is_ok()
            })
    } else {
        false
    };
    let native_background_run = if run.status == TaskRunStatus::Running && abort_handle.is_none() {
        state
            .db
            .get_agent_tool(&run.capability_id)
            .map_err(|error| error.to_string())?
            .is_some_and(|tool| {
                tool.source == crate::plugin_background_runtime::SOURCE
                    && crate::plugin_background_runtime::registry::validate(&tool).is_ok()
            })
    } else {
        false
    };
    if run.status == TaskRunStatus::Running
        && abort_handle.is_none()
        && !native_window_run
        && !native_background_run
    {
        return Err(format!(
            "TaskRun {} is running outside the cancellable background executor",
            run.id
        ));
    }
    if !matches!(
        run.status,
        TaskRunStatus::Created | TaskRunStatus::AwaitingPermission | TaskRunStatus::Running
    ) {
        return Err(format!(
            "TaskRun {} cannot be cancelled from status {}",
            run.id,
            run.status.as_str()
        ));
    }
    let was_running = run.status == TaskRunStatus::Running;
    run.summary = Some("TaskRun was cancelled by the user".to_string());
    run.transition(TaskRunStatus::Cancelled)
        .map_err(|error| error.to_string())?;
    let cancelled = if was_running {
        state.db.finish_running_task_run(&run)
    } else {
        state.db.update_pending_task_run(&run)
    }
    .map_err(|error| error.to_string())?;
    if !cancelled {
        return Err("TaskRun changed while cancelling; refresh its current status".into());
    }
    crate::permission_requests::remove_for_run(app, id);
    crate::plugin_browser_window_runtime::cancel_run(app, id);
    crate::plugin_background_runtime::cancel_run(app, &state.db, id);
    state.active_task_runs.lock().remove(id);
    if let Some(handle) = abort_handle {
        handle.abort();
    }
    let _ = app.emit("task-run-updated", run.id.clone());
    Ok(run)
}
