use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::package_resolution::read_package_asset_bytes;

pub(super) const MAX_METADATA_BYTES: usize = 1024 * 1024;
pub(super) const MAX_SOURCE_ENTRIES: usize = 4096;
pub(super) const MAX_SOURCE_DEPTH: usize = 16;

pub(super) fn read_json(root: &Path, relative: &Path) -> Result<Option<Value>, ()> {
    let Some(bytes) =
        read_package_asset_bytes(root, relative, MAX_METADATA_BYTES).map_err(|_| ())?
    else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ())
}

pub(super) fn canonical_directory(root: &Path, relative: &Path) -> Result<Option<PathBuf>, ()> {
    validate_relative(relative)?;
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        let Component::Normal(name) = part else {
            return Err(());
        };
        cursor.push(name);
        let metadata = match fs::symlink_metadata(&cursor) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(());
        }
    }
    let canonical = cursor.canonicalize().map_err(|_| ())?;
    if !canonical.starts_with(root) {
        return Err(());
    }
    Ok(Some(canonical))
}

pub(super) fn canonical_regular_file(root: &Path, relative: &Path) -> Result<Option<PathBuf>, ()> {
    validate_relative(relative)?;
    let mut cursor = root.to_path_buf();
    let parts: Vec<_> = relative.components().collect();
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(());
        };
        cursor.push(name);
        let metadata = match fs::symlink_metadata(&cursor) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        if metadata.file_type().is_symlink() {
            return Err(());
        }
        let final_component = index + 1 == parts.len();
        if final_component != metadata.is_file() {
            return Err(());
        }
        if !final_component && !metadata.is_dir() {
            return Err(());
        }
    }
    let canonical = cursor.canonicalize().map_err(|_| ())?;
    if !canonical.starts_with(root) {
        return Err(());
    }
    Ok(Some(canonical))
}

fn validate_relative(path: &Path) -> Result<(), ()> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(());
    }
    Ok(())
}
