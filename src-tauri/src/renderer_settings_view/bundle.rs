use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "bundle_binding.rs"]
mod binding;
#[path = "bundle_policy.rs"]
mod policy;

use policy::{select_source_policy, ResourceBudgetPolicy};

const PROVENANCE_PATH: &str = "build-provenance.json";
const MAX_PROVENANCE_BYTES: usize = 256 * 1024;
const SOURCE_MANIFEST_PATH: &str = "source-manifest.json";
const MAX_SOURCE_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_RESOURCE_COUNT: usize = 64;
const MAX_TREE_ENTRIES: usize = 128;
const MAX_PATH_BYTES: usize = 512;
const MAX_PATH_DEPTH: usize = 8;
const ARTIFACT_OWNER: &str = "@atools/ztools-settings-source-build";
const METADATA_FILES: &[&str] = &[
    "ZTools-LICENSE",
    "upstream-package.json",
    SOURCE_MANIFEST_PATH,
    PROVENANCE_PATH,
];

type BundleResult<T> = Result<T, &'static str>;

pub(crate) struct BundleAsset {
    pub(crate) bytes: Arc<[u8]>,
    pub(crate) mime: &'static str,
}

pub(crate) struct SettingsBundle {
    assets: HashMap<String, BundleAsset>,
    revision: String,
    total_bytes: usize,
}

struct ResourceSpec {
    path: String,
    bytes: usize,
    sha256: String,
    mime: &'static str,
}

impl SettingsBundle {
    #[cfg(test)]
    pub(super) fn height_test_bundle(revision: &str) -> Self {
        Self {
            assets: HashMap::from([(
                "index.html".into(),
                BundleAsset {
                    bytes: Arc::from(&b"test"[..]),
                    mime: "text/html",
                },
            )]),
            revision: revision.into(),
            total_bytes: 4,
        }
    }

    pub(crate) fn load(root: &Path) -> Result<Self, String> {
        let expected = compiled_revision()?;
        Self::load_inner(root, &expected).map_err(str::to_owned)
    }

    #[cfg(test)]
    pub(super) fn load_with_expected_for_test(root: &Path, expected: &str) -> Result<Self, String> {
        Self::load_inner(root, expected).map_err(str::to_owned)
    }

    pub(crate) fn asset(&self, path: &str) -> Option<&BundleAsset> {
        self.assets.get(path)
    }

    pub(crate) fn revision(&self) -> &str {
        &self.revision
    }

    pub(crate) fn resource_count(&self) -> usize {
        self.assets.len()
    }

    pub(crate) fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    fn load_inner(root: &Path, expected: &str) -> BundleResult<Self> {
        validate_root(root)?;
        let source_manifest_bytes =
            read_asset(root, SOURCE_MANIFEST_PATH, MAX_SOURCE_MANIFEST_BYTES)?;
        let source_manifest: Value = serde_json::from_slice(&source_manifest_bytes)
            .map_err(|_| "Invalid bundle source manifest")?;
        let budget_policy = select_source_policy(&source_manifest)?;
        let provenance_bytes = read_asset(root, PROVENANCE_PATH, MAX_PROVENANCE_BYTES)?;
        let revision = binding::verify(&provenance_bytes, expected)?;
        let provenance: Value =
            serde_json::from_slice(&provenance_bytes).map_err(|_| "Invalid bundle provenance")?;
        let (resources, declared_total) = validate_provenance(&provenance, budget_policy)?;
        let expected_paths: HashSet<String> = resources
            .iter()
            .map(|resource| resource.path.clone())
            .collect();
        verify_runtime_tree(root, &expected_paths)?;

        let mut assets = HashMap::with_capacity(resources.len());
        let mut total_bytes = 0usize;
        for resource in resources {
            let bytes = read_asset(root, &resource.path, resource.bytes)?;
            if bytes.len() != resource.bytes || sha256_hex(&bytes) != resource.sha256 {
                return Err("Bundle resource does not match provenance");
            }
            if bytes.is_empty()
                && (resource.path == "index.html"
                    || resource.mime == "text/javascript; charset=utf-8"
                    || resource.mime == "text/css; charset=utf-8")
            {
                return Err("Required bundle resource is empty");
            }
            total_bytes = total_bytes
                .checked_add(bytes.len())
                .ok_or("Bundle byte total overflow")?;
            assets.insert(
                resource.path,
                BundleAsset {
                    bytes: Arc::<[u8]>::from(bytes),
                    mime: resource.mime,
                },
            );
        }
        if total_bytes != declared_total || total_bytes > budget_policy.max_total_bytes() {
            return Err("Bundle byte total is invalid");
        }

        Ok(Self {
            assets,
            revision,
            total_bytes,
        })
    }
}

