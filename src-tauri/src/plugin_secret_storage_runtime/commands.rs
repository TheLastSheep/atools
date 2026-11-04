use super::{
    lifecycle, registry,
    types::{Binding, Owner},
};
use crate::plugin_page_runtime::resolve_binding;
use atools_core::agent::PermissionDecision;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub(crate) async fn prepare_plugin_secret_storage(
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
    let rt = super::manager(&app)?;
    let state = app.state::<crate::state::AppState>();
    for run in rt.expire_intents() {
        lifecycle::cancel_pending(&app, &state.db, &run);
    }
    let prep = rt.begin(
        owner.clone(),
        document.as_ref().map(|binding| binding.id().to_owned()),
    )?;
    if app.get_webview_window(window.label()).is_none() {
        return Err("Plugin window closed".into());
    }
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(&state.db, &plugin)?;
    if let Some(session) = rt.existing(&owner) {
        if session.document.as_ref().map(|d| d.id()) != document.as_ref().map(|d| d.id()) {
            lifecycle::close(&app, &state.db, &rt, Some(&owner), None, None, false).await;
            return Err("Plugin document changed".into());
        }
        if let Err(error) = super::validate_session(&state.db, &session) {
            lifecycle::close(&app, &state.db, &rt, Some(&owner), None, None, false).await;
            return Err(error);
        }
        return Ok(json!({"sessionId":session.id,"available":true,"reused":true}));
    }
    registry::ensure_tool(&state.db, &plugin)?;
    let tool = registry::tool_name(&plugin_id);
    if !request_permission
        && crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &tool)?
            != PermissionDecision::Allow
    {
        return Ok(json!({"available":false,"unavailable":true}));
    }
    let intent = rt.intent(prep, binding, document)?;
    drop(execution);
    {
        let rt = rt.clone();
        let app = app.clone();
        let db = state.db.clone();
        let id = intent.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            if let Some(run) = rt.expire_intent(&id) {
                lifecycle::cancel_pending(&app, &db, &run)
            }
        });
    }
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &state.db,
        "atools-ui",
        &tool,
        json!({"operation":"open","intentId":intent}),
        false,
    )
    .await;
    let value = result.structured_content;
    if value["permission_required"] == true {
        if let Some(run) = value["runId"].as_str() {
            if !rt.bind_run(&intent, run) {
                lifecycle::cancel_pending(&app, &state.db, run)
            }
        }
    } else {
        rt.store.lock().intents.remove(&intent);
    }
    Ok(value)
}
#[tauri::command]
pub(crate) async fn get_plugin_secret_storage_session(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    session_id: String,
) -> Result<Value, String> {
    let rt = super::manager(&app)?;
    let state = app.state::<crate::state::AppState>();
    let session = rt.get(&session_id)?;
    if session.owner != Owner::new(window.label(), &plugin_id, &instance_id)? {
        return Err("Secret storage session owner mismatch".into());
    }
    if let Err(error) = super::validate_session(&state.db, &session) {
        lifecycle::close(
            &app,
            &state.db,
            &rt,
            Some(&session.owner),
            None,
            None,
            false,
        )
        .await;
        return Err(error);
    }
    let server = rt.server.lock().await;
    let origin = server
        .as_ref()
        .ok_or("Secret storage transport unavailable")?
        .origin
        .clone();
    if let Err(error) = super::validate_session(&state.db, &session) {
        drop(server);
        lifecycle::close(
            &app,
            &state.db,
            &rt,
            Some(&session.owner),
            None,
            None,
            false,
        )
        .await;
        return Err(error);
    }
    Ok(json!({"endpoint":format!("{origin}/secrets/{}",session.token),"available":true}))
}
#[tauri::command]
pub(crate) async fn close_plugin_secret_storage(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let rt = super::manager(&app)?;
    let state = app.state::<crate::state::AppState>();
    lifecycle::close(
        &app,
        &state.db,
        &rt,
        Some(&Owner::new(window.label(), &plugin_id, &instance_id)?),
        None,
        None,
        false,
    )
    .await;
    Ok(())
}
