//! Trusted parent commands; plugin frames receive only the scoped endpoint.
use super::{
    lifecycle, registry,
    types::{Binding, Owner},
};
use crate::plugin_page_runtime::resolve_binding;
use atools_core::agent::PermissionDecision;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub(crate) async fn prepare_plugin_file_drag(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    request_permission: bool,
    page_document_id: Option<String>,
) -> Result<Value, String> {
    if !super::native::supported() {
        return Ok(json!({"unavailable":true}));
    }
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let document = resolve_binding(
        &app,
        window.label(),
        &plugin_id,
        page_document_id.as_deref(),
    )?;
    let runtime = super::manager(&app)?;
    if let Some(session) = runtime.existing(&owner) {
        if session.document.as_ref().map(|binding| binding.id())
            != document.as_ref().map(|binding| binding.id())
        {
            lifecycle::close(
                &app,
                &app.state::<crate::state::AppState>().db,
                &runtime,
                Some(&owner),
                None,
                None,
                None,
                false,
            )
            .await;
            return Err("File-drag document changed; reopen the plugin".into());
        }
        let state = app.state::<crate::state::AppState>();
        if let Err(error) = super::validate_session(&state.db, &session) {
            lifecycle::close(
                &app,
                &state.db,
                &runtime,
                Some(&owner),
                None,
                None,
                None,
                false,
            )
            .await;
            return Err(error);
        }
        return Ok(json!({"sessionId":session.id,"reused":true}));
    }

    // Register before awaits so close/update can revoke this not-yet-open owner.
    let preparation = runtime.begin(&app, owner.clone(), document.as_ref())?;
    let state = app.state::<crate::state::AppState>();
    if app.get_webview_window(window.label()).is_none() {
        return Err("Plugin window closed".into());
    }
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    if !runtime.preparation_active(&preparation)
        || document
            .as_ref()
            .is_some_and(|binding| !binding.is_active())
    {
        return Err("File-drag preparation was cancelled".into());
    }
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(&state.db, &plugin)?;
    let tool = registry::ensure_tool(&state.db, &plugin)?;
    let decision = crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &tool)?;
    if decision == PermissionDecision::Deny
        || (!request_permission && decision != PermissionDecision::Allow)
    {
        return Ok(json!({"unavailable":true}));
    }
    if !runtime.preparation_active(&preparation) {
        return Err("File-drag preparation was cancelled".into());
    }

    let intent = runtime.create_intent(preparation, binding, document)?;
    drop(execution);
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &state.db,
        "atools-ui",
        &tool,
        json!({"operation":"open","intentId":intent}),
        false,
    )
    .await;
    let mut value = result.structured_content;
    if value["permission_required"] == true {
        if let Some(run_id) = value["runId"].as_str() {
            if let Err(error) = runtime.bind_intent_run(&intent, run_id) {
                lifecycle::cancel_pending(&app, &state.db, run_id);
                runtime.remove_intent(&intent);
                runtime.idle(&app).await;
                return Err(error);
            }
        }
        value["tool"] = json!(tool);
        return Ok(value);
    }
    if result.is_error || value.get("sessionId").is_none() {
        runtime.remove_intent(&intent);
        runtime.idle(&app).await;
        if !value.is_object() {
            value = json!({"unavailable":true});
        }
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn get_plugin_file_drag_session(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    session_id: String,
) -> Result<Value, String> {
    let runtime = super::manager(&app)?;
    let state = app.state::<crate::state::AppState>();
    let session = runtime.get(&session_id)?;
    if session.owner != Owner::new(window.label(), &plugin_id, &instance_id)? {
        return Err("File-drag session belongs to another plugin instance".into());
    }
    if let Err(error) = super::validate_session(&state.db, &session) {
        lifecycle::close(
            &app,
            &state.db,
            &runtime,
            Some(&session.owner),
            None,
            None,
            None,
            false,
        )
        .await;
        return Err(error);
    }
    let server = runtime.server.lock().await;
    let origin = server
        .as_ref()
        .ok_or("File-drag transport is not running")?
        .origin
        .clone();
    super::validate_session(&state.db, &session)?;
    Ok(json!({"endpoint":format!("{origin}/file-drag/{}",session.token)}))
}

#[tauri::command]
pub(crate) async fn close_plugin_file_drag(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let runtime = super::manager(&app)?;
    let state = app.state::<crate::state::AppState>();
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    lifecycle::close(
        &app,
        &state.db,
        &runtime,
        Some(&owner),
        None,
        None,
        None,
        false,
    )
    .await;
    Ok(())
}
