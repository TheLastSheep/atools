//! Tauri window routing for a one-time, Rust-owned plugin action handoff.

use crate::state::AppState;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[tauri::command]
pub(crate) async fn open_plugin_detach_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    runtime: State<'_, crate::plugin_detach_runtime::PluginDetachRuntime>,
    feature_code: String,
    plugin_id: String,
    payload: Option<serde_json::Value>,
    entry_type: Option<String>,
    request_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the launcher can open a detached plugin window".into());
    }
    // If the detached window is already open and running this exact feature,
    // collaborate by bringing the existing detached window to the foreground.
    if runtime.is_occupied()
        && runtime.active_feature().as_ref() == Some(&(plugin_id.clone(), feature_code.clone()))
    {
        if let Some(detached) = app.get_webview_window(crate::window::PLUGIN_DETACH_LABEL) {
            let _ = detached.unminimize();
            detached.show().map_err(|error| error.to_string())?;
            detached.set_focus().map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    // Reserve before payload validation/serialization so a large older request
    // cannot become the latest intent after a smaller, newer request.
    let intent = runtime.reserve_open_intent(&request_id)?;
    if feature_code.is_empty()
        || feature_code.len() > 512
        || feature_code != feature_code.trim()
        || feature_code.chars().any(char::is_control)
        || plugin_id.is_empty()
        || plugin_id.len() > 512
        || plugin_id != plugin_id.trim()
        || plugin_id.chars().any(char::is_control)
    {
        return Err("PLUGIN_HANDOFF_INPUT_INVALID: invalid feature or plugin identity".into());
    }
    let payload = if entry_type.as_deref() == Some("files") {
        crate::plugin_detach_validation::check_handoff_budget(&payload)?;
        crate::plugin_detach_validation::normalize_files_payload(payload)?
    } else {
        payload
    };
    crate::plugin_detach_validation::check_handoff_budget(&payload)?;
    let snapshot = crate::feature_activation::activate_detached(
        &app,
        &state,
        &feature_code,
        payload,
        &plugin_id,
        entry_type.as_deref(),
    )
    .await?;
    runtime.ensure_latest_open_intent(&intent)?;
    let pending = crate::plugin_detach_runtime::PendingPluginAction::new(
        snapshot.action,
        snapshot.plugin_version,
        snapshot.code_revision,
        request_id,
    );
    let handoff_id = pending.id.clone();
    let lease = match crate::plugin_lifecycle::prepare_detached_window_reuse(&app).await {
        Ok(lease) => lease,
        Err(error) => {
            runtime.ensure_latest_open_intent(&intent)?;
            return Err(error);
        }
    };
    runtime.ensure_latest_open_intent(&intent)?;
    let _open_commit = runtime.begin_open_commit(&intent)?;
    runtime.store_for_generation(&app, pending, lease.generation, &intent)?;

    let open_result = (|| -> Result<(), String> {
        let detached = ensure_window(&app, &handoff_id).map_err(|error| error.to_string())?;
        detached.show().map_err(|error| error.to_string())?;
        detached.set_focus().map_err(|error| error.to_string())?;
        runtime.mark_ready(&handoff_id, lease.generation)?;
        Ok(())
    })();
    if let Err(error) = open_result {
        runtime.clear_handoff(&handoff_id);
        return Err(error);
    }
    drop(lease);
    Ok(())
}

#[tauri::command]
pub(crate) async fn claim_plugin_detach_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    runtime: State<'_, crate::plugin_detach_runtime::PluginDetachRuntime>,
    handoff_id: String,
) -> Result<crate::commands::FeatureAction, String> {
    crate::plugin_detach_validation::validate_claim_window(window.label())?;
    let (pending, _handoff_gate) = runtime.claim_for_validation(&handoff_id).await?;
    let _execution = crate::plugin_lifecycle::execution(&app, &pending.action.plugin_id).await;
    runtime.ensure_current_generation(&pending)?;
    let action = &pending.action;
    let plugin = state
        .db
        .get_plugin(&action.plugin_id)
        .map_err(|_| "FEATURE_OWNER_CHANGED: plugin is no longer installed".to_string())?;
    let feature = state
        .db
        .get_feature(&action.feature_code)
        .map_err(|_| "FEATURE_OWNER_CHANGED: plugin feature is no longer installed".to_string())?;
    crate::plugin_detach_validation::validate_current_snapshot(
        &pending,
        &plugin,
        &feature.plugin_id,
        crate::plugin_code_revision::current(&state.db, &action.plugin_id),
    )?;
    runtime.ensure_current_generation(&pending)?;
    Ok(pending.action)
}

#[tauri::command]
pub(crate) async fn cancel_plugin_detach_open(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, crate::plugin_detach_runtime::PluginDetachRuntime>,
    request_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the launcher can cancel a detached plugin open".into());
    }
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("PLUGIN_HANDOFF_INPUT_INVALID: invalid open request id".into());
    }
    let cancel = runtime.cancel_open_request(&request_id);
    if !cancel.latest_intent && !cancel.active_window {
        return Ok(());
    }
    if !cancel.active_window {
        return Ok(());
    }

    let gate = runtime.cleanup_gate().lock_owned().await;
    if !runtime.active_request_matches(&request_id) {
        return Ok(());
    }
    let detached = app.get_webview_window(crate::window::PLUGIN_DETACH_LABEL);
    if let Some(detached) = detached.as_ref() {
        detached.close().map_err(|error| error.to_string())?;
        runtime.begin_cancel_for_request(&request_id, true);
        crate::plugin_lifecycle::close_detached_window_resources_under_gate(&app).await;
        drop(gate);
        runtime.wait_for_destroyed_cleanup().await;
    } else if runtime.begin_cancel_for_request(&request_id, false) {
        crate::plugin_lifecycle::close_detached_window_resources_under_gate(&app).await;
    }
    Ok(())
}

pub(crate) fn initial_url(handoff_id: &str) -> String {
    let encoded = url::form_urlencoded::byte_serialize(handoff_id.as_bytes()).collect::<String>();
    // The real URL query forces a document navigation when reusing the webview;
    // the hash query is consumed by the existing hash-routed plugin shell.
    format!("/?__atools_handoff={encoded}#/plugin-detach?handoff={encoded}")
}

pub(crate) fn ensure_window(app: &AppHandle, handoff_id: &str) -> tauri::Result<WebviewWindow> {
    let route = initial_url(handoff_id);
    if let Some(window) = app.get_webview_window(crate::window::PLUGIN_DETACH_LABEL) {
        let route_url = window
            .url()?
            .join(&route)
            .map_err(tauri::Error::InvalidUrl)?;
        window.navigate(route_url)?;
        return Ok(window);
    }

    let builder = WebviewWindowBuilder::new(
        app,
        crate::window::PLUGIN_DETACH_LABEL,
        WebviewUrl::App(route.into()),
    )
    .title("ATools 插件分离窗口")
    .inner_size(
        crate::window::PLUGIN_DETACH_WIDTH as f64,
        crate::window::PLUGIN_DETACH_HEIGHT as f64,
    )
    .resizable(true)
    .visible(false);
    crate::plugin_browser_window_native::attach_parent(
        builder,
        app,
        crate::window::PLUGIN_DETACH_LABEL,
    )
    .build()
}

#[cfg(test)]
mod tests {
    use super::initial_url;

    #[test]
    fn route_contains_only_the_encoded_handoff_identifier() {
        assert_eq!(
            initial_url("id with&separator"),
            "/?__atools_handoff=id+with%26separator#/plugin-detach?handoff=id+with%26separator"
        );
    }
}