/// Read-only identity of the provenance embedded in this binary; no IPC or path input.
pub(crate) fn compiled_revision() -> Result<String, String> {
    binding::compiled_revision()
}

fn validate_root(root: &Path) -> BundleResult<()> {
    if !root.is_absolute() {
        return Err("Bundle root must be an absolute canonical directory");
    }
    let metadata = fs::symlink_metadata(root).map_err(|_| "Bundle root is unavailable")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Bundle root must be a non-symlink directory");
    }
    let canonical = root
        .canonicalize()
        .map_err(|_| "Bundle root must be an absolute canonical directory")?;
    if canonical.as_os_str() != root.as_os_str() {
        return Err("Bundle root must be an absolute canonical directory");
    }
    Ok(())
}

fn read_asset(root: &Path, path: &str, max_bytes: usize) -> BundleResult<Vec<u8>> {
    atools_plugin::package_resolution::read_package_asset_bytes(root, Path::new(path), max_bytes)
        .map_err(|_| "Bundle file could not be read safely")?
        .ok_or("Bundle file is missing")
}

fn validate_provenance(
    value: &Value,
    budget_policy: ResourceBudgetPolicy,
) -> BundleResult<(Vec<ResourceSpec>, usize)> {
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || value.get("artifactOwner").and_then(Value::as_str) != Some(ARTIFACT_OWNER)
        || value.get("status").and_then(Value::as_str) != Some("strict/typecheck-passed")
        || value.get("typecheckPassed").and_then(Value::as_bool) != Some(true)
        || value.get("reviewOnly").and_then(Value::as_bool) == Some(true)
        || value.get("review_only").and_then(Value::as_bool) == Some(true)
    {
        return Err("Bundle provenance is not an approved strict build");
    }
    let source = value
        .get("source")
        .ok_or("Bundle source provenance is missing")?;
    if source.get("commit").and_then(Value::as_str) != Some(policy::SOURCE_COMMIT)
        || source.get("workingTreeClean").and_then(Value::as_bool) != Some(true)
    {
        return Err("Bundle source provenance is not approved");
    }
    let build = value
        .get("build")
        .ok_or("Bundle build provenance is missing")?;
    if build.get("typecheckPassed").and_then(Value::as_bool) != Some(true) {
        return Err("Bundle build typecheck did not pass");
    }

    let entries = value
        .get("emittedResources")
        .and_then(Value::as_array)
        .ok_or("Bundle resource inventory is missing")?;
    if entries.is_empty() || entries.len() > MAX_RESOURCE_COUNT {
        return Err("Bundle resource count is invalid");
    }
    if value.get("emittedResourceCount").and_then(Value::as_u64) != Some(entries.len() as u64) {
        return Err("Bundle resource count does not match provenance");
    }

    let mut seen = HashSet::with_capacity(entries.len());
    let mut resources = Vec::with_capacity(entries.len());
    let mut total = 0usize;
    let mut has_index = false;
    let mut has_javascript = false;
    let mut has_stylesheet = false;
    for entry in entries {
        let path = entry
            .get("path")
            .and_then(Value::as_str)
            .ok_or("Bundle resource path is invalid")?;
        validate_resource_path(path)?;
        if METADATA_FILES.contains(&path) || !seen.insert(path.to_owned()) {
            return Err("Bundle resource path is duplicated or reserved");
        }
        let mime = mime_for_path(path).ok_or("Bundle resource type is not allowed")?;
        let bytes = entry
            .get("bytes")
            .and_then(Value::as_u64)
            .and_then(|size| usize::try_from(size).ok())
            .ok_or("Bundle resource size is invalid")?;
        let sha256 = entry
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|hash| is_sha256_hex(hash))
            .ok_or("Bundle resource hash is invalid")?;
        if bytes == 0 {
            return Err("Bundle resource size must be nonzero");
        }
        total = total
            .checked_add(bytes)
            .ok_or("Bundle byte total overflow")?;
        if total > budget_policy.max_total_bytes() {
            return Err("Bundle exceeds the approved byte budget");
        }
        has_index |= path == "index.html";
        has_javascript |= mime == "text/javascript; charset=utf-8";
        has_stylesheet |= mime == "text/css; charset=utf-8";
        resources.push(ResourceSpec {
            path: path.to_owned(),
            bytes,
            sha256: sha256.to_owned(),
            mime,
        });
    }
    if !has_index || !has_javascript || !has_stylesheet {
        return Err("Bundle must include HTML, JavaScript, and CSS");
    }
    if value
        .get("emittedResourceTotalBytes")
        .and_then(Value::as_u64)
        != Some(total as u64)
    {
        return Err("Bundle byte total does not match provenance");
    }
    let expected_increase = total as i64 - budget_policy.baseline_bytes as i64;
    let budget = value
        .get("bundleBudget")
        .ok_or("Bundle resource budget is missing")?;
    if budget.get("metric").and_then(Value::as_str) != Some(policy::RESOURCE_BUDGET_METRIC)
        || budget.get("actualBytes").and_then(Value::as_u64) != Some(total as u64)
        || budget.get("baselineBytes").and_then(Value::as_u64)
            != Some(budget_policy.baseline_bytes as u64)
        || budget.get("maxIncreaseBytes").and_then(Value::as_u64)
            != Some(budget_policy.max_increase_bytes as u64)
        || budget.get("maxBytes").and_then(Value::as_u64)
            != Some(budget_policy.absolute_max_bytes as u64)
        || budget.get("increaseBytes").and_then(Value::as_i64) != Some(expected_increase)
        || total > budget_policy.max_total_bytes()
        || budget.get("passed").and_then(Value::as_bool) != Some(true)
    {
        return Err("Bundle resource budget does not match computed bytes");
    }
    Ok((resources, total))
}

