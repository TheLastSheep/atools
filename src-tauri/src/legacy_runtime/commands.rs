use super::{
    manager,
    node_entry::{self, Hints},
    registry,
    sessions::Sessions,
    validate_session,
};
use crate::plugin_page_runtime::resolve_binding;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub async fn prepare_legacy_node(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
    selected_preload: Option<String>,
) -> Result<Value, String> {
    let owner = window_owner(window.label(), &instance_id)?;
    let document = resolve_binding(
        &app,
        window.label(),
        &plugin_id,
        page_document_id.as_deref(),
    )?;
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin not found")?;
    let entry_plugin = plugin.clone();
    let revision = if selected_preload.is_some() {
        crate::plugin_code_revision::current(&state.db, &plugin_id)?
    } else {
        None
    };
    let selected = tauri::async_runtime::spawn_blocking(move || {
        if let Some(relative) = selected_preload {
            super::node_selected_entry::SelectedPreload::capture(&entry_plugin, &relative, revision)
                .map(Some)
        } else {
            node_entry::select_entry(&entry_plugin).map(|_| None)
        }
    })
    .await
    .map_err(|_| "Plugin Node source inspection was interrupted")??;
    let name = registry::ensure_tool(&state.db, &plugin)?;
    let runtime = manager(&app);
    let existing = runtime
        .sessions
        .read()
        .values()
        .find(|s| {
            s.owner == owner
                && s.plugin_id == plugin_id
                && s.version == plugin.version
                && s.plugin_path == plugin.path
        })
        .cloned();
    if let Some(session) = existing {
        if session.document.as_ref().map(|d| d.id()) != document.as_ref().map(|d| d.id()) {
            return Err("Plugin document changed; reopen the plugin".into());
        }
        if validate_session(&state.db, &session).is_ok() {
            return Ok(json!({"sessionId":session.id,"reused":true}));
        }
        runtime.remove_strict(&session.id).await?;
    }
    let intent = runtime.create_selected_intent(
        owner.clone(),
        "atools-ui".into(),
        plugin_id.clone(),
        document,
        selected,
    )?;
    #[cfg(feature = "legacy-node-smoke")]
    if let Some(fixture) =
        app.try_state::<Arc<super::native_node_startup_fixture::NativeNodeStartupFixture>>()
    {
        if let Some(permit) = fixture.permit(&plugin_id, &owner) {
            if let Err(error) = runtime.attach_startup_diagnostic(&intent, permit) {
                runtime.intents.lock().remove(&intent);
                return Err(error);
            }
        }
    }
    // The audited execution obtains its own read permit. Drop this preparation
    // permit first: a queued writer must not deadlock a nested read acquisition.
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
    if result
        .structured_content
        .get("permission_required")
        .and_then(Value::as_bool)
        == Some(true)
    {
        if let Some(run) = result
            .structured_content
            .get("runId")
            .and_then(Value::as_str)
        {
            let bound = {
                let intents = runtime.intents.lock();
                if let Some(intent) = intents.get(&intent).filter(|intent| {
                    !intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
                        && intent.document.as_ref().is_none_or(|d| d.is_active())
                }) {
                    *intent.run_id.lock() = Some(run.into());
                    true
                } else {
                    false
                }
            };
            if !bound {
                super::lifecycle::cancel_pending(&app, &state.db, run);
            }
        }
    } else {
        runtime.intents.lock().remove(&intent);
    }
    Ok(result.structured_content)
}

/// A bounded source hint only; a positive result does not authorize a Node session.
#[tauri::command]
pub async fn plugin_legacy_node_usage(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
) -> Result<Value, String> {
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin not found")?;
    if !plugin.enabled {
        return Err("Plugin is disabled".into());
    }
    let revision = crate::plugin_code_revision::current(&state.db, &plugin_id)?;
    let hints = app.state::<std::sync::Arc<Hints>>().inner().clone();
    let report =
        tauri::async_runtime::spawn_blocking(move || hints.scan(&plugin, revision.as_deref()))
            .await
            .map_err(|_| "Plugin source inspection was interrupted")?;
    serde_json::to_value(report).map_err(|_| "Unable to encode plugin usage report".into())
}

#[tauri::command]
pub async fn get_legacy_node_session(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let runtime = manager(&app);
    let session = runtime.get(&session_id)?;
    if !session
        .owner
        .starts_with(&format!("window:{}:", window.label()))
    {
        return Err("Node session belongs to another window".into());
    }
    validate_session(&state.db, &session)?;
    let server = runtime.server.lock().await;
    let server = server.as_ref().ok_or("Node transport is not running")?;
    validate_session(&state.db, &session)?;
    Ok(json!({"endpoint":format!("{}/node/{}",server.origin,session.token)}))
}

#[tauri::command]
pub async fn close_legacy_node(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let owner = window_owner(window.label(), &instance_id)?;
    super::lifecycle::close_owner_strict(&app, &state.db, &owner, Some(&plugin_id)).await?;
    Ok(())
}

fn window_owner(label: &str, instance: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(instance).map_err(|_| "Invalid plugin instance")?;
    Ok(format!("window:{label}:{id}"))
}

pub fn install_manager(app: &AppHandle) {
    install_manager_with_node_runtime_selector(
        app,
        atools_plugin::sidecar::NodeRuntimeSelector::default(),
    );
}

pub fn install_manager_with_node_runtime_selector(
    app: &AppHandle,
    selector: atools_plugin::sidecar::NodeRuntimeSelector,
) {
    app.manage(Arc::new(Sessions::with_node_runtime_selector(selector)));
    app.manage(Arc::new(Hints::default()));
}
