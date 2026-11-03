use super::{parent_origin, registry, require_enabled, PreparedPage};
use crate::{
    plugin_asset_protocol::{authorization, Owner},
    state::AppState,
};
use tauri::{AppHandle, WebviewWindow};

#[tauri::command]
pub(crate) async fn prepare_plugin_page(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
) -> Result<PreparedPage, String> {
    require_enabled(&app)?;
    parent_origin(&app, window.label())?;
    #[cfg(feature = "legacy-node-smoke")]
    super::navigation_probe::ensure(&app, &window).await?;
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let registry = registry(&app);
    let preparation = registry.begin(owner)?;
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let db = state.db.clone();
    let worker_app = app.clone();
    let (prepared, retired) = tauri::async_runtime::spawn_blocking(move || {
        let _execution = execution;
        require_enabled(&worker_app)?;
        parent_origin(&worker_app, &preparation.owner.window)?;
        registry.commit(preparation, authorization(&db, &plugin_id)?)
    })
    .await
    .map_err(|_| "Plugin page preparation interrupted")??;
    for id in retired {
        close_document(&app, &id).await;
    }
    Ok(prepared)
}

#[tauri::command]
pub(crate) async fn claim_plugin_page(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
    page_document_id: String,
) -> Result<(), String> {
    require_enabled(&app)?;
    parent_origin(&app, window.label())?;
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let registry = registry(&app);
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let db = state.db.clone();
    let worker_app = app.clone();
    let worker_owner = owner.clone();
    let worker_id = page_document_id.clone();
    let worker_registry = registry.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _execution = execution;
        parent_origin(&worker_app, &worker_owner.window)?;
        worker_registry.claim(&worker_owner, &worker_id, &authorization(&db, &plugin_id)?)
    })
    .await
    .map_err(|_| "Plugin page claim interrupted".to_string())
    .and_then(|result| result);
    if result.is_err() {
        // This also revokes on disabled/unavailable code or a native worker
        // failure. An incorrect owner cannot revoke the real owner's document.
        for id in registry.close_owner(&owner, Some(&page_document_id)) {
            close_document(&app, &id).await;
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn close_plugin_page(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
) -> Result<(), String> {
    require_enabled(&app)?;
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let removed = registry(&app).close_owner(&owner, page_document_id.as_deref());
    for id in removed {
        close_document(&app, &id).await;
    }
    // Repeated/foreign IDs are no-ops. Session preparation also checks its shared
    // binding immediately before commit, so a late result cannot revive it.
    Ok(())
}

pub(super) async fn close_document(app: &AppHandle, id: &str) {
    // A visible native panel must acknowledge cancellation before unrelated
    // sidecar shutdown can wait on its own transition or process deadline.
    crate::plugin_dialog_runtime::close_document(app, id).await;
    crate::legacy_runtime::close_document(app, id).await;
    crate::host_runtime::close_document(app, id).await;
    crate::plugin_display_runtime::close_document(app, id).await;
    crate::plugin_data_runtime::close_document(app, id).await;
    crate::plugin_secret_storage_runtime::close_document(app, id).await;
    crate::plugin_file_drop::close_document(app, id).await;
    crate::plugin_file_drag::close_document(app, id).await;
    crate::plugin_ai_runtime::close_document(app, id).await;
}
