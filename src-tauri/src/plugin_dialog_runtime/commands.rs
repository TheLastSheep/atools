//! Trusted-parent authorization only; preparation never displays a native picker.
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
pub(crate) async fn prepare_plugin_dialogs(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    access: super::registry::Access,
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
    if let Some(session) = runtime.existing(&owner, access) {
        if session.document.as_ref().map(|d| d.id()) != document.as_ref().map(|d| d.id()) {
            return Err("Plugin document changed; reopen the plugin".into());
        }
        validate_session(&state.db, &session)?;
        return Ok(
            json!({"sessionId":session.id,"requiresDialogs":true,"usage":"unknown","reused":true,"reason":"active_session"}),
        );
    }
    let scan_app = app.clone();
    let scan_plugin = plugin.clone();
    let scan_revision = binding.revision.clone();
    let usage = tauri::async_runtime::spawn_blocking(move || {
        scan_app
            .state::<Hints>()
            .scan(&scan_plugin, scan_revision.as_deref(), access)
    })
    .await
    .map_err(|_| "Dialog source hint interrupted")?;
    let requires_dialog = usage == Usage::Detected;
    // An old grant does not make an otherwise unused plugin open a listener.
    if !request_permission && !requires_dialog {
        return Ok(json!({"requiresDialogs":false,"usage":usage,"unavailable":true}));
    }
    if !super::native::supported() {
        return Err("ERR_ATOOLS_DIALOG_UNSUPPORTED_PLATFORM: cancellable native dialogs are currently available on macOS".into());
    }
    let name = registry::tool_name(&plugin_id, access);
    if !request_permission
        && !state
            .db
            .is_agent_tool_granted("atools-ui", &name)
            .map_err(|_| "Unable to check dialog grant")?
    {
        return Ok(json!({"requiresDialogs":requires_dialog,"usage":usage,"unavailable":true}));
    }
    registry::ensure_tool(&state.db, &plugin, access)?;
    if !request_permission
        && crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &name)?
            != PermissionDecision::Allow
    {
        return Ok(json!({"requiresDialogs":requires_dialog,"usage":usage,"unavailable":true}));
    }
    let intent = runtime.intent(preparation, binding, access)?;
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
    value["requiresDialogs"] = json!(requires_dialog);
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
        return Err("Dialog session belongs to another plugin instance".into());
    }
    validate_session(db, &session)?;
    Ok(session)
}
#[tauri::command]
pub(crate) async fn get_plugin_dialog_session(
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
    let server = server.as_ref().ok_or("Dialog transport is not running")?;
    validate_session(&state.db, &session)?;
    Ok(
        json!({"endpoint":format!("{}/dialog/{}",server.origin,session.token),"access":session.access}),
    )
}
#[tauri::command]
pub(crate) async fn close_plugin_dialogs(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    super::observations::note(super::observations::Event::CloseCommand);
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
pub(crate) async fn rotate_plugin_dialogs(
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
    {
        let store = runtime.store.lock();
        for session in store.sessions.values().filter(|s| s.owner == owner) {
            validate_session(&state.db, session)?;
        }
    }
    let sessions = runtime.rotate_bound(&owner, next, document)?;
    drop(execution);
    Ok(
        json!({"sessions":sessions.iter().map(|s| (s.access.label(), s.id.clone())).collect::<std::collections::HashMap<_,_>>(),"runtime":"plugin-dialog"}),
    )
}
