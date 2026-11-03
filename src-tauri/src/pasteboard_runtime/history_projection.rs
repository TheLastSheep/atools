use super::support::safe_blob_path;
use atools_core::{Database, PasteboardItem, PasteboardItemKind};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const MAX_MEDIA_PATH_BYTES: usize = 8 * 1024;
const MAX_FILES: usize = 20;
const MAX_FILE_PATHS_BYTES: usize = 64 * 1024;
const MAX_PREVIEW_SCALARS: usize = 256;

pub(super) fn record_plugin_media_projection(
    db: &Database,
    item: &PasteboardItem,
    blob_root: &Path,
    retention_cutoff: &str,
) -> bool {
    let Some((kind, payload)) = projection_payload(item, blob_root) else {
        return false;
    };
    match db.record_clipboard_media_projection(
        &item.id,
        kind,
        &payload,
        &item.copied_at,
        retention_cutoff,
    ) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(item_id = %item.id, kind, %error, "Skipped plugin clipboard media projection");
            false
        }
    }
}

fn projection_payload(item: &PasteboardItem, blob_root: &Path) -> Option<(&'static str, Value)> {
    match item.kind {
        PasteboardItemKind::Image => {
            let relative_path = item.payload.get("imageBlobPath")?.as_str()?;
            let image_path = absolute_blob_path(blob_root, relative_path)?;
            if !valid_absolute_path(&image_path) {
                return None;
            }
            let preview = preview(item.payload.get("previewText").and_then(Value::as_str));
            Some((
                "image",
                json!({ "imagePath": image_path, "preview": preview }),
            ))
        }
        PasteboardItemKind::Files => {
            let source_paths = item.payload.get("files")?.as_array()?;
            if source_paths.is_empty() || source_paths.len() > MAX_FILES {
                return None;
            }

            let mut seen_paths = BTreeSet::new();
            let mut total_path_bytes = 0usize;
            let mut files = Vec::with_capacity(source_paths.len());
            let mut preview_names = Vec::with_capacity(source_paths.len());
            for source_path in source_paths {
                let path = source_path.as_str()?;
                if !valid_absolute_path(path) || !seen_paths.insert(path) {
                    return None;
                }
                total_path_bytes = total_path_bytes.checked_add(path.len())?;
                if total_path_bytes > MAX_FILE_PATHS_BYTES {
                    return None;
                }

                let mut file = serde_json::Map::new();
                file.insert("path".into(), Value::String(path.to_string()));
                if let Some(name) = file_name(path) {
                    preview_names.push(name.clone());
                    file.insert("name".into(), Value::String(name));
                }
                files.push(Value::Object(file));
            }

            let preview = preview(Some(&preview_names.join("\n")));
            Some(("file", json!({ "files": files, "preview": preview })))
        }
        _ => None,
    }
}

fn absolute_blob_path(blob_root: &Path, relative_path: &str) -> Option<String> {
    let path = safe_blob_path(blob_root, relative_path).ok()?;
    let absolute_path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    absolute_path.to_str().map(str::to_owned)
}

fn valid_absolute_path(path: &str) -> bool {
    !path.is_empty()
        && !path.as_bytes().contains(&0)
        && path.len() <= MAX_MEDIA_PATH_BYTES
        && Path::new(path).is_absolute()
}

fn file_name(path: &str) -> Option<String> {
    PathBuf::from(path)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn preview(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .take(MAX_PREVIEW_SCALARS)
        .collect()
}
