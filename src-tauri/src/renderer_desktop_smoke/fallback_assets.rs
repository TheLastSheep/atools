//! Strict reader for the separately staged Svelte settings QA bundle.
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    path::{Component, Path},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MANIFEST_NAME: &str = "build-provenance.json";
const OWNER: &str = "@atools/fallback-settings-native-fixture";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_SOURCE_COUNT: usize = 512;
const MAX_SOURCE_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SOURCE_PATH_BYTES: usize = 4096;
const MAX_RESOURCE_PATH_BYTES: usize = 512;
const MAX_RESOURCE_DEPTH: usize = 8;
const ASSET_PREFIX: &str = "/fallback-settings/";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    owner: String,
    sources: Vec<Entry>,
    source_sha256: String,
    resources: Vec<Entry>,
    resource_sha256: String,
    resource_bytes: u64,
    resource_count: u64,
}

// Field order is part of the Node/Rust digest contract: path, sha256, bytes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    sha256: String,
    bytes: u64,
}

pub(super) struct Bundle {
    pub(super) files: BTreeMap<String, Box<[u8]>>,
    pub(super) javascript_count: usize,
    pub(super) runtime_bytes: u64,
    pub(super) summary: Value,
}

#[derive(Default)]
struct ScanBudget {
    entries: usize,
    directories: usize,
}

pub(super) fn load(root: &Path) -> Result<Bundle, String> {
    let root = validate_root(root)?;
    let root_metadata = fs::symlink_metadata(&root)
        .map_err(|_| "fallback settings directory cannot be inspected".to_string())?;
    let root_identity = file_identity(&root_metadata);
    let manifest_path = root.join(MANIFEST_NAME);
    let manifest_bytes = read_regular_file(&manifest_path, MAX_MANIFEST_BYTES)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "fallback settings manifest is invalid".to_string())?;
    validate_manifest(&manifest)?;

    let expected = manifest
        .resources
        .iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut scan_budget = ScanBudget::default();
    let mut files = BTreeMap::new();
    let mut javascript_count = 0;
    let mut runtime_bytes = 0_u64;
    collect_resources(
        &root,
        &root,
        0,
        &expected,
        &mut scan_budget,
        &mut files,
        &mut javascript_count,
        &mut runtime_bytes,
    )?;
    if files.len() != manifest.resources.len()
        || !files.contains_key("/fallback-settings/index.html")
    {
        return Err("fallback settings resources do not match the manifest".into());
    }
    if javascript_count == 0 {
        return Err("fallback settings bundle must contain JavaScript".into());
    }
    if read_regular_file(&manifest_path, MAX_MANIFEST_BYTES)? != manifest_bytes {
        return Err("fallback settings manifest changed while loading".into());
    }
    let after_root = fs::symlink_metadata(&root)
        .map_err(|_| "fallback settings directory changed while loading".to_string())?;
    if file_identity(&after_root) != root_identity || after_root.file_type().is_symlink() {
        return Err("fallback settings directory changed while loading".into());
    }

    let summary = serde_json::json!({
        "manifestSha256": sha256_hex(&manifest_bytes),
        "sourceSha256": manifest.source_sha256,
        "resourceSha256": manifest.resource_sha256,
        "resourceCount": manifest.resource_count,
        "resourceBytes": manifest.resource_bytes,
    });
    Ok(Bundle {
        files,
        javascript_count,
        runtime_bytes,
        summary,
    })
}

