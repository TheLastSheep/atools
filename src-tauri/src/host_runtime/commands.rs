use super::{
    manager,
    registry::{self, Access},
    validate_session,
};
use crate::plugin_page_runtime::{resolve_binding, DocumentBinding};
use crate::state::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

pub fn window_owner(label: &str, instance: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(instance).map_err(|_| "Invalid plugin instance")?;
    Ok(format!("window:{label}:{id}"))
}
#[tauri::command]
pub async fn prepare_host_clipboard(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
    access: String,
    request_permission: bool,
    page_document_id: Option<String>,
) -> Result<Value, String> {
    let document = resolve_binding(
        &app,
        window.label(),
        &plugin_id,
        page_document_id.as_deref(),
    )?;
    prepare(
        &app,
        &state.db,
        &window_owner(window.label(), &instance_id)?,
        &plugin_id,
        Access::parse(&access)?,
        request_permission,
        document,
    )
    .await
}
pub async fn prepare(
    app: &AppHandle,
    db: &atools_core::Database,
    owner: &str,
    plugin_id: &str,
    access: Access,
    request_permission: bool,
    document: Option<DocumentBinding>,
) -> Result<Value, String> {
    if document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Plugin document closed".into());
    }
    let execution = crate::plugin_lifecycle::execution(app, plugin_id).await;
    let plugin = db.get_plugin(plugin_id).map_err(|_| "Plugin not found")?;
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let runtime = manager(app)?;
    let existing = runtime
        .store
        .lock()
        .sessions
        .values()
        .find(|s| s.owner == owner && s.plugin == plugin_id && s.access == access)
        .cloned();
    if let Some(session) = existing {
        if session.document.as_ref().map(|d| d.id()) != document.as_ref().map(|d| d.id()) {
            return Err("Plugin document changed; reopen the plugin".into());
        }
        if validate_session(db, &session).is_ok() {
            return Ok(json!({"sessionId":session.id,"reused":true}));
        }
        runtime.remove(&session.id).await;
    }
    let name = registry::tool_name(plugin_id, access);
    // Pure metadata plugins do not register a capability, create a task, start a
    // listener, or ask permission. Only an explicit saved grant may prewarm.
    if !request_permission
        && !db
            .is_agent_tool_granted("atools-ui", &name)
            .map_err(|e| e.to_string())?
    {
        return Ok(json!({"unavailable":true}));
    }
    registry::ensure_tool(db, &plugin, access)?;
    if !request_permission
        && crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &name)?
            != atools_core::agent::PermissionDecision::Allow
    {
        return Ok(json!({"unavailable":true}));
    }
    let intent = runtime.intent_with_document(owner.into(), plugin_id.into(), access, document)?;
    drop(execution);
    let result = crate::agent_tools::call_tool_with_audit(
        app,
        db,
        "atools-ui",
        &name,
        json!({"operation":"open","intentId":intent}),
        false,
    )
    .await;
    let pending_run = result
        .structured_content
        .get("permission_required")
        .and_then(Value::as_bool)
        == Some(true);
    if pending_run {
        if let Some(run) = result
            .structured_content
            .get("runId")
            .and_then(Value::as_str)
        {
            let bound = {
                let state = runtime.store.lock();
                if let Some(intent) = state.intents.get(&intent).filter(|i| {
                    !i.cancelled.load(std::sync::atomic::Ordering::Acquire)
                        && i.document.as_ref().is_none_or(|d| d.is_active())
                }) {
                    *intent.run.lock() = Some(run.into());
                    true
                } else {
                    false
                }
            };
            if !bound {
                super::lifecycle::cancel_pending(app, db, run);
            }
        }
    } else {
        runtime.store.lock().intents.remove(&intent);
    }
    Ok(result.structured_content)
}
#[tauri::command]
pub async fn get_host_clipboard_session(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
    session_id: String,
) -> Result<Value, String> {
    let runtime = manager(&app)?;
    let session = runtime.get(&session_id)?;
    if session.owner != window_owner(window.label(), &instance_id)? || session.plugin != plugin_id {
        return Err("Clipboard session belongs to another plugin instance".into());
    }
    validate_session(&state.db, &session)?;
    let tool = state
        .db
        .get_agent_tool(&session.tool)
        .map_err(|_| "Clipboard capability unavailable")?
        .ok_or("Clipboard capability unavailable")?;
    if registry::access_for(&tool)? != session.access {
        return Err("Clipboard capability changed".into());
    }
    let server = runtime.server.lock().await;
    let server = server
        .as_ref()
        .ok_or("Clipboard transport is not running")?;
    validate_session(&state.db, &session)?;
    let expires_in_ms = session
        .once_authorization
        .as_ref()
        .map(|proof| proof.remaining_ms());
    if expires_in_ms == Some(0) {
        return Err("Clipboard authorization expired".into());
    }
    Ok(
        json!({"endpoint":format!("{}/host/{}", server.origin, session.token),
        "access":session.access,"expiresInMs":expires_in_ms}),
    )
}
#[tauri::command]
pub async fn close_host_clipboard(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let runtime = manager(&app)?;
    super::lifecycle::close(
        &app,
        &state.db,
        &runtime,
        Some(&window_owner(window.label(), &instance_id)?),
        Some(&plugin_id),
        false,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn rotate_host_clipboard(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
    next_instance_id: String,
    next_page_document_id: Option<String>,
) -> Result<(), String> {
    let runtime = manager(&app)?;
    let owner = window_owner(window.label(), &instance_id)?;
    let next = window_owner(window.label(), &next_instance_id)?;
    let document = resolve_binding(
        &app,
        window.label(),
        &plugin_id,
        next_page_document_id.as_deref(),
    )?;
    let sessions: Vec<_> = runtime
        .store
        .lock()
        .sessions
        .values()
        .filter(|s| s.owner == owner && s.plugin == plugin_id)
        .cloned()
        .collect();
    for session in &sessions {
        validate_session(&state.db, session)?;
        let tool = state
            .db
            .get_agent_tool(&session.tool)
            .map_err(|_| "Clipboard capability unavailable")?
            .ok_or("Clipboard capability unavailable")?;
        if registry::access_for(&tool)? != session.access {
            return Err("Clipboard capability changed".into());
        }
    }
    let ids: Vec<_> = sessions.into_iter().map(|s| s.id.clone()).collect();
    for run in runtime.rotate_bound(&owner, &next, &plugin_id, &ids, document)? {
        super::lifecycle::cancel_pending(&app, &state.db, &run);
    }
    Ok(())
}
