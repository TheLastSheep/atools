//! Trusted-parent asynchronous setup; synchronous frame calls never show a modal.
use super::{
    lifecycle, registry,
    source_hint::{Hints, Usage},
    types::{Binding, Owner},
    validate_session,
};
use crate::plugin_page_runtime::resolve_binding;
use atools_core::{agent::PermissionDecision, Database};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub(crate) async fn prepare_plugin_data(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    request_permission: bool,
    page_document_id: Option<String>,
) -> Result<Value, String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let document = resolve_binding(
        &app,
        window.label(),
        &plugin_id,
        page_document_id.as_deref(),
    )?;
    let runtime = super::manager(&app)?;
    // Registration precedes the first await: close/destroy cancels queued work.
    let preparation = runtime.begin_bound(owner.clone(), document.clone())?;
    let state = app.state::<crate::state::AppState>();
    for run in runtime.expire_intents() {
        lifecycle::cancel_pending(&app, &state.db, &run);
    }
    if app.get_webview_window(window.label()).is_none() {
        return Err("Plugin window closed".into());
    }
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(&state.db, &plugin)?;
    if let Some(session) = runtime.existing(&owner) {
        if session.document.as_ref().map(|d| d.id()) != document.as_ref().map(|d| d.id()) {
            return Err("Plugin document changed; reopen the plugin".into());
        }
        validate_session(&state.db, &session)?;
        return Ok(
            json!({"sessionId":session.id,"requiresData":true,"usage":"unknown","reused":true,"reason":"active_session"}),
        );
    }
    let scan_app = app.clone();
    let scan_plugin = plugin.clone();
    let scan_revision = binding.revision.clone();
    let usage = tauri::async_runtime::spawn_blocking(move || {
        scan_app
            .state::<Hints>()
            .scan(&scan_plugin, scan_revision.as_deref())
    })
    .await
    .map_err(|_| "Data source hint interrupted")?;
    let requires_data = usage == Usage::Detected;
    // An old grant does not make an otherwise unused plugin open a listener.
    if !request_permission && !requires_data {
        return Ok(json!({"requiresData":false,"usage":usage,"unavailable":true}));
    }
    let name = registry::tool_name(&plugin_id);
    if !request_permission
        && !state
            .db
            .is_agent_tool_granted("atools-ui", &name)
            .map_err(|_| "Unable to check data grant")?
    {
        return Ok(json!({"requiresData":requires_data,"usage":usage,"unavailable":true}));
    }
    registry::ensure_tool(&state.db, &plugin)?;
    if !request_permission
        && crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &name)?
            != PermissionDecision::Allow
    {
        return Ok(json!({"requiresData":requires_data,"usage":usage,"unavailable":true}));
    }
    let intent = runtime.intent(preparation, binding)?;
    drop(execution);
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &state.db,
        "atools-ui",
        &name,
        json!({"operation":"open","intentId":intent}),
        false,
    )
    .await;
    let mut value = result.structured_content;
    if value["permission_required"] == true {
        if let Some(run) = value["runId"].as_str() {
            if !runtime.bind_run(&intent, run) {
                lifecycle::cancel_pending(&app, &state.db, run);
            }
        }
    } else {
        runtime.store.lock().intents.remove(&intent);
    }
    value["requiresData"] = json!(requires_data);
    value["usage"] = json!(usage);
    Ok(value)
}
fn owned(
    runtime: &super::Sessions,
    db: &Database,
    window: &WebviewWindow,
    plugin: &str,
    instance: &str,
    id: &str,
) -> Result<std::sync::Arc<super::types::Session>, String> {
    let session = runtime.get(id)?;
    if session.owner != Owner::new(window.label(), plugin, instance)? {
        return Err("Data session belongs to another plugin instance".into());
    }
    validate_session(db, &session)?;
    Ok(session)
}
#[tauri::command]
pub(crate) async fn get_plugin_data_session(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    session_id: String,
) -> Result<Value, String> {
    let runtime = super::manager(&app)?;
    let state = app.state::<crate::state::AppState>();
    let session = owned(
        &runtime,
        &state.db,
        &window,
        &plugin_id,
        &instance_id,
        &session_id,
    )?;
    let server = runtime.server.lock().await;
    let server = server.as_ref().ok_or("Data transport is not running")?;
    validate_session(&state.db, &session)?;
    Ok(json!({"endpoint":format!("{}/data/{}",server.origin,session.token)}))
}
#[tauri::command]
pub(crate) async fn close_plugin_data(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let runtime = super::manager(&app)?;
    let state = app.state::<crate::state::AppState>();
    lifecycle::close(
        &app,
        &state.db,
        &runtime,
        Some(&Owner::new(window.label(), &plugin_id, &instance_id)?),
        None,
        None,
        false,
    )
    .await;
    Ok(())
}
#[tauri::command]
pub(crate) async fn rotate_plugin_data(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    next_instance_id: String,
    next_page_document_id: Option<String>,
) -> Result<Value, String> {
    let runtime = super::manager(&app)?;
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let next = Owner::new(window.label(), &plugin_id, &next_instance_id)?;
    let document = resolve_binding(
        &app,
        window.label(),
        &plugin_id,
        next_page_document_id.as_deref(),
    )?;
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let state = app.state::<crate::state::AppState>();
    let old = runtime
        .existing(&owner)
        .ok_or("No approved data session to rotate")?;
    validate_session(&state.db, &old)?;
    let (session, runs) = runtime.rotate_bound(&owner, next, &old.id, document)?;
    super::prune_web_storage_events(&app, &runtime);
    for run in runs {
        lifecycle::cancel_pending(&app, &state.db, &run);
    }
    drop(execution);
    Ok(json!({"sessionId":session.id,"requiresData":true,"runtime":"plugin-data"}))
}