fn validate_root(path: &Path) -> Result<std::path::PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("fallback settings path must be canonical and absolute".into());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "fallback settings directory cannot be inspected".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("fallback settings path must be a real directory".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "fallback settings directory cannot be resolved".to_string())?;
    if canonical.as_os_str() != path.as_os_str() {
        return Err("fallback settings path must already be canonical".into());
    }
    Ok(canonical)
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.schema_version != 1 || manifest.owner != OWNER {
        return Err("fallback settings manifest owner or version is invalid".into());
    }
    if manifest.sources.is_empty() || manifest.sources.len() > MAX_SOURCE_COUNT {
        return Err("fallback settings source metadata count is invalid".into());
    }
    validate_entries(&manifest.sources, false)?;
    validate_entries(&manifest.resources, true)?;
    if !valid_sha256(&manifest.source_sha256)
        || !valid_sha256(&manifest.resource_sha256)
        || digest_entries(&manifest.sources)? != manifest.source_sha256
        || digest_entries(&manifest.resources)? != manifest.resource_sha256
    {
        return Err("fallback settings manifest digest is invalid".into());
    }
    let resource_bytes = sum_entry_bytes(&manifest.resources, super::MAX_RUNTIME_FILE_BYTES)?;
    if manifest.resources.is_empty()
        || manifest.resources.len() > super::MAX_RUNTIME_FILES
        || manifest.resource_count != manifest.resources.len() as u64
        || manifest.resource_bytes != resource_bytes
        || resource_bytes > super::MAX_RUNTIME_TOTAL_BYTES
    {
        return Err("fallback settings resource count or byte total is invalid".into());
    }
    if !manifest
        .resources
        .iter()
        .any(|entry| entry.path == "index.html")
        || !manifest
            .resources
            .iter()
            .any(|entry| entry.path.ends_with(".js") || entry.path.ends_with(".mjs"))
    {
        return Err("fallback settings manifest must include index.html and JavaScript".into());
    }
    Ok(())
}

fn validate_entries(entries: &[Entry], resources: bool) -> Result<(), String> {
    let mut total = 0_u64;
    let mut previous: Option<&str> = None;
    for entry in entries {
        if !valid_sha256(&entry.sha256) {
            return Err("fallback settings entry digest is invalid".into());
        }
        let path_limit = if resources {
            MAX_RESOURCE_PATH_BYTES
        } else {
            MAX_SOURCE_PATH_BYTES
        };
        if !valid_relative_path(&entry.path, path_limit, MAX_RESOURCE_DEPTH)
            || (resources && entry.path != "index.html" && !entry.path.starts_with("assets/"))
            || (!resources && entry.path.starts_with("/"))
        {
            return Err("fallback settings manifest path is invalid".into());
        }
        if previous.is_some_and(|last| last >= entry.path.as_str()) {
            return Err("fallback settings manifest entries must be uniquely sorted".into());
        }
        previous = Some(&entry.path);
        let cap = if resources {
            super::MAX_RUNTIME_FILE_BYTES
        } else {
            MAX_SOURCE_FILE_BYTES
        };
        total = total
            .checked_add(entry.bytes)
            .ok_or_else(|| "fallback settings metadata byte total overflow".to_string())?;
        if entry.bytes > cap {
            return Err("fallback settings manifest entry exceeds its byte limit".into());
        }
    }
    let total_limit = if resources {
        super::MAX_RUNTIME_TOTAL_BYTES
    } else {
        MAX_SOURCE_TOTAL_BYTES
    };
    if total > total_limit {
        return Err("fallback settings manifest entry total exceeds its byte limit".into());
    }
    Ok(())
}

fn sum_entry_bytes(entries: &[Entry], per_file_limit: u64) -> Result<u64, String> {
    entries.iter().try_fold(0_u64, |total, entry| {
        if entry.bytes > per_file_limit {
            return Err("fallback settings resource exceeds the 1 MiB per-file limit".into());
        }
        total
            .checked_add(entry.bytes)
            .ok_or_else(|| "fallback settings resource byte total overflow".to_string())
    })
}

