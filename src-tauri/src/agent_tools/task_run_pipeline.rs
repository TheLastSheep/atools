//! Selection and atomic persistence boundaries before a tool executor is called.

use atools_core::db::Database;
use atools_core::mcp::McpToolCallResult;
use atools_core::memory::apply_memory_defaults;
use atools_core::task_run::{
    TaskIssue, TaskRun, TaskRunInitiatorType, TaskRunStatus, TaskValidationStatus,
};
use serde_json::{json, Value};

use super::{memory_scope_for_call, new_task_run, task_run_error};

/// Run once, before the new Created record is persisted. Resuming permission
/// approval must use the exact input the user already reviewed.
pub(super) fn apply_new_run_memory(db: &Database, run: &mut TaskRun) {
    if run.status != TaskRunStatus::Created || !run.memory_ids.is_empty() {
        return;
    }
    if db
        .get_agent_tool(&run.capability_id)
        .ok()
        .flatten()
        .is_some_and(|tool| {
            [
                crate::legacy_runtime::registry::SOURCE,
                crate::host_runtime::registry::SOURCE,
                crate::plugin_data_runtime::registry::SOURCE,
                crate::plugin_secret_storage_runtime::registry::SOURCE,
                crate::plugin_system_paths::registry::SOURCE,
                crate::plugin_dialog_runtime::registry::SOURCE,
                crate::plugin_browser_window_runtime::SOURCE,
                crate::plugin_background_runtime::SOURCE,
                crate::launcher_media_clipboard::SOURCE,
                crate::launcher_clipboard_context::SOURCE,
                crate::plugin_main_push::registry::SOURCE,
                crate::plugin_file_drop::SOURCE,
                crate::plugin_file_drag::SOURCE,
                crate::plugin_ai_runtime::SOURCE,
            ]
            .contains(&tool.source.as_str())
        })
    {
        return;
    }
    let context = memory_scope_for_call(&run.capability_id, &run.input);
    if let Ok(memories) = db.find_memory_items(&context, 20) {
        apply_memory_defaults(&mut run.input, &memories);
        run.memory_ids = memories.into_iter().map(|memory| memory.id).collect();
        let _ = db.record_memory_use(&run.memory_ids);
    }
}

/// A background dispatch can lose its private ticket after precreation. Close
/// only its own unchanged Created run; never fail another phase or executor.
pub(super) fn fail_created_dispatch(
    db: &Database,
    id: &str,
    client: &str,
    tool: &str,
    arguments: &Value,
    message: &str,
) -> Option<McpToolCallResult> {
    let mut run = db.get_task_run(id).ok().flatten()?;
    let expected = new_task_run(client, tool, arguments.clone());
    if run.status != TaskRunStatus::Created
        || run.capability_id != tool
        || run.initiator != expected.initiator
        || run.input != *arguments
    {
        return None;
    }
    run.errors
        .push(TaskIssue::error("dispatch_rejected", message));
    run.summary = Some(format!("{tool} failed before execution: {message}"));
    run.validation.status = TaskValidationStatus::Failed;
    run.validation.summary = Some("Executor was not started".into());
    run.transition(TaskRunStatus::Failed).ok()?;
    if !db.fail_created_task_run(&run).ok()? {
        return None;
    }
    Some(task_run_error(&run, json!({"error":message})))
}

pub(super) struct SelectedRun {
    pub run: TaskRun,
    pub is_new: bool,
}

