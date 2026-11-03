use super::{
    identity::{
        trusted_host_window, validate_frame_id, validate_generation, validate_nonce,
        validate_source_binding_id,
    },
    registry, registry_or_create, retire_binding, SourceBinding,
};
use crate::{
    plugin_asset_protocol::{self, Owner},
    state::AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[tauri::command]
pub(crate) fn bind_plugin_window_source(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    plugin_id: String,
    instance_id: String,
    resource_session_id: String,
    frame_id: String,
    generation: u64,
    document_nonce: String,
) -> Result<Value, String> {
    let window_label = window.label().to_owned();
    trusted_host_window(&window_label)?;
    validate_frame_id(&frame_id)?;
    validate_generation(generation)?;
    validate_nonce(&document_nonce)?;
    let owner = Owner::new(&window_label, &plugin_id, &instance_id)?;
    crate::plugin_browser_window_runtime::validate_source_frame(&app, &owner, &frame_id)?;
    let authorization = plugin_asset_protocol::validate_source_resources(
        &app,
        &state.db,
        &owner,
        &resource_session_id,
    )?;

    let candidate = SourceBinding::new(
        owner,
        resource_session_id,
        authorization,
        frame_id,
        generation,
        document_nonce,
    );
    let (binding, retired) = registry_or_create(&app).lock().bind(candidate)?;
    super::finish_revocations(&app, retired);
    binding.validate(&app, &state.db)?;
    Ok(json!({"sourceBindingId": binding.id()}))
}

#[tauri::command]
pub(crate) fn close_plugin_window_source(
    app: AppHandle,
    window: WebviewWindow,
    source_binding_id: String,
) -> Result<(), String> {
    let window_label = window.label().to_owned();
    trusted_host_window(&window_label)?;
    validate_source_binding_id(&source_binding_id)?;
    if let Some(registry) = registry(&app) {
        let binding = registry.lock().by_id(&source_binding_id);
        if let Some(binding) = binding {
            if binding.owner().window != window_label {
                return Err("Plugin window source owner mismatch".into());
            }
            retire_binding(&app, &source_binding_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn prepare_plugin_window_document(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    source_binding_id: String,
    native_label: String,
    document_generation: u64,
    relative_path: String,
    html: String,
) -> Result<Value, String> {
    let window_label = window.label().to_owned();
    trusted_host_window(&window_label)?;
    validate_source_binding_id(&source_binding_id)?;
    let binding = super::resolve(&app, &window_label, &source_binding_id)?;
    binding.validate(&app, &state.db)?;
    let registry = registry_or_create(&app);
    let document_id = super::documents::prepare(
        &mut registry.lock(),
        &binding,
        &native_label,
        document_generation,
        &relative_path,
        html,
    )?;
    binding.validate(&app, &state.db)?;
    Ok(json!({"documentId": document_id}))
}
