//! Trusted PluginPanel commands. Private options and native results stay in memory.
use crate::{plugin_window_sources::SourceBinding, state::AppState};
use atools_core::{agent::PermissionDecision, mcp::McpToolCallResult};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

const CLIENT: &str = "atools-ui";

#[tauri::command]
pub(crate) async fn prepare_plugin_browser_window(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    source_binding_id: String,
    window_id: String,
    options: Value,
) -> Result<Value, String> {
    let source = resolve_source(&app, &window, &state.db, &source_binding_id)?;
    let plugin = state
        .db
        .get_plugin(&source.owner().plugin)
        .map_err(|_| "Plugin BrowserWindow source is unavailable")?;
    let tool = super::registry::ensure_tool(&state.db, &plugin)?;
    let parent_was_visible = window
        .is_visible()
        .map_err(|_| "Unable to inspect parent window visibility")?;
    let runtime = super::manager(&app)?;
    let intent = runtime.create_open_intent(
        source.owner().clone(),
        source.id().to_string(),
        window_id,
        options,
        parent_was_visible,
    )?;
    let input = json!({"operation":"open","intentId":intent.id});
    let result =
        crate::agent_tools::call_tool_with_audit(&app, &state.db, CLIENT, &tool, input, false)
            .await;
    prepared_result(
        &app, &window, &state.db, &runtime, &intent, &tool, "open", result,
    )
    .await
}

#[tauri::command]
pub(crate) async fn prepare_plugin_browser_window_action(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    source_binding_id: String,
    window_id: String,
    action: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let source = resolve_source(&app, &window, &state.db, &source_binding_id)?;
    if action == "startDragging"
        && !super::dragging::source_is_exact_child(source.frame_id(), &window_id)
    {
        return Err(
            "ERR_ATOOLS_NATIVE_WINDOW_AUTHORIZATION: startDragging requires its exact child document"
                .into(),
        );
    }
    let plugin = state
        .db
        .get_plugin(&source.owner().plugin)
        .map_err(|_| "Plugin BrowserWindow source is unavailable")?;
    let tool = super::registry::ensure_tool(&state.db, &plugin)?;
    let runtime = super::manager(&app)?;
    let target = runtime.window_for_source(&source, &window_id)?;
    if action == "__renderReady" && target.creator_binding_id != source.id() {
        return Err("BrowserWindow renderer readiness belongs to another source".into());
    }
    let intent = runtime.create_action_intent(
        source.owner().clone(),
        source.id().to_string(),
        window_id,
        action,
        args,
        target.parent_was_visible,
    )?;
    let input = json!({"operation":"action","intentId":intent.id});
    // A successfully opened window carries the source-bound authorization.
    // Still create one durable, independently checked TaskRun for each action.
    let result =
        crate::agent_tools::call_tool_with_audit(&app, &state.db, CLIENT, &tool, input, true).await;
    prepared_result(
        &app, &window, &state.db, &runtime, &intent, &tool, "action", result,
    )
    .await
}

