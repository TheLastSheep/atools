use std::sync::Arc;

use atools_api_shim::handler::{ApiHandler, ProviderDescriptor};
use serde_json::Value;

#[tauri::command]
pub fn list_plugin_providers(
    handler: tauri::State<'_, Arc<ApiHandler>>,
    provider_type: Option<String>,
) -> Result<Vec<ProviderDescriptor>, String> {
    handler
        .list_providers(provider_type.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_default_plugin_provider(
    handler: tauri::State<'_, Arc<ApiHandler>>,
    provider_type: String,
) -> Result<Option<ProviderDescriptor>, String> {
    handler
        .default_provider(&provider_type)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_default_plugin_provider(
    handler: tauri::State<'_, Arc<ApiHandler>>,
    provider_type: String,
    provider_id: String,
) -> Result<ProviderDescriptor, String> {
    handler
        .set_default_provider(&provider_type, &provider_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn invoke_plugin_provider(
    handler: tauri::State<'_, Arc<ApiHandler>>,
    provider_type: String,
    input: Value,
    provider_id: Option<String>,
) -> Result<Value, String> {
    handler
        .invoke_provider(&provider_type, input, provider_id.as_deref())
        .await
        .map_err(|error| error.to_string())
}
