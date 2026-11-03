//! One bounded package inspection supplies both preview and batch preflight metadata.
use super::{archive_readiness, directory, zip, ZToolsImportCandidate};
use atools_core::PluginManifest;
use std::{fs, path::Path};

pub(super) struct SourceInspection {
    pub candidate: ZToolsImportCandidate,
    pub manifest: PluginManifest,
    pub raw_manifest: serde_json::Value,
}

impl SourceInspection {
    pub fn new(
        mut candidate: ZToolsImportCandidate,
        manifest: PluginManifest,
        raw_manifest: serde_json::Value,
    ) -> Self {
        match stable_installation_id(&manifest.name) {
            Ok(id) => {
                candidate.installation_key = Some(installation_key(&id));
                candidate.installation_id = Some(id);
            }
            Err(error) => candidate.errors.push(error),
        }
        Self {
            candidate,
            manifest,
            raw_manifest,
        }
    }
}

/// Preserve sanitize_id's deterministic ASCII/case rules, refusing its random fallback.
pub(super) fn stable_installation_id(name: &str) -> Result<String, String> {
    let mut id = String::new();
    let mut separator = false;
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() {
            if separator && !id.is_empty() {
                id.push('-');
            }
            id.push(byte as char);
            separator = false;
        } else {
            separator = true;
        }
    }
    if id.is_empty() || id.len() > 256 {
        return Err("插件名称无法生成稳定的安装 ID：名称需含 ASCII 字母或数字，规范化后不超过 256 字符；请修正 manifest.name".into());
    }
    Ok(id)
}

pub(super) fn installation_key(id: &str) -> String {
    // macOS and Windows commonly use case-insensitive volumes. Conservatively
    // reject aliases within a batch without probing or changing installed IDs.
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        id.to_ascii_lowercase()
    } else {
        id.to_owned()
    }
}

pub(super) fn inspect(source: &Path) -> Result<SourceInspection, String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.is_symlink() {
        return Err("不接受符号链接插件来源，请直接选择实际目录或安装包".into());
    }
    if metadata.is_dir() {
        return directory::inspect(source);
    }
    if !metadata.is_file() || !super::is_supported_archive(source) {
        return Err(format!(
            "Unsupported ZTools plugin source: {}",
            source.display()
        ));
    }
    if super::archive_source_type(source) == "zip" {
        zip::inspect(source)
    } else {
        archive_readiness::asar_inspect(source)
    }
}