#[tauri::command]
pub(crate) fn take_plugin_browser_window_result(
    app: AppHandle,
    window: WebviewWindow,
    intent_id: String,
) -> Result<Value, String> {
    if !super::intents::is_private_id(&intent_id) {
        return Err("Invalid BrowserWindow intent".into());
    }
    let runtime = super::manager(&app)?;
    let intent = runtime.intent(&intent_id)?;
    let restore_parent = intent
        .permission_prompt_shown
        .load(std::sync::atomic::Ordering::Acquire)
        && !intent.parent_was_visible;
    let result = runtime.take_result(window.label(), &intent_id);
    if result.is_err() && restore_parent {
        if let Some(parent) = app.get_webview_window(&intent.owner.window) {
            let _ = parent.hide();
        }
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_plugin_browser_window_intent(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    intent_id: String,
) -> Result<(), String> {
    if !super::intents::is_private_id(&intent_id) {
        return Err("Invalid BrowserWindow intent".into());
    }
    let runtime = super::manager(&app)?;
    let intent = runtime.intent(&intent_id)?;
    if intent.owner.window != window.label() {
        return Err("BrowserWindow intent belongs to another invoker".into());
    }
    super::lifecycle::cancel_intent(
        &app,
        &state.db,
        &runtime,
        &intent_id,
        "BrowserWindow request cancelled",
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn close_plugin_browser_windows(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    source_binding_id: String,
) -> Result<(), String> {
    let source = resolve_source(&app, &window, &state.db, &source_binding_id)?;
    if source.frame_id() != "main" {
        return Err("Only the plugin main frame can close all of its BrowserWindows".into());
    }
    let plugin = state
        .db
        .get_plugin(&source.owner().plugin)
        .map_err(|_| "Plugin BrowserWindow source is unavailable")?;
    let tool = super::registry::ensure_tool(&state.db, &plugin)?;
    let runtime = super::manager(&app)?;
    for target in runtime.windows_created_by(&source) {
        if *target.life.lock() != super::intents::WindowLife::Alive {
            continue;
        }
        let intent = runtime.create_action_intent(
            source.owner().clone(),
            source.id().to_string(),
            target.frontend_window_id.clone(),
            "destroy".into(),
            Vec::new(),
            target.parent_was_visible,
        )?;
        let input = json!({"operation":"action","intentId":intent.id});
        let result =
            crate::agent_tools::call_tool_with_audit(&app, &state.db, CLIENT, &tool, input, true)
                .await;
        if result.is_error {
            let _ = runtime.take_result(window.label(), &intent.id);
            return Err("Unable to close plugin BrowserWindow".into());
        }
        let _ = runtime.take_result(window.label(), &intent.id);
    }
    Ok(())
}

fn resolve_source(
    app: &AppHandle,
    window: &WebviewWindow,
    db: &atools_core::Database,
    source_id: &str,
) -> Result<SourceBinding, String> {
    let source = crate::plugin_window_sources::resolve(app, window.label(), source_id)?;
    source.validate(app, db)?;
    if source.owner().window != window.label() {
        return Err("Plugin BrowserWindow source owner mismatch".into());
    }
    Ok(source)
}

async fn prepared_result(
    app: &AppHandle,
    window: &WebviewWindow,
    db: &atools_core::Database,
    runtime: &super::manager::Runtime,
    intent: &std::sync::Arc<super::intents::Intent>,
    tool: &str,
    operation: &str,
    result: McpToolCallResult,
) -> Result<Value, String> {
    let mut value = result.structured_content;
    let run_id = value
        .get("runId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(run_id) = run_id else {
        runtime.cancel_intent(&intent.id, "TaskRun was not created");
        return Err("Unable to create audited BrowserWindow TaskRun".into());
    };
    let permission_required = value
        .get("permission_required")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if permission_required {
        let was_hidden = !intent.parent_was_visible;
        if was_hidden && window.show().is_err() {
            super::lifecycle::cancel_intent(
                app,
                db,
                runtime,
                &intent.id,
                "Unable to show permission host",
            );
            return Err("Unable to show BrowserWindow permission host".into());
        }
        if window.set_focus().is_err() {
            if was_hidden {
                let _ = window.hide();
            }
            super::lifecycle::cancel_intent(
                app,
                db,
                runtime,
                &intent.id,
                "Unable to focus permission host",
            );
            return Err("Unable to focus BrowserWindow permission host".into());
        }
        // Record every prompt, not only prompts that forced a hidden parent
        // visible. A drag request must not reuse the original mouse-down after
        // it has waited for user authorization.
        intent
            .permission_prompt_shown
            .store(true, std::sync::atomic::Ordering::Release);
    } else if result.is_error {
        if let Ok(Some(run)) = db.get_task_run(&run_id) {
            if run.status.is_terminal() && intent.state() != super::intents::IntentState::Complete {
                let message =
                    match crate::agent_tools::permission_decision_for_tool(db, CLIENT, tool) {
                        Ok(PermissionDecision::Deny) => "Permission denied",
                        _ => "BrowserWindow request did not complete",
                    };
                runtime.finish_intent(intent, Err(message.into()));
            }
        }
    }
    let mut object = value.as_object_mut().cloned().unwrap_or_default();
    object.insert("intentId".into(), Value::String(intent.id.clone()));
    object.insert("operation".into(), Value::String(operation.into()));
    object.insert(
        "permission_required".into(),
        Value::Bool(permission_required),
    );
    object.insert("client_id".into(), Value::String(CLIENT.into()));
    object.insert("tool".into(), Value::String(tool.into()));
    object.insert(
        "arguments".into(),
        json!({"operation":operation,"intentId":intent.id}),
    );
    Ok(Value::Object(object))
}
