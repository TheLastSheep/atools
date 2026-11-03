//! Explicit launcher media commands share catalogue, owner gate and TaskRun activation.
use crate::{commands::FeatureAction, content_search::TextContentResult, state::AppState};
use atools_core::{matcher::MediaFile, Database};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[path = "launcher_media_files.rs"]
mod files;
#[path = "launcher_media_image.rs"]
pub(crate) mod image;

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ClipboardMedia {
    Files { files: Vec<MediaFile> },
    Img { data_url: String },
}
#[derive(Serialize)]
pub(crate) struct FileContentResult {
    files: Vec<MediaFile>,
    results: Vec<TextContentResult>,
}

#[tauri::command]
pub(crate) async fn read_launcher_clipboard_media(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    files_only: Option<bool>,
) -> Result<Option<ClipboardMedia>, String> {
    crate::launcher_media_clipboard::read_for_launcher(&app, &state.db, files_only.unwrap_or(false))
        .await
}
#[tauri::command]
pub(crate) async fn search_file_content_features(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<FileContentResult, String> {
    let db = state.db.clone();
    let root = app
        .path()
        .resolve("plugins/builtin", tauri::path::BaseDirectory::Resource)
        .ok();
    crate::launcher_media_work::blocking(move || {
        let files = files::validate_paths(&paths)?;
        let results = crate::launcher_catalog::search_file_content(&db, &files, root.as_deref())?;
        Ok(FileContentResult { files, results })
    })
    .await
}
#[tauri::command]
pub(crate) async fn search_image_content_features(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TextContentResult>, String> {
    let db = state.db.clone();
    let root = app
        .path()
        .resolve("plugins/builtin", tauri::path::BaseDirectory::Resource)
        .ok();
    crate::launcher_media_work::blocking(move || {
        crate::launcher_catalog::search_image_content(&db, root.as_deref())
    })
    .await
}
#[tauri::command]
pub(crate) async fn activate_file_content_feature(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    code: String,
    paths: Vec<String>,
    expected_plugin_id: String,
) -> Result<FeatureAction, String> {
    crate::feature_activation::activate_media(
        &app,
        &state,
        &code,
        serde_json::json!(paths),
        &expected_plugin_id,
        "files",
    )
    .await
}
#[tauri::command]
pub(crate) async fn activate_image_content_feature(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    code: String,
    data_url: String,
    expected_plugin_id: String,
) -> Result<FeatureAction, String> {
    crate::feature_activation::activate_media(
        &app,
        &state,
        &code,
        Value::String(data_url),
        &expected_plugin_id,
        "img",
    )
    .await
}

/// Runs after the plugin execution gate is acquired, against the current catalogue.
/// Returned live payload is original data; durable activation records only its summary.
pub(crate) fn validate_payload(
    db: &Database,
    code: &str,
    payload: Value,
    owner: &str,
    kind: &str,
) -> Result<(Value, &'static str), String> {
    let (payload, matches, entry_type) = match kind {
        "files" => {
            let paths: Vec<String> = serde_json::from_value(payload)
                .map_err(|_| "FILE_INPUT_INVALID: expected selected absolute paths")?;
            let files = files::validate_paths(&paths)?;
            let matches = db
                .feature_catalog_snapshot()
                .map_err(|e| e.to_string())?
                .search_file_content(&files)
                .map_err(|e| e.to_string())?;
            (
                serde_json::to_value(files)
                    .map_err(|_| "FILE_INPUT_INVALID: metadata encoding failed")?,
                matches,
                "files",
            )
        }
        "img" => {
            let data = payload
                .as_str()
                .ok_or("IMAGE_INPUT_INVALID: expected an image data URL")?;
            image::validate_data_url(data)?;
            let matches = db
                .feature_catalog_snapshot()
                .map_err(|e| e.to_string())?
                .search_image_content();
            (payload, matches, "img")
        }
        _ => return Err("MEDIA_INPUT_INVALID: unknown content kind".into()),
    };
    if !matches
        .iter()
        .any(|matched| matched.plugin_id == owner && matched.feature_code == code)
    {
        return Err(
            "MEDIA_CONTENT_NOT_MATCHED: refresh the content candidates and try again".into(),
        );
    }
    Ok((payload, entry_type))
}

pub(crate) fn clipboard_path(path: &std::path::Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "FILE_INPUT_INVALID: clipboard file path is not UTF8".into())
}

pub(crate) fn clipboard_files(paths: &[String]) -> Result<ClipboardMedia, String> {
    Ok(ClipboardMedia::Files {
        files: files::validate_paths(paths)?,
    })
}

#[cfg(test)]
#[path = "launcher_media_tests.rs"]
mod tests;
