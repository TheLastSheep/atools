pub(super) const DEFAULT_RETENTION_DAYS: u64 = 180;
pub(super) const DEFAULT_LEGACY_HISTORY_RETENTION_DAYS: u64 = 180;
pub(super) const DEFAULT_ATTACHMENT_BUDGET_BYTES: u64 = 1_073_741_824;
pub(super) const MAX_INLINE_TEXT_BYTES: usize = 10 * 1024 * 1024;
pub(super) const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;

use super::model::{
    NativePasteboardRepresentation, NativePasteboardSnapshot, PasteboardRuntimeSettings,
};
use atools_core::{PasteboardItemKind, PasteboardPruneResult};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
pub(super) fn ignored_snapshot_reason(
    snapshot: &NativePasteboardSnapshot,
    settings: &PasteboardRuntimeSettings,
) -> Option<String> {
    if snapshot.is_confidential {
        return Some("confidential".into());
    }
    if snapshot.is_transient {
        return Some("transient".into());
    }
    let bundle_id = snapshot
        .source_app
        .as_ref()
        .and_then(|source| source.bundle_id.as_deref())
        .map(normalize_bundle_id)
        .unwrap_or_default();
    if !bundle_id.is_empty() && settings.ignored_bundle_ids.contains(&bundle_id) {
        return Some("ignored_application".into());
    }
    if settings.sensitive_content_filter {
        let text = snapshot_text(snapshot);
        if looks_sensitive(&text) {
            return Some("sensitive_content".into());
        }
    }
    None
}

pub(super) fn default_ignored_bundle_ids() -> BTreeSet<String> {
    [
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.bitwarden.desktop",
        "com.lastpass.lastpassmacdesktop",
        "com.dashlane.dashlanephonefinal",
        "com.apple.keychainaccess",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(super) fn normalize_bundle_id(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(super) fn normalized_title(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn snapshot_text(snapshot: &NativePasteboardSnapshot) -> String {
    snapshot
        .representations
        .iter()
        .filter_map(|representation| match representation {
            NativePasteboardRepresentation::Text(value)
            | NativePasteboardRepresentation::Html(value)
            | NativePasteboardRepresentation::Url(value)
            | NativePasteboardRepresentation::Color(value) => Some(value.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn looks_sensitive(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper.contains("-----BEGIN PRIVATE KEY-----")
        || upper.contains("-----BEGIN RSA PRIVATE KEY-----")
        || upper.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
        || upper.starts_with("AKIA") && upper.len() >= 20
        || upper.starts_with("GHU_")
        || upper.starts_with("GHP_")
        || upper.starts_with("SK-LIVE-")
    {
        return true;
    }
    let digits = trimmed
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    (13..=19).contains(&digits.len()) && luhn_valid(&digits)
}

pub(super) fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    let parity = digits.len() % 2;
    for (index, byte) in digits.bytes().enumerate() {
        let mut digit = u32::from(byte - b'0');
        if index % 2 == parity {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
    }
    sum % 10 == 0
}

pub(super) fn snapshot_fingerprint(representations: &[NativePasteboardRepresentation]) -> String {
    let mut hasher = Sha256::new();
    for representation in representations {
        match representation {
            NativePasteboardRepresentation::Text(value) => {
                hash_tagged(&mut hasher, b"text", value.as_bytes())
            }
            NativePasteboardRepresentation::RichText { bytes, media_type } => {
                hash_tagged(&mut hasher, media_type.as_bytes(), bytes)
            }
            NativePasteboardRepresentation::Html(value) => {
                hash_tagged(&mut hasher, b"html", value.as_bytes())
            }
            NativePasteboardRepresentation::Url(value) => {
                hash_tagged(&mut hasher, b"url", value.as_bytes())
            }
            NativePasteboardRepresentation::Image { bytes, media_type } => {
                hash_tagged(&mut hasher, media_type.as_bytes(), bytes)
            }
            NativePasteboardRepresentation::Pdf(bytes) => hash_tagged(&mut hasher, b"pdf", bytes),
            NativePasteboardRepresentation::Color(value) => {
                hash_tagged(&mut hasher, b"color", value.as_bytes())
            }
            NativePasteboardRepresentation::Files(files) => {
                for file in files {
                    hash_tagged(&mut hasher, b"file", file.as_bytes());
                }
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

pub(super) fn hash_tagged(hasher: &mut Sha256, tag: &[u8], bytes: &[u8]) {
    hasher.update((tag.len() as u64).to_le_bytes());
    hasher.update(tag);
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

pub(super) fn prefer_kind(
    current: PasteboardItemKind,
    candidate: PasteboardItemKind,
) -> PasteboardItemKind {
    if kind_priority(candidate) > kind_priority(current) {
        candidate
    } else {
        current
    }
}

pub(super) fn kind_priority(kind: PasteboardItemKind) -> u8 {
    match kind {
        PasteboardItemKind::Text => 0,
        PasteboardItemKind::Url => 1,
        PasteboardItemKind::Color => 2,
        PasteboardItemKind::RichText => 3,
        PasteboardItemKind::Html => 4,
        PasteboardItemKind::Pdf => 5,
        PasteboardItemKind::Image => 6,
        PasteboardItemKind::Files => 7,
    }
}

pub(super) fn validate_inline_text(value: &str) -> Result<(), String> {
    if value.len() > MAX_INLINE_TEXT_BYTES {
        return Err(format!(
            "Clipboard text exceeds {} MiB",
            MAX_INLINE_TEXT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

pub(super) fn extension_for_media_type(media_type: &str) -> &str {
    match media_type.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "text/rtf" | "application/rtf" => "rtf",
        _ => "bin",
    }
}

pub(super) fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn safe_blob_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Unsafe clipboard blob path".into());
    }
    Ok(root.join(relative))
}

pub(super) async fn remove_pruned_blobs(root: &Path, result: &PasteboardPruneResult) {
    for relative_path in &result.deleted_blobs {
        match safe_blob_path(root, relative_path) {
            Ok(path) => {
                if let Err(error) = tokio::fs::remove_file(&path).await {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(path = %path.display(), %error, "Failed to remove pruned Paste blob");
                    }
                }
            }
            Err(error) => {
                tracing::warn!(relative_path, %error, "Ignored unsafe pruned Paste blob path")
            }
        }
    }
}

pub(super) async fn create_image_thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    let bytes = bytes.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let image = image::load_from_memory(&bytes).ok()?;
        let thumbnail = image.thumbnail(384, 256);
        let mut output = std::io::Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut output, image::ImageFormat::Png)
            .ok()?;
        Some(output.into_inner())
    })
    .await
    .ok()
    .flatten()
}