fn collect_resources(
    root: &Path,
    directory: &Path,
    depth: usize,
    expected: &BTreeMap<String, &Entry>,
    scan: &mut ScanBudget,
    files: &mut BTreeMap<String, Box<[u8]>>,
    javascript_count: &mut usize,
    runtime_bytes: &mut u64,
) -> Result<(), String> {
    if depth > MAX_RESOURCE_DEPTH || scan.directories >= super::MAX_SCAN_DIRECTORIES {
        return Err("fallback settings directory tree exceeds its scan limit".into());
    }
    scan.directories += 1;
    let remaining = super::MAX_SCAN_ENTRIES.saturating_sub(scan.entries);
    let mut entries = fs::read_dir(directory)
        .map_err(|_| "fallback settings directory cannot be read".to_string())?
        .take(remaining.saturating_add(1))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "fallback settings directory cannot be listed".to_string())?;
    if entries.len() > remaining {
        return Err("fallback settings directory tree exceeds its entry limit".into());
    }
    scan.entries += entries.len();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "fallback settings resource escaped its root".to_string())?;
        let normalized = normalize_resource_path(relative)?;
        let file_type = entry
            .file_type()
            .map_err(|_| "fallback settings entry cannot be inspected".to_string())?;
        if file_type.is_symlink() {
            return Err("fallback settings bundle must not contain symlinks".into());
        }
        if file_type.is_dir() {
            if normalized != "assets"
                && (!normalized.starts_with("assets/")
                    || !expected
                        .keys()
                        .any(|resource| resource.starts_with(&format!("{normalized}/"))))
            {
                return Err("fallback settings bundle contains an unlisted directory".into());
            }
            collect_resources(
                root,
                &path,
                depth + 1,
                expected,
                scan,
                files,
                javascript_count,
                runtime_bytes,
            )?;
            continue;
        }
        if !file_type.is_file() {
            return Err("fallback settings bundle may contain only regular files".into());
        }
        if normalized == MANIFEST_NAME {
            continue;
        }
        let resource = expected
            .get(&normalized)
            .ok_or_else(|| "fallback settings bundle contains an unlisted file".to_string())?;
        let bytes = read_regular_file(&path, super::MAX_RUNTIME_FILE_BYTES)?;
        if bytes.len() as u64 != resource.bytes || sha256_hex(&bytes) != resource.sha256 {
            return Err("fallback settings resource bytes do not match the manifest".into());
        }
        *runtime_bytes = runtime_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "fallback settings runtime byte total overflow".to_string())?;
        if *runtime_bytes > super::MAX_RUNTIME_TOTAL_BYTES
            || files.len() >= super::MAX_RUNTIME_FILES
        {
            return Err("fallback settings bundle exceeds the runtime asset budget".into());
        }
        if normalized.ends_with(".js") || normalized.ends_with(".mjs") {
            *javascript_count += 1;
        }
        files.insert(
            format!("{ASSET_PREFIX}{normalized}"),
            bytes.into_boxed_slice(),
        );
    }
    Ok(())
}

fn normalize_resource_path(path: &Path) -> Result<String, String> {
    let normalized = super::normalize_relative_asset_path(path)?;
    if normalized.len() > MAX_RESOURCE_PATH_BYTES
        || normalized.split('/').count() > MAX_RESOURCE_DEPTH
    {
        return Err("fallback settings path exceeds its path limit".into());
    }
    Ok(normalized)
}

fn valid_relative_path(path: &str, max_bytes: usize, max_depth: usize) -> bool {
    !path.is_empty()
        && path.len() <= max_bytes
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && !path.chars().any(char::is_control)
        && path.split('/').count() <= max_depth
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn read_regular_file(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let path_metadata = fs::symlink_metadata(path)
        .map_err(|_| "fallback settings file cannot be inspected".to_string())?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
        || path_metadata.len() > limit
    {
        return Err("fallback settings file type or size is invalid".into());
    }
    let mut file = open_no_follow(path)
        .map_err(|_| "fallback settings file cannot be opened safely".to_string())?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| "fallback settings file cannot be inspected".to_string())?;
    if !opened_metadata.is_file()
        || opened_metadata.len() > limit
        || file_identity(&opened_metadata) != file_identity(&path_metadata)
    {
        return Err("fallback settings file changed while opening".into());
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "fallback settings file cannot be read".to_string())?;
    if bytes.len() as u64 != opened_metadata.len() || bytes.len() as u64 > limit {
        return Err("fallback settings file changed while reading".into());
    }
    Ok(bytes)
}

fn open_no_follow(path: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn file_identity(metadata: &fs::Metadata) -> (u64, u64) {
    (
        metadata.len(),
        metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |value| value.as_nanos() as u64),
    )
}

fn digest_entries(entries: &[Entry]) -> Result<String, String> {
    let json = serde_json::to_vec(entries)
        .map_err(|_| "fallback settings manifest cannot be serialized".to_string())?;
    Ok(sha256_hex(&json))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "fallback_assets_tests.rs"]
mod tests;
