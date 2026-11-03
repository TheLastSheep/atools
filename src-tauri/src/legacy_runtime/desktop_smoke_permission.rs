//! Opt-in UI fixture commands, never registered by the production application.
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn native_permission_fixture(app: AppHandle) -> Value {
    let fixture = app.state::<Arc<super::Fixture>>();
    json!({"pluginId":fixture.plugin.id,"pluginDir":fixture.plugin.path,
        "preloadPath":fixture.root.join("plugin/preload.cjs").to_string_lossy()})
}

#[tauri::command]
pub async fn native_permission_runtime_state(app: AppHandle) -> Value {
    let runtime = app.state::<Arc<crate::legacy_runtime::Sessions>>();
    let state = app.state::<AppState>();
    let sessions = runtime.sessions.read().len();
    let openings = runtime.openings.lock().len();
    let pending = state.pending_agent_requests.lock().len();
    let transport = runtime.server.lock().await.is_some();
    json!({"sessions":sessions,"openings":openings,"pending":pending,"transport":transport})
}

pub fn report(app: &AppHandle, result: Value) -> Result<Value, String> {
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format!("Native permission UI did not pass: {}", result));
    }
    let state = app.state::<AppState>();
    let runs = state.db.list_task_runs(1000).map_err(|e| e.to_string())?;
    if runs.iter().any(|run| !run.status.is_terminal())
        || !state.pending_agent_requests.lock().is_empty()
    {
        return Err("Native UI left nonterminal runs or pending permissions".into());
    }
    Ok(
        json!({"passed":true,"scope":"Actual PermissionPromptHost, production preload loader and Tauri JavaScript IPC in an isolated native incognito Wry window with temporary database; programmatic DOM button/keyboard events",
        "checks":result.get("checks"),"nodeRuntime":result.get("nodeRuntime"),"taskRuns":runs.len(),"limitations":["Controlled custom-protocol fixture and CSP; full production App and PluginPanel navigation are not mounted","Programmatic DOM interaction, not physical accessibility input","Single-platform macOS observation"]}),
    )
}
