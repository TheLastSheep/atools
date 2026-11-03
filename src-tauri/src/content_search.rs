//! Fixed original text takes the same catalogue and activation pipeline as other features.
use crate::{
    commands::{FeatureAction, SearchResult},
    state::AppState,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub(crate) struct TextContentResult {
    #[serde(flatten)]
    pub result: SearchResult,
    pub content_search_terms: Vec<String>,
}

#[tauri::command]
pub(crate) async fn search_text_content_features(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<Vec<TextContentResult>, String> {
    let db = state.db.clone();
    let builtin_root = app
        .path()
        .resolve("plugins/builtin", tauri::path::BaseDirectory::Resource)
        .ok();
    tauri::async_runtime::spawn_blocking(move || {
        crate::launcher_catalog::search_text_content(&db, &content, builtin_root.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn activate_text_content_feature(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    code: String,
    content: String,
    expected_plugin_id: String,
) -> Result<FeatureAction, String> {
    crate::feature_activation::activate_content(&app, &state, &code, content, &expected_plugin_id)
        .await
}

pub(crate) fn entry_type(
    db: &atools_core::Database,
    code: &str,
    content: &str,
    owner: &str,
) -> Result<&'static str, String> {
    db.feature_catalog_snapshot()
        .map_err(|error| error.to_string())?
        .search_text_content(content)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|matched| matched.plugin_id == owner && matched.feature_code == code)
        .map(|matched| matched.match_type)
        .ok_or_else(|| {
            "TEXT_CONTENT_NOT_MATCHED: refresh the content candidates and try again".into()
        })
}

#[cfg(test)]
#[path = "content_search_tests.rs"]
mod tests;