pub(super) fn select_run(
    db: &Database,
    requested_id: Option<&str>,
    client_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<SelectedRun, McpToolCallResult> {
    let Some(id) = requested_id else {
        return Ok(SelectedRun {
            run: new_task_run(client_id, tool_name, arguments.clone()),
            is_new: true,
        });
    };
    let existing = db
        .get_task_run(id)
        .map_err(|error| invalid_request(id, &format!("Cannot read TaskRun: {error}")))?
        .ok_or_else(|| invalid_request(id, "TaskRun does not exist"))?;
    let expected_kind = if client_id == "atools-ui" {
        TaskRunInitiatorType::Human
    } else {
        TaskRunInitiatorType::Agent
    };
    if existing.capability_id != tool_name
        || existing.initiator.client_id.as_deref() != Some(client_id)
        || existing.initiator.kind != expected_kind
        || existing.input != *arguments
    {
        return Err(invalid_request(
            id,
            "TaskRun identity or arguments do not match this request",
        ));
    }
    match existing.status {
        TaskRunStatus::Created | TaskRunStatus::AwaitingPermission => Ok(SelectedRun {
            run: existing,
            is_new: false,
        }),
        TaskRunStatus::Running => Err(task_run_error(
            &existing,
            json!({"error":"TaskRun is already running","errorCode":"TASK_RUN_CONFLICT"}),
        )),
        _ => Err(invalid_request(
            id,
            "TaskRun is terminal; start a new run with the explicit retry API",
        )),
    }
}

fn invalid_request(id: &str, message: &str) -> McpToolCallResult {
    McpToolCallResult {
        structured_content: json!({"runId":id,"error":message,"errorCode":"TASK_RUN_RESUME_REJECTED"}),
        is_error: true,
    }
}

fn conflict(db: &Database, proposed: &TaskRun, message: String) -> McpToolCallResult {
    let current = db.get_task_run(&proposed.id).ok().flatten().filter(|run| {
        run.capability_id == proposed.capability_id
            && run.initiator == proposed.initiator
            && run.input == proposed.input
    });
    let Some(current) = current else {
        return McpToolCallResult {
            structured_content: json!({"runId":proposed.id,"error":message,"errorCode":"TASK_RUN_CONFLICT"}),
            is_error: true,
        };
    };
    task_run_error(
        &current,
        json!({"error":message,"errorCode":"TASK_RUN_CONFLICT"}),
    )
}

pub(super) fn persist_new(db: &Database, run: &TaskRun) -> Result<(), McpToolCallResult> {
    db.upsert_task_run(run)
        .map_err(|error| conflict(db, run, format!("Cannot persist new TaskRun: {error}")))
}

pub(super) fn persist_pending(db: &Database, run: &TaskRun) -> Result<(), McpToolCallResult> {
    match db.update_pending_task_run(run) {
        Ok(true) => Ok(()),
        Ok(false) => Err(conflict(db, run, "TaskRun is no longer pending".into())),
        Err(error) => Err(conflict(
            db,
            run,
            format!("Cannot update pending TaskRun: {error}"),
        )),
    }
}

pub(super) fn claim(db: &Database, run: &TaskRun) -> Result<(), McpToolCallResult> {
    match db.claim_task_run(run) {
        Ok(true) => Ok(()),
        Ok(false) => Err(conflict(
            db,
            run,
            "TaskRun was already claimed or changed".into(),
        )),
        Err(error) => Err(conflict(db, run, format!("Cannot claim TaskRun: {error}"))),
    }
}

pub(super) fn persist_terminal(db: &Database, run: &TaskRun) -> Result<(), McpToolCallResult> {
    match db.finish_running_task_run(run) {
        Ok(true) => Ok(()),
        Ok(false) => Err(conflict(
            db,
            run,
            "TaskRun already reached another terminal outcome".into(),
        )),
        Err(error) => Err(conflict(db, run, format!("Cannot finish TaskRun: {error}"))),
    }
}

pub(super) fn fail_before_execution(
    db: &Database,
    run: &mut TaskRun,
    message: &str,
    duration_ms: u64,
) -> McpToolCallResult {
    run.errors
        .push(TaskIssue::error("execution_failed", message));
    run.summary = Some(format!("{} failed: {message}", run.capability_id));
    run.metrics = json!({"durationMs":duration_ms});
    run.validation.status = TaskValidationStatus::Failed;
    run.validation.summary = Some("Executor was not started".into());
    let target = if run.status == TaskRunStatus::AwaitingPermission {
        TaskRunStatus::Cancelled
    } else {
        TaskRunStatus::Failed
    };
    run.transition(target)
        .expect("pending run can fail or be cancelled before execution");
    match persist_pending(db, run) {
        Ok(()) => task_run_error(run, json!({"error":message})),
        Err(error) => error,
    }
}

pub(super) fn finish_execution_failure(
    db: &Database,
    run: &mut TaskRun,
    failure: &super::node_startup_error_observation::AgentExecutionFailure,
    duration_ms: u64,
    audit_id: Option<String>,
) -> Result<(), McpToolCallResult> {
    run.audit_id = audit_id;
    let issue = match failure {
        super::node_startup_error_observation::AgentExecutionFailure::SourceBuild(
            crate::plugin_source_build::SourceBuildFailure::Runner(runner),
        ) => {
            super::node_startup_error_observation::source_build_failure_observation::attach_to_run(
                run, runner,
            )
        }
        _ => failure.task_issue(&run.id),
    };
    run.errors.push(issue);
    run.summary = Some(format!(
        "{} failed: {}",
        run.capability_id,
        failure.safe_message()
    ));
    run.metrics = json!({ "durationMs": duration_ms });
    run.validation.status = TaskValidationStatus::Failed;
    run.validation.summary = Some("Executor returned an error".into());
    run.transition(TaskRunStatus::Failed)
        .expect("created or running TaskRun can fail");
    persist_terminal(db, run)
}

#[cfg(test)]
#[path = "task_run_pipeline_tests.rs"]
mod tests;
