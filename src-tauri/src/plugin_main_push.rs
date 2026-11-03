//! Window-owned dynamic launcher callbacks, sharing registry, permissions and TaskRun.
mod admission;
mod candidates;
pub(crate) mod commands;
mod dto;
mod execution;
mod inventory;
mod platform_source;
pub(crate) mod registry;
mod store;
#[cfg(test)]
mod tests;

use atools_core::{agent::ToolDefinition, Database};
use serde_json::Value;
use std::sync::Arc;
use store::{Intent, Runtime};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Runtime::default()));
}
pub(crate) fn inventory_snapshot(
    app: &AppHandle,
) -> Result<(Vec<crate::plugin_runtime_inventory::RuntimeSession>, bool), String> {
    inventory::inventory_snapshot(app)
}
fn manager(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    app.try_state::<Arc<Runtime>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "ERR_MAIN_PUSH_UI_REQUIRED".into())
}
fn parse(args: &Value) -> Result<dto::Request, String> {
    let object = args.as_object().ok_or("ERR_MAIN_PUSH_INPUT_INVALID")?;
    const KEYS: [&str; 9] = [
        "requestId",
        "runnerId",
        "pluginId",
        "featureCode",
        "commandType",
        "codeRevision",
        "operation",
        "inputBytes",
        "queryGeneration",
    ];
    if object.len() != KEYS.len() || object.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return Err("ERR_MAIN_PUSH_PRIVATE_METADATA_ONLY".into());
    }
    let request: dto::Request =
        serde_json::from_value(args.clone()).map_err(|_| "ERR_MAIN_PUSH_INPUT_INVALID")?;
    request.validate()?;
    Ok(request)
}
fn private_tool(db: &Database, client: &str, name: &str) -> Result<Option<ToolDefinition>, String> {
    let private_name = name.starts_with("plugin_main_push_");
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE")?
    else {
        return if private_name {
            Err("ERR_MAIN_PUSH_UI_REQUIRED".into())
        } else {
            Ok(None)
        };
    };
    if tool.source != registry::SOURCE {
        return if private_name {
            Err("ERR_MAIN_PUSH_CAPABILITY_UNAVAILABLE".into())
        } else {
            Ok(None)
        };
    }
    if client != "atools-ui" {
        return Err("ERR_MAIN_PUSH_UI_REQUIRED".into());
    }
    registry::validate(&tool)?;
    Ok(Some(tool))
}
fn intent_for(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<Option<Arc<Intent>>, String> {
    let Some(tool) = private_tool(db, client, name)? else {
        return Ok(None);
    };
    let request = parse(args)?;
    let intent = manager(app)?.get(&request.request_id)?;
    if intent.request != request
        || tool.name != registry::tool_name(&request.identity.plugin_id)
        || tool.plugin_id.as_deref() != Some(&request.identity.plugin_id)
        || app.get_webview_window(&intent.window).is_none()
    {
        return Err("ERR_MAIN_PUSH_UI_REQUIRED".into());
    }
    if request.operation != dto::Operation::Prepare {
        let admission =
            manager(app)?.admission(&intent.window, &request.runner_id, &request.identity)?;
        if intent.prepared_by.as_deref() != Some(admission.run.as_str()) {
            return Err("ERR_MAIN_PUSH_PREPARE_REQUIRED".into());
        }
        runner_confirmation(app, db, &intent.window, &request)?;
    }
    Ok(Some(intent))
}
fn runner_confirmation(
    app: &AppHandle,
    db: &Database,
    window: &str,
    request: &dto::Request,
) -> Result<bool, String> {
    admission::confirmation(manager(app)?.as_ref(), db, window, request)
}
fn close_set(app: &AppHandle, db: &Database, closed: store::Closed) {
    for intent in closed.intents {
        close_intent(app, db, &intent);
    }
    for run in closed.prepares {
        cancel_run(app, db, &run);
    }
}
pub(crate) fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    intent_for(app, db, client, name, args).map(|_| ())
}
pub(crate) fn bind_run(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args: &Value,
    run: &str,
) -> Result<(), String> {
    if let Some(intent) = intent_for(app, db, "atools-ui", name, args)? {
        let mut state = intent.state.lock();
        if state.closed || state.run.as_deref().is_some_and(|current| current != run) {
            return Err("ERR_MAIN_PUSH_REQUEST_CLOSED".into());
        }
        state.run = Some(run.into());
    }
    Ok(())
}
pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    execution: Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
) -> Result<Value, String> {
    execution::execute(app, db, tool, args, client, execution).await
}
fn cancel_run(app: &AppHandle, db: &Database, run: &str) {
    use atools_core::task_run::{TaskIssue, TaskRunStatus};
    if let Ok(Some(mut current)) = db.get_task_run(run) {
        if !current.status.is_terminal() {
            let running = current.status == TaskRunStatus::Running;
            current.errors.push(TaskIssue::error(
                "main_push_cancelled",
                "ERR_MAIN_PUSH_CANCELLED",
            ));
            current.summary =
                Some("MainPush callback cancelled; stale input cannot be replayed".into());
            if current.transition(TaskRunStatus::Cancelled).is_ok() {
                let saved = if running {
                    db.finish_running_task_run(&current)
                } else {
                    db.update_pending_task_run(&current)
                };
                if saved.unwrap_or(false) {
                    let _ = app.emit("task-run-updated", run);
                }
            }
        }
    }
    crate::permission_requests::remove_for_run(app, run);
}
fn close_intent(app: &AppHandle, db: &Database, intent: &Intent) {
    if let Some(run) = intent.close() {
        cancel_run(app, db, &run);
    }
}
pub(crate) fn invalidate(app: &AppHandle, db: &Database, plugin: Option<&str>) {
    platform_source::invalidate(plugin);
    if let Ok(runtime) = manager(app) {
        let closed = runtime.close(None, plugin, None, false);
        let windows = app
            .webview_windows()
            .into_keys()
            .collect::<std::collections::HashSet<_>>();
        close_set(app, db, closed);
        for window in windows {
            let _ = app.emit_to(
                window,
                "plugin-main-push-invalidated",
                serde_json::json!({"pluginId":plugin}),
            );
        }
    }
}
pub(crate) fn close_window(app: &AppHandle, label: &str) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        close_set(
            app,
            &state.db,
            runtime.close(Some(label), None, None, false),
        );
    }
}

/// Count-only diagnostics for native fixtures; no request ids, content or paths.
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) fn runtime_state(app: &AppHandle) -> Value {
    let Ok(runtime) = manager(app) else {
        return serde_json::json!({"available":false});
    };
    let store = runtime.0.lock();
    let items = &store.intents;
    let mut running = 0;
    let mut waiting = 0;
    for intent in items.values() {
        let state = intent.state.lock();
        if let Some(flight) = state.flight.as_ref() {
            running += 1;
            if flight
                .clock
                .remaining(
                    intent.request.operation.deadline(),
                    std::time::Instant::now(),
                )
                .is_none()
            {
                waiting += 1;
            }
        }
    }
    serde_json::json!({"available":true,"intents":items.len(),"admissions":store.admissions.len(),"running":running,"waiting":waiting})
}
