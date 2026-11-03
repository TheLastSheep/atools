//! Permission-bound metadata projection. No HTTP listener, Node runtime or idle task.
pub(crate) mod commands;
pub(crate) mod registry;
mod resolver;
mod source_hint;
mod store;
#[cfg(test)]
mod tests;

use atools_core::{
    agent::{PermissionDecision, ToolDefinition},
    task_run::TaskRunStatus,
    Database,
};
use serde_json::{json, Value};
use std::sync::Arc;
use store::{Binding, Runtime};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Runtime::default()));
    app.manage(source_hint::Hints::default());
}
fn manager(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    app.try_state::<Arc<Runtime>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Plugin paths runtime unavailable".into())
}

fn prepare_intent(args: &Value) -> Result<&str, String> {
    let fields = args.as_object().ok_or("Invalid path metadata")?;
    if fields.len() != 2 || args["operation"] != "prepare" || !fields.contains_key("intentId") {
        return Err("Private paths cannot enter durable task history".into());
    }
    let id = args["intentId"].as_str().ok_or("Missing path intent")?;
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Invalid path intent".into());
    }
    Ok(id)
}

pub(crate) fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "Path capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != registry::SOURCE {
        return Ok(());
    }
    let access = registry::access_for(&tool)?;
    if client != "atools-ui" {
        return Err("Plugin paths require a private host intent".into());
    }
    let intent_id = prepare_intent(args)?;
    let runtime = manager(app)?;
    let store = runtime.0.lock();
    let intent = store
        .intents
        .get(intent_id)
        .ok_or("Path authorization closed")?;
    if intent.owner.plugin != tool.plugin_id.as_deref().unwrap_or_default()
        || intent.access != access
        || intent.created.elapsed().as_secs() >= store::TTL_SECS
    {
        return Err("Path intent expired or identity changed".into());
    }
    Ok(())
}
pub(crate) fn bind_run(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args: &Value,
    run: &str,
) -> Result<(), String> {
    let Some(tool) = db
        .get_agent_tool(name)
        .map_err(|_| "Path capability unavailable")?
    else {
        return Ok(());
    };
    if tool.source != registry::SOURCE {
        return Ok(());
    }
    let runtime = manager(app)?;
    let store = runtime.0.lock();
    let intent = store
        .intents
        .get(args["intentId"].as_str().ok_or("Missing path intent")?)
        .ok_or("Path authorization closed")?;
    *intent.run.lock() = Some(run.into());
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
    validate_private_request(app, db, client, &tool.name, &args)?;
    let access = registry::access_for(tool)?;
    let plugin_id = tool.plugin_id.as_deref().ok_or("Missing path identity")?;
    let plugin = db.get_plugin(plugin_id).map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(db, &plugin)?;
    let runtime = manager(app)?;
    let intent_id = args["intentId"].as_str().ok_or("Missing path intent")?;
    {
        let store = runtime.0.lock();
        let intent = store
            .intents
            .get(intent_id)
            .ok_or("Path authorization closed")?;
        if intent.binding != binding || app.get_webview_window(&intent.owner.window).is_none() {
            return Err("Plugin changed or window closed".into());
        }
    }
    let config = app.state::<crate::state::AppState>().config.clone();
    let plugin_id = plugin_id.to_string();
    let guard = execution.ok_or("Path preparation requires the plugin execution gate")?;
    let paths = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        match access {
            registry::Access::Standard => resolver::standard(&config),
            registry::Access::PluginData => resolver::plugin_data(&config, &plugin_id),
        }
    })
    .await
    .map_err(|_| "Path preparation interrupted")??;
    let snapshot = runtime.publish(intent_id, &binding, paths)?;
    Ok(
        json!({"snapshotId":snapshot,"names":access.names(),"count":access.names().len(),"runtime":"plugin-system-paths"}),
    )
}

fn validate_snapshot(db: &Database, snapshot: &store::Snapshot) -> Result<(), String> {
    snapshot.binding.validate(db, &snapshot.owner.plugin)?;
    let tool = registry::tool_name(&snapshot.owner.plugin, snapshot.access);
    if crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool)?
        == PermissionDecision::Deny
        || !db
            .get_agent_tool(&tool)
            .map_err(|_| "Path capability unavailable")?
            .is_some_and(|t| t.enabled && registry::access_for(&t).ok() == Some(snapshot.access))
    {
        return Err("Path permission was revoked".into());
    }
    let run = snapshot
        .run
        .lock()
        .clone()
        .ok_or("Path preparation incomplete")?;
    if db
        .get_task_run(&run)
        .map_err(|_| "Path preparation unavailable")?
        .is_none_or(|r| r.status != TaskRunStatus::Succeeded)
    {
        return Err("Path preparation is not complete".into());
    }
    Ok(())
}

fn cancel(app: &AppHandle, db: &Database, id: &str) {
    if let Ok(Some(mut run)) = db.get_task_run(id) {
        if !run.status.is_terminal() {
            let running = run.status == TaskRunStatus::Running;
            run.summary =
                Some("Plugin path preparation closed; no plugin operation was replayed".into());
            if run.transition(TaskRunStatus::Cancelled).is_ok() {
                let changed = if running {
                    db.finish_running_task_run(&run)
                } else {
                    db.update_pending_task_run(&run)
                };
                if changed.unwrap_or(false) {
                    let _ = app.emit("task-run-updated", id);
                }
            }
        }
    }
    crate::permission_requests::remove_for_run(app, id);
}
pub(crate) fn invalidate(app: &AppHandle, db: &Database, plugin: Option<&str>) {
    if let Ok(runtime) = manager(app) {
        for run in runtime.close(None, plugin, None, false) {
            cancel(app, db, &run);
        }
    }
    if let Some(hints) = app.try_state::<source_hint::Hints>() {
        hints.invalidate(plugin);
    }
}
pub(crate) fn close_window(app: &AppHandle, window: &str) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        for run in runtime.close(None, None, Some(window), false) {
            cancel(app, &state.db, &run);
        }
    }
}
pub(crate) fn stop(app: &AppHandle) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        for run in runtime.close(None, None, None, true) {
            cancel(app, &state.db, &run);
        }
    }
}

#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) fn runtime_state(app: &AppHandle) -> Value {
    match manager(app) {
        Ok(runtime) => {
            let store = runtime.0.lock();
            json!({"pathRuntimeAvailable":true,"activePathSnapshots":store.snapshots.len(),"activePathIntents":store.intents.len(),"activePathPreparations":runtime.preparation_count(&store),"pathSnapshotBytes":store.snapshots.values().map(|s| s.paths.iter().map(|(k,v)| k.len()+v.len()).sum::<usize>()).sum::<usize>()})
        }
        Err(_) => {
            json!({"pathRuntimeAvailable":false,"activePathSnapshots":0,"activePathIntents":0,"activePathPreparations":0,"pathSnapshotBytes":0})
        }
    }
}