fn validate_resource_path(path: &str) -> BundleResult<()> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.contains(['\\', '%', '?', '#', ':'])
        || path.chars().any(char::is_control)
    {
        return Err("Bundle resource path is unsafe");
    }
    let segments: Vec<_> = path.split('/').collect();
    if segments.len() > MAX_PATH_DEPTH
        || segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err("Bundle resource path is unsafe");
    }
    if Path::new(path)
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Bundle resource path is unsafe");
    }
    Ok(())
}

fn mime_for_path(path: &str) -> Option<&'static str> {
    match path.rsplit_once('.')?.1 {
        "html" => Some("text/html; charset=utf-8"),
        "js" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "json" => Some("application/json"),
        _ => None,
    }
}

fn verify_runtime_tree(root: &Path, expected: &HashSet<String>) -> BundleResult<()> {
    let mut files = HashSet::with_capacity(expected.len());
    let mut visited = 0usize;
    scan_directory(root, "", 0, expected, &mut files, &mut visited)?;
    if &files != expected {
        return Err("Bundle inventory does not match files on disk");
    }
    Ok(())
}

fn scan_directory(
    root: &Path,
    relative: &str,
    depth: usize,
    expected: &HashSet<String>,
    files: &mut HashSet<String>,
    visited: &mut usize,
) -> BundleResult<()> {
    let directory = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let entries = fs::read_dir(directory).map_err(|_| "Bundle directory is unreadable")?;
    for entry in entries {
        let entry = entry.map_err(|_| "Bundle directory is unreadable")?;
        *visited += 1;
        if *visited > MAX_TREE_ENTRIES {
            return Err("Bundle directory contains too many entries");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Bundle contains a non-UTF-8 file name")?;
        let child = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        validate_resource_path(&child)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| "Bundle entry is unavailable")?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err("Bundle symlinks are not allowed");
        }
        if file_type.is_dir() {
            let next_depth = depth + 1;
            if next_depth > MAX_PATH_DEPTH
                || !expected
                    .iter()
                    .any(|path| path.starts_with(&format!("{child}/")))
            {
                return Err("Bundle contains an unlisted directory");
            }
            scan_directory(root, &child, next_depth, expected, files, visited)?;
        } else if file_type.is_file() {
            if METADATA_FILES.contains(&child.as_str()) {
                continue;
            }
            if !expected.contains(&child) || !files.insert(child) {
                return Err("Bundle contains an unlisted file");
            }
        } else {
            return Err("Bundle contains an unsupported file type");
        }
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "bundle_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "bundle_builtin_shortcuts_tests.rs"]
mod builtin_shortcuts_tests;
