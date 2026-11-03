use std::collections::HashSet;
use std::path::Path;

use crate::error::{AToolsError, Result};
use serde_json::Value;

pub(super) const PLUGIN_CLIPBOARD_HISTORY_MEDIA_BYTES_MAX: usize = 256 * 1024;
pub(super) const PLUGIN_CLIPBOARD_HISTORY_FILE_COUNT_MAX: usize = 20;
pub(super) const PLUGIN_CLIPBOARD_HISTORY_PATH_BYTES_MAX: usize = 8 * 1024;
pub(super) const PLUGIN_CLIPBOARD_HISTORY_PATHS_BYTES_MAX: usize = 64 * 1024;
pub(super) const PLUGIN_CLIPBOARD_HISTORY_PREVIEW_CHARS_MAX: usize = 256;

pub(super) struct ValidatedMediaProjection {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) preview: String,
    pub(super) payload_json: String,
    pub(super) search_text: String,
}

pub(super) enum PluginClipboardHistoryIdKind {
    Text,
    Image,
    File,
}

pub(super) fn validate_media_projection(
    item_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<ValidatedMediaProjection> {
    if item_id.is_empty()
        || item_id.len() > PLUGIN_CLIPBOARD_HISTORY_PATH_BYTES_MAX
        || item_id.contains('\0')
    {
        return Err(AToolsError::Config(
            "Invalid clipboard media item id".into(),
        ));
    }

    let object = payload
        .as_object()
        .ok_or_else(|| AToolsError::Config("Clipboard media payload must be an object".into()))?;
    let preview = object
        .get("preview")
        .and_then(Value::as_str)
        .ok_or_else(|| AToolsError::Config("Clipboard media preview is required".into()))?;
    if preview
        .chars()
        .take(PLUGIN_CLIPBOARD_HISTORY_PREVIEW_CHARS_MAX + 1)
        .count()
        > PLUGIN_CLIPBOARD_HISTORY_PREVIEW_CHARS_MAX
    {
        return Err(AToolsError::Config(
            "Clipboard media preview exceeds 256 characters".into(),
        ));
    }

    let mut search_terms = vec![preview.to_string()];
    match kind {
        "image" => validate_image_payload(object, &mut search_terms)?,
        "file" => validate_file_payload(object, &mut search_terms)?,
        _ => return Err(AToolsError::Config("Invalid clipboard media kind".into())),
    }

    let payload_json = serde_json::to_string(payload)?;
    if payload_json.len() > PLUGIN_CLIPBOARD_HISTORY_MEDIA_BYTES_MAX {
        return Err(AToolsError::Config(
            "Clipboard media payload exceeds 256 KiB".into(),
        ));
    }
    let id = format!("clip-{kind}-{:016x}", stable_item_hash(item_id));
    Ok(ValidatedMediaProjection {
        id,
        kind: kind.to_string(),
        preview: preview.to_string(),
        payload_json,
        search_text: search_terms.join("\n"),
    })
}

fn validate_image_payload(
    object: &serde_json::Map<String, Value>,
    search_terms: &mut Vec<String>,
) -> Result<()> {
    if !keys_are(object, &["imagePath", "byteSize", "preview"])
        || !(object.len() == 2 || object.len() == 3)
    {
        return Err(AToolsError::Config(
            "Invalid clipboard image payload fields".into(),
        ));
    }
    let path = object
        .get("imagePath")
        .and_then(Value::as_str)
        .ok_or_else(|| AToolsError::Config("Clipboard image path is required".into()))?;
    validate_absolute_path(path, PLUGIN_CLIPBOARD_HISTORY_PATH_BYTES_MAX)?;
    if object.contains_key("byteSize") {
        let byte_size = object.get("byteSize").and_then(Value::as_u64);
        if !byte_size.is_some_and(|size| size <= 9_007_199_254_740_991) {
            return Err(AToolsError::Config(
                "Clipboard image byteSize must be a safe non-negative integer".into(),
            ));
        }
    }
    search_terms.push(path.to_string());
    Ok(())
}

fn validate_file_payload(
    object: &serde_json::Map<String, Value>,
    search_terms: &mut Vec<String>,
) -> Result<()> {
    if !keys_are(object, &["files", "preview"]) || object.len() != 2 {
        return Err(AToolsError::Config(
            "Invalid clipboard file payload fields".into(),
        ));
    }
    let files = object
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| AToolsError::Config("Clipboard files must be an array".into()))?;
    if files.is_empty() || files.len() > PLUGIN_CLIPBOARD_HISTORY_FILE_COUNT_MAX {
        return Err(AToolsError::Config(
            "Clipboard file count must be between 1 and 20".into(),
        ));
    }

    let mut total_path_bytes = 0usize;
    let mut seen_paths = HashSet::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        let file = file.as_object().ok_or_else(|| {
            AToolsError::Config(format!("Clipboard files[{index}] must be an object"))
        })?;
        if !keys_are(file, &["path", "name"]) || !(file.len() == 1 || file.len() == 2) {
            return Err(AToolsError::Config(format!(
                "Invalid clipboard files[{index}] fields"
            )));
        }
        let path = file.get("path").and_then(Value::as_str).ok_or_else(|| {
            AToolsError::Config(format!("Clipboard files[{index}] path is required"))
        })?;
        validate_absolute_path(path, PLUGIN_CLIPBOARD_HISTORY_PATH_BYTES_MAX)?;
        total_path_bytes = total_path_bytes
            .checked_add(path.len())
            .filter(|total| *total <= PLUGIN_CLIPBOARD_HISTORY_PATHS_BYTES_MAX)
            .ok_or_else(|| {
                AToolsError::Config("Clipboard file paths exceed the 64 KiB limit".into())
            })?;
        if !seen_paths.insert(path) {
            return Err(AToolsError::Config(format!(
                "Clipboard files[{index}] duplicates an earlier path"
            )));
        }
        search_terms.push(path.to_string());
        if let Some(name) = file.get("name") {
            let name = name.as_str().ok_or_else(|| {
                AToolsError::Config(format!("Clipboard files[{index}] name must be a string"))
            })?;
            if name.len() > PLUGIN_CLIPBOARD_HISTORY_PATH_BYTES_MAX {
                return Err(AToolsError::Config(format!(
                    "Clipboard files[{index}] name exceeds the 8 KiB limit"
                )));
            }
            search_terms.push(name.to_string());
        }
    }
    Ok(())
}

fn validate_absolute_path(path: &str, max_bytes: usize) -> Result<()> {
    if path.is_empty()
        || path.len() > max_bytes
        || path.contains('\0')
        || !Path::new(path).is_absolute()
    {
        return Err(AToolsError::Config(
            "Clipboard media path must be an absolute path within its byte limit".into(),
        ));
    }
    Ok(())
}

fn keys_are(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

pub(super) fn parse_plugin_clipboard_history_id(id: &str) -> Result<PluginClipboardHistoryIdKind> {
    let (kind, suffix) = if let Some(suffix) = id.strip_prefix("clip-image-") {
        (PluginClipboardHistoryIdKind::Image, suffix)
    } else if let Some(suffix) = id.strip_prefix("clip-file-") {
        (PluginClipboardHistoryIdKind::File, suffix)
    } else if let Some(suffix) = id.strip_prefix("clip-") {
        (PluginClipboardHistoryIdKind::Text, suffix)
    } else {
        return Err(AToolsError::Config("Invalid clipboard history id".into()));
    };
    if suffix.len() != 16
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AToolsError::Config("Invalid clipboard history id".into()));
    }
    Ok(kind)
}

pub(super) fn stable_item_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub(super) fn escape_like_pattern(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
