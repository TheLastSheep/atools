//! Trusted parent commands. Original query/option data never enters execution metadata.
use super::{
    candidates,
    dto::{CommandType, Identity, Operation, Receipt, Request},
    registry,
};
use crate::state::AppState;
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub(crate) async fn search_plugin_main_push_candidates(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    query: String,
    fixed_content: Option<bool>,
) -> Result<Vec<candidates::Candidate>, String> {
    let db = state.db.clone();
    let builtin_root = app
        .path()
        .resolve("plugins/builtin", tauri::path::BaseDirectory::Resource)
        .ok();
    tauri::async_runtime::spawn_blocking(move || {
        candidates::search(
            &db,
            &query,
            fixed_content.unwrap_or(false),
            builtin_root.as_deref(),
        )
    })
    .await
    .map_err(|_| "ERR_MAIN_PUSH_CATALOG_UNAVAILABLE")?
}
// An IPC future lost before/while acquiring a gate cannot strand a pending run.
struct Admission {
    app: AppHandle,
    intent: std::sync::Arc<super::Intent>,
    retain: bool,
    successful: bool,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if !self.retain {
            if let Ok(runtime) = super::manager(&self.app) {
                let closed = runtime.finish(&self.intent, self.successful);
                if let Some(state) = self.app.try_state::<AppState>() {
                    super::close_set(&self.app, &state.db, closed);
                }
            }
            if let Some(state) = self.app.try_state::<AppState>() {
                super::close_intent(&self.app, &state.db, &self.intent);
            }
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_plugin_main_push(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    runner_id: String,
    plugin_id: String,
    feature_code: String,
    command_type: CommandType,
    code_revision: String,
    operation: Operation,
    input_bytes: u32,
    query_generation: u32,
) -> Result<Value, String> {
    if app.get_webview_window(window.label()).is_none() {
        return Err("ERR_MAIN_PUSH_UI_REQUIRED".into());
    }
    let runtime = super::manager(&app)?;
    let state = app.state::<AppState>();
    super::close_set(&app, &state.db, runtime.close(None, None, None, true));
    let request = Request {
        request_id,
        runner_id,
        identity: Identity {
            plugin_id,
            feature_code,
            command_type,
            code_revision,
        },
        operation,
        input_bytes,
        query_generation,
    };
    request.validate()?;
    // Admission creates the opaque UI intent before an approval can be queued.
    let intent = runtime.begin(window.label().into(), request)?;
    let mut admission = Admission {
        app: app.clone(),
        intent: intent.clone(),
        retain: false,
        successful: false,
    };
    let execution =
        crate::plugin_lifecycle::execution(&app, &intent.request.identity.plugin_id).await;
    let plugin = match candidates::validate(&state.db, &intent.request.identity) {
        Ok(plugin) => plugin,
        Err(error) => {
            runtime.remove(&intent.request.request_id, None);
            super::close_intent(&app, &state.db, &intent);
            return Err(error);
        }
    };
    // An invalidation can win while this request waits for the execution gate.
    runtime.get(&intent.request.request_id)?;
    let tool = registry::ensure(&state.db, &plugin)?;
    let confirmed = super::runner_confirmation(&app, &state.db, window.label(), &intent.request)?;
    drop(execution);
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &state.db,
        "atools-ui",
        &tool,
        serde_json::to_value(&intent.request).map_err(|_| "ERR_MAIN_PUSH_INPUT_INVALID")?,
        confirmed,
    )
    .await;
    let output = result.structured_content;
    admission.retain = output["permission_required"] == true;
    admission.successful = output["status"] == "succeeded";
    Ok(output)
}
#[tauri::command]
pub(crate) fn complete_plugin_main_push(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    request_id: String,
    outcome: super::dto::Outcome,
    row_count: u8,
    duration_ms: u32,
) -> Result<(), String> {
    let runtime = super::manager(&app)?;
    runtime.get(&request_id)?.complete(
        window.label(),
        Receipt {
            ticket,
            request_id,
            outcome,
            row_count,
            duration_ms,
        },
    )
}
#[tauri::command]
pub(crate) fn set_plugin_main_push_waiting(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    ticket: String,
    waiting: bool,
) -> Result<(), String> {
    super::manager(&app)?
        .get(&request_id)?
        .waiting(window.label(), &ticket, waiting)
}
#[tauri::command]
pub(crate) fn cancel_plugin_main_push(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&request_id).map_err(|_| "ERR_MAIN_PUSH_ID_INVALID")?;
    let state = app.state::<AppState>();
    let runtime = super::manager(&app)?;
    if let Some(runner) = runtime.preparation_runner(window.label(), &request_id) {
        super::close_set(
            &app,
            &state.db,
            runtime.close(Some(window.label()), None, Some(&runner), false),
        );
    }
    if let Some(intent) = runtime.remove(&request_id, Some(window.label())) {
        super::close_intent(&app, &state.db, &intent);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn close_plugin_main_push_runner(
    app: AppHandle,
    window: WebviewWindow,
    runner_id: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&runner_id).map_err(|_| "ERR_MAIN_PUSH_ID_INVALID")?;
    let state = app.state::<AppState>();
    let closed = super::manager(&app)?.close(Some(window.label()), None, Some(&runner_id), false);
    super::close_set(&app, &state.db, closed);
    Ok(())
}
