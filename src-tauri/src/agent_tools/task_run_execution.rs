use super::*;
use std::sync::Arc;
pub async fn call_tool_with_audit(
    app: &AppHandle,
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
    confirmed: bool,
) -> McpToolCallResult {
    let result = call_tool_with_task_run(
        app, client_id, tool_name, arguments, confirmed, None, db, None,
    )
    .await;
    super::guarded_app_launch::finalize_private_ai_run(app, db, &result);
    if tool_name.starts_with("atools.host.plugin-background.") {
        if let Some(run_id) = result
            .structured_content
            .get("runId")
            .and_then(Value::as_str)
        {
            crate::plugin_background_runtime::finalize_task_run(app, db, run_id).await;
        }
    }
    result
}
pub async fn resume_tool_with_audit(
    app: &AppHandle,
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
    confirmed: bool,
    run_id: Option<&str>,
) -> McpToolCallResult {
    let result = call_tool_with_task_run(
        app, client_id, tool_name, arguments, confirmed, run_id, db, None,
    )
    .await;
    super::guarded_app_launch::finalize_private_ai_run(app, db, &result);
    if tool_name.starts_with("atools.host.plugin-background.") {
        if let Some(run_id) = result
            .structured_content
            .get("runId")
            .and_then(Value::as_str)
        {
            crate::plugin_background_runtime::finalize_task_run(app, db, run_id).await;
        }
    }
    result
}

