//! Private native entry: confirmation is derived only from the owned grant.
use super::*;

pub(crate) async fn call_guarded_app_launch(
    app: &AppHandle,
    db: &Database,
    grant: crate::app_launch_fence::AppLaunchGrant,
) -> McpToolCallResult {
    let arguments = json!({"path": grant.path(), "reveal": false});
    task_run_execution::call_tool_with_task_run(
        app,
        "atools-ui",
        "open_or_reveal_path",
        arguments,
        true,
        None,
        db,
        Some(grant),
    )
    .await
}

pub(super) fn finalize_private_ai_run(app: &AppHandle, db: &Database, result: &McpToolCallResult) {
    let Some(run_id) = result
        .structured_content
        .get("runId")
        .and_then(Value::as_str)
    else {
        return;
    };
    if let Ok(Some(run)) = db.get_task_run(run_id) {
        if run.status.is_terminal() {
            crate::plugin_ai_runtime::finalize_task_run(app, &run);
        }
    }
}

/// Guarded launches cannot claim an audit receipt that was never persisted.
/// Preserve legacy best-effort behavior for every non-guarded caller.
pub(super) fn insert_audit(
    db: &Database,
    run: &mut TaskRun,
    entry: &AuditLogEntry,
    guarded: bool,
    running: bool,
) -> Result<Option<String>, McpToolCallResult> {
    let written = db.insert_audit_entry(entry);
    if !guarded || written.is_ok() {
        return Ok(Some(entry.id.clone()));
    }
    run.audit_id = None;
    run.errors.push(TaskIssue::error(
        "audit_record_failed",
        "Audit record could not be saved; do not retry automatically",
    ));
    run.summary = Some("Audit record could not be saved".into());
    run.validation.status = TaskValidationStatus::Failed;
    run.validation.summary = Some("Audit persistence failed".into());
    let status = if running {
        TaskRunStatus::Failed
    } else {
        TaskRunStatus::Cancelled
    };
    run.transition(status)
        .expect("guarded run can terminate after audit failure");
    let persisted = if running {
        task_run_pipeline::persist_terminal(db, run)
    } else {
        task_run_pipeline::persist_pending(db, run)
    };
    if persisted.is_err() {
        return Err(McpToolCallResult::error(
            "Audit record failed and TaskRun terminal state is unknown; do not retry automatically",
        ));
    }
    Err(task_run_error(
        run,
        json!({"error":"Audit record failed; do not retry automatically"}),
    ))
}

#[cfg(test)]
#[path = "guarded_app_launch_tests.rs"]
mod tests;