pub(super) async fn call_tool_with_task_run(
    app: &AppHandle,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
    confirmed: bool,
    run_id: Option<&str>,
    db: &Database,
    grant: Option<crate::app_launch_fence::AppLaunchGrant>,
) -> McpToolCallResult {
    let guarded = grant.is_some();
    let started = Instant::now();
    if let Err(error) = super::private_task_run_admission::validate_request(
        app, db, client_id, tool_name, &arguments,
    ) {
        if let Some(closed) = run_id.and_then(|id| {
            task_run_pipeline::fail_created_dispatch(
                db, id, client_id, tool_name, &arguments, &error,
            )
        }) {
            return closed;
        }
        return McpToolCallResult::error(error);
    }
    let mut arguments = arguments;
    let selected = match task_run_pipeline::select_run(db, run_id, client_id, tool_name, &arguments)
    {
        Ok(selected) => selected,
        Err(error) => return error,
    };
    let is_new = selected.is_new;
    let mut run = selected.run;
    if is_new {
        if let Err(error) = initialize_new_task_run(db, &mut run) {
            return McpToolCallResult::error(error);
        }
    }
    arguments = run.input.clone();
    if is_new {
        if let Err(error) = super::private_task_run_admission::validate_request(
            app, db, client_id, tool_name, &arguments,
        ) {
            return McpToolCallResult::error(error);
        }
        if let Err(error) = task_run_pipeline::persist_new(db, &run) {
            return error;
        }
    }
    if let Err(error) =
        crate::plugin_dialog_runtime::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_system_paths::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_data_runtime::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_secret_storage_runtime::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) = crate::plugin_main_push::bind_run(app, db, tool_name, &arguments, &run.id) {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_file_drop::commands::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) = crate::plugin_file_drag::bind_run(app, db, tool_name, &arguments, &run.id) {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_ai_runtime::privacy::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_display_runtime::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_browser_window_runtime::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    if let Err(error) =
        crate::plugin_background_runtime::bind_run(app, db, tool_name, &arguments, &run.id)
    {
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    let snapshot = match plugin_execution_snapshot::resolve_tool_with_gate(app, db, tool_name).await
    {
        Ok(Some(snapshot)) => snapshot,
        result => {
            let message = result
                .err()
                .unwrap_or_else(|| format!("Unknown tool: {tool_name}"));
            return task_run_pipeline::fail_before_execution(
                db,
                &mut run,
                &message,
                started.elapsed().as_millis() as u64,
            );
        }
    };
    let plugin_execution_snapshot::ExecutionSnapshot { tool, guard } = snapshot;
    let mut _plugin_execution = guard.map(Arc::new);
    // Waiting for a plugin writer is an observation boundary. Re-select the
    // exact persisted run so cancellation or a competing approval wins before
    // permission checks, claim, or any executable operation.
    run = match task_run_pipeline::select_run(db, Some(&run.id), client_id, tool_name, &arguments) {
        Ok(selected) => selected.run,
        Err(error) => return error,
    };
    if let Err(error) = super::private_task_run_admission::validate_request(
        app, db, client_id, tool_name, &arguments,
    ) {
        crate::permission_requests::remove_for_run(app, &run.id);
        return task_run_pipeline::fail_before_execution(
            db,
            &mut run,
            &error,
            started.elapsed().as_millis() as u64,
        );
    }
    let permission =
        permission_decision_for_tool(db, client_id, tool_name).unwrap_or(PermissionDecision::Deny);
    // The digest binds an approval boundary. Already-authorized bridge calls
    // avoid hashing schemas and re-reading plugin metadata on every RPC.
    let binds_created =
        run.status == TaskRunStatus::Created && plugin_execution_snapshot::binds_created(&tool);
    let needs_snapshot = binds_created
        || (confirmed && run.status == TaskRunStatus::AwaitingPermission)
        || (!confirmed && matches!(permission, PermissionDecision::Confirm));
    let capability_snapshot = if tool.plugin_id.is_some() && needs_snapshot {
        match plugin_execution_snapshot::snapshot_digest(db, &tool) {
            Ok(digest) => Some(digest),
            Err(error) => {
                return task_run_pipeline::fail_before_execution(
                    db,
                    &mut run,
                    &error,
                    started.elapsed().as_millis() as u64,
                )
            }
        }
    } else {
        None
    };
    if binds_created {
        if let Err(error) = plugin_execution_snapshot::validate_created(
            &run,
            capability_snapshot.as_deref().unwrap_or_default(),
        ) {
            return task_run_pipeline::fail_before_execution(
                db,
                &mut run,
                &error,
                started.elapsed().as_millis() as u64,
            );
        }
    }
    if confirmed && run.status == TaskRunStatus::AwaitingPermission {
        if let Some(digest) = &capability_snapshot {
            let request = crate::permission_requests::find_for_run(app, &run.id);
            if let Err(error) =
                plugin_execution_snapshot::validate_pending(&run, request.as_ref(), &tool, digest)
            {
                crate::permission_requests::remove_for_run(app, &run.id);
                return task_run_pipeline::fail_before_execution(
                    db,
                    &mut run,
                    &error,
                    started.elapsed().as_millis() as u64,
                );
            }
        }
    }
    if matches!(permission, PermissionDecision::Deny) {
        let entry = AuditLogEntry::new(client_id, tool_name, arguments, AuditStatus::Denied)
            .with_duration_ms(started.elapsed().as_millis() as u64)
            .with_error("Permission denied");
        run.audit_id =
            match super::guarded_app_launch::insert_audit(db, &mut run, &entry, guarded, false) {
                Ok(id) => id,
                Err(result) => return result,
            };
        run.errors
            .push(TaskIssue::error("permission_denied", "Permission denied"));
        run.summary = Some(format!("{tool_name} was denied by the permission policy"));
        run.metrics = json!({ "durationMs": started.elapsed().as_millis() as u64 });
        run.transition(TaskRunStatus::Cancelled)
            .expect("created TaskRun can be cancelled by policy");
        if let Err(error) = task_run_pipeline::persist_pending(db, &run) {
            return error;
        }
        crate::permission_requests::remove_for_run(app, &run.id);
        return task_run_error(&run, json!({ "error": "Permission denied" }));
    }
    if matches!(permission, PermissionDecision::Confirm) && !confirmed {
        let entry = AuditLogEntry::new(client_id, tool_name, arguments, AuditStatus::Denied)
            .with_duration_ms(started.elapsed().as_millis() as u64)
            .with_error("Permission confirmation required");
        let _ = db.insert_audit_entry(&entry);
        run.audit_id = Some(entry.id.clone());
        run.summary = Some(format!("{tool_name} is awaiting permission"));
        run.metrics = json!({ "durationMs": started.elapsed().as_millis() as u64 });
        run.transition(TaskRunStatus::AwaitingPermission)
            .expect("created TaskRun can await permission");
        let pending = build_pending_agent_tool_request_with_run(
            db,
            client_id,
            tool_name,
            entry.input.clone(),
            Some(run.id.clone()),
        )
        .unwrap_or_else(|_| PendingAgentToolRequest {
            id: format!("agent-confirm-{}", atools_core::utils::generate_rev()),
            run_id: Some(run.id.clone()),
            client_id: client_id.to_string(),
            tool_name: tool_name.to_string(),
            arguments: entry.input.clone(),
            scopes: tool.scopes.clone(),
            created_at: atools_core::utils::now_iso(),
        });
        let payload = permission_required_payload(&pending);
        run.output = payload.clone();
        if let Some(digest) = &capability_snapshot {
            plugin_execution_snapshot::record_snapshot(&mut run, digest);
        }
        if let Err(error) = task_run_pipeline::persist_pending(db, &run) {
            return error;
        }
        match crate::permission_requests::upsert_if_awaiting(app, pending.clone()) {
            Ok(true) => {}
            Ok(false) => {
                return db
                    .get_task_run(&run.id)
                    .ok()
                    .flatten()
                    .as_ref()
                    .map(task_run_result)
                    .unwrap_or_else(|| {
                        McpToolCallResult::error(
                            "Permission request is no longer awaiting approval",
                        )
                    })
            }
            Err(error) => {
                return task_run_pipeline::fail_before_execution(
                    db,
                    &mut run,
                    &error,
                    started.elapsed().as_millis() as u64,
                )
            }
        }
        let _ = app.emit("agent-permission-request", &pending);
        return task_run_error(&run, payload);
    }

    run.transition(TaskRunStatus::Running)
        .expect("authorized TaskRun can start");
    if let Err(error) = task_run_pipeline::claim(db, &run) {
        return error;
    }
    // A successful durable claim consumes this run's pending approval for
    // every capability. The exact run-id match leaves other requests queued.
    crate::permission_requests::remove_for_run(app, &run.id);
    let _ = app.emit("task-run-updated", run.id.clone());
    // File dragging releases the code read gate after AppKit acknowledges the
    // start; keeping it while the user holds the mouse would block teardown.
    let execution = super::background_gate::executor_guard(&tool.source, &mut _plugin_execution);
    let result = tool_executor::execute_agent_tool(
        app,
        db,
        &tool,
        arguments.clone(),
        client_id,
        &run.id,
        execution,
        grant,
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    if let Ok(Some(cancelled)) = db.get_task_run(&run.id) {
        if cancelled.status == TaskRunStatus::Cancelled {
            return task_run_error(&cancelled, json!({ "error": "TaskRun was cancelled" }));
        }
    }
    match result {
        Ok(output) => {
            let failed_items = structured_failed_items(&output);
            let item_count = output
                .get("items")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let task_status = structured_result_task_status(item_count, failed_items.len());
            let status = if task_status == TaskRunStatus::Failed {
                AuditStatus::Error
            } else if confirmed {
                AuditStatus::Confirmed
            } else {
                AuditStatus::Allowed
            };
            let mut entry = AuditLogEntry::new(client_id, tool_name, arguments, status)
                .with_output(output.clone())
                .with_duration_ms(duration_ms);
            if task_status == TaskRunStatus::Failed {
                entry = entry.with_error(format!("All {} result item(s) failed", item_count));
            }
            run.output = output.clone();
            run.audit_id = match super::guarded_app_launch::insert_audit(
                db, &mut run, &entry, guarded, true,
            ) {
                Ok(id) => id,
                Err(result) => return result,
            };
            run.summary = Some(structured_result_summary(tool_name, &output));
            run.metrics = json!({ "durationMs": duration_ms });
            run.artifacts = structured_result_artifacts(&run);
            run.errors = failed_items
                .into_iter()
                .map(|item| TaskIssue {
                    code: "item_failed".to_string(),
                    message: item
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Result item failed")
                        .to_string(),
                    details: Value::Object(item.clone()),
                    retryable: true,
                })
                .collect();
            if task_status == TaskRunStatus::Succeeded {
                run.validation.status = TaskValidationStatus::Passed;
                run.validation.summary =
                    Some("Structured executor completed without an error".to_string());
            } else {
                run.validation.status = TaskValidationStatus::Failed;
                run.validation.summary = Some(format!(
                    "{} of {} structured result item(s) failed",
                    run.errors.len(),
                    item_count
                ));
            }
            run.transition(task_status)
                .expect("running TaskRun can reach a structured result terminal state");
            if let Err(error) = task_run_pipeline::persist_terminal(db, &run) {
                return error;
            }
            if task_status == TaskRunStatus::Succeeded {
                let _ = db.record_memory_success(&run.memory_ids);
            }
            if task_status == TaskRunStatus::Failed {
                task_run_error(&run, output)
            } else {
                task_run_success(&run, output)
            }
        }
        Err(error) => {
            let entry = AuditLogEntry::new(client_id, tool_name, arguments, AuditStatus::Error)
                .with_duration_ms(duration_ms)
                .with_error(error.safe_message());
            let audit_id = match super::guarded_app_launch::insert_audit(
                db, &mut run, &entry, guarded, true,
            ) {
                Ok(id) => id,
                Err(result) => return result,
            };
            if let Err(conflict) = task_run_pipeline::finish_execution_failure(
                db,
                &mut run,
                &error,
                duration_ms,
                audit_id,
            ) {
                return conflict;
            }
            task_run_error(&run, error.error_observation(&run.id))
        }
    }
}
