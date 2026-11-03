//! Independent verification for reviewed, unpacked local original plugin directories.
//! This path is intentionally separate from published ZIP verification and never executes code.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_FILES: usize = 64;
const MAX_DIRECTORIES: usize = 64;
const MAX_DEPTH: usize = 16;
const MAX_PATH_BYTES: usize = 2048;
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TREE_BYTES: usize = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileWitness {
    path: String,
    bytes: usize,
    sha256: String,
}

fn valid_relative(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    !value.is_empty()
        && value.len() <= MAX_PATH_BYTES
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && parts.len() <= MAX_DEPTH
        && parts
            .iter()
            .all(|part| !part.is_empty() && *part != "." && *part != ".." && !part.contains(':'))
}

fn validate_root(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("Local original plugin root must be absolute".into());
    }
    let mut current = PathBuf::new();
    for component in root.components() {
        match component {
            Component::RootDir | Component::Normal(_) => current.push(component),
            _ => return Err("Unsafe local original root component".into()),
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Local original root contains a symlink or nondirectory".into());
        }
    }
    if fs::canonicalize(root).map_err(|error| error.to_string())? != root {
        return Err("Local original root must be the exact canonical path".into());
    }
    Ok(())
}

fn validate_private_fixture_root(root: &Path) -> Result<(), String> {
    let owned = root
        .parent()
        .ok_or("Local fixture root has no owned parent")?;
    if root.file_name().and_then(|name| name.to_str()) != Some("plugin")
        || !owned
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("atools-local-plugin-fixture-"))
    {
        return Err("Local fixture must be inside its uniquely owned temporary directory".into());
    }
    let canonical_owned = fs::canonicalize(owned).map_err(|error| error.to_string())?;
    let mut temp_roots =
        vec![fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?];
    if let Ok(private_tmp) = fs::canonicalize("/private/tmp") {
        temp_roots.push(private_tmp);
    }
    if !temp_roots
        .iter()
        .any(|temp_root| canonical_owned.starts_with(temp_root))
    {
        return Err("Local fixture is outside the process temporary directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for directory in [owned, root] {
            let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
            if metadata.permissions().mode() & 0o777 != 0o700 {
                return Err("Local fixture directories must have mode 0700".into());
            }
        }
    }
    Ok(())
}

fn read_regular(path: &Path, cap: usize) -> Result<Vec<u8>, String> {
    let before = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() > cap as u64 {
        return Err("Local fixture file is not a bounded regular file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() > cap as u64 {
        return Err("Local fixture file changed type or size while opening".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != before.dev() || opened.ino() != before.ino() {
            return Err("Local fixture file identity changed while opening".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > cap || bytes.len() as u64 != opened.len() {
        return Err("Local fixture file exceeded its bounded read".into());
    }
    Ok(bytes)
}

fn scan_tree(root: &Path) -> Result<(BTreeMap<String, Vec<u8>>, BTreeSet<String>), String> {
    fn walk(
        root: &Path,
        relative: &str,
        depth: usize,
        files: &mut BTreeMap<String, Vec<u8>>,
        directories: &mut BTreeSet<String>,
        total: &mut usize,
    ) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("Local package depth exceeds budget".into());
        }
        for entry in fs::read_dir(root.join(relative)).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Non-UTF8 local package path")?;
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if !valid_relative(&path) {
                return Err("Unsafe local package path".into());
            }
            let absolute = root.join(&path);
            let metadata = fs::symlink_metadata(&absolute).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("Local package contains a symlink".into());
            }
            if metadata.is_dir() {
                directories.insert(path.clone());
                if directories.len() > MAX_DIRECTORIES {
                    return Err("Local package directory count exceeds budget".into());
                }
                walk(root, &path, depth + 1, files, directories, total)?;
            } else if metadata.is_file() {
                if files.len() >= MAX_FILES || metadata.len() > MAX_FILE_BYTES as u64 {
                    return Err("Local package file count or size exceeds budget".into());
                }
                let bytes = read_regular(&absolute, MAX_FILE_BYTES)?;
                *total = total
                    .checked_add(bytes.len())
                    .ok_or("Local package size overflow")?;
                if *total > MAX_TREE_BYTES {
                    return Err("Local package expanded size exceeds budget".into());
                }
                files.insert(path, bytes);
            } else {
                return Err("Local package contains a special file".into());
            }
        }
        Ok(())
    }
    validate_root(root)?;
    let (mut files, mut directories, mut total) = (BTreeMap::new(), BTreeSet::new(), 0);
    walk(root, "", 0, &mut files, &mut directories, &mut total)?;
    Ok((files, directories))
}

fn digest_tree(
    files: &BTreeMap<String, Vec<u8>>,
    directories: &BTreeSet<String>,
) -> Result<(String, Vec<FileWitness>), String> {
    let mut hash = Sha256::new();
    hash.update(b"AToolsLocalTreeV1\0");
    for directory in directories {
        if !valid_relative(directory) {
            return Err("Unsafe registered local directory path".into());
        }
        let path = directory.as_bytes();
        let length = u32::try_from(path.len()).map_err(|_| "Local directory path too long")?;
        hash.update([b'D']);
        hash.update(length.to_be_bytes());
        hash.update(path);
    }
    let mut witness = Vec::with_capacity(files.len());
    for (name, bytes) in files {
        if !valid_relative(name) {
            return Err("Unsafe registered local file path".into());
        }
        let path = name.as_bytes();
        let path_len = u32::try_from(path.len()).map_err(|_| "Local file path too long")?;
        let bytes_len = u64::try_from(bytes.len()).map_err(|_| "Local file size overflow")?;
        let file_hash = Sha256::digest(bytes);
        hash.update([b'F']);
        hash.update(path_len.to_be_bytes());
        hash.update(path);
        hash.update(bytes_len.to_be_bytes());
        hash.update(file_hash);
        witness.push(FileWitness {
            path: name.clone(),
            bytes: bytes.len(),
            sha256: format!("{file_hash:x}"),
        });
    }
    Ok((format!("{:x}", hash.finalize()), witness))
}

fn witness_json(files: &[FileWitness]) -> Value {
    Value::Array(
        files
            .iter()
            .map(|file| json!({"path":file.path,"bytes":file.bytes,"sha256":file.sha256}))
            .collect(),
    )
}

fn registered_case<'a>(
    registry: &'a Value,
    profile: &Value,
) -> Result<(&'a Value, &'a Value), String> {
    let cases = registry["cases"]
        .as_array()
        .ok_or("Invalid local fixture registry")?;
    let registered = cases
        .iter()
        .find(|case| case["caseId"] == profile["caseId"])
        .ok_or("Unknown local original package profile")?;
    if registered != profile {
        return Err("Modified local original package profile".into());
    }
    let snapshots = registry["snapshots"]
        .as_object()
        .ok_or("Missing local fixture snapshots")?;
    let snapshot = snapshots
        .get(profile["caseId"].as_str().ok_or("Missing caseId")?)
        .ok_or("Missing local package snapshot")?;
    Ok((registered, snapshot))
}

fn verify_manifest(root: &Path, profile: &Value) -> Result<(), String> {
    let bytes = read_regular(&root.join("plugin.json"), MAX_MANIFEST_BYTES)?;
    let manifest: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid original plugin.json: {error}"))?;
    if manifest["name"] != profile["id"] || manifest["version"] != profile["version"] {
        return Err("Original manifest identity or version differs from registered profile".into());
    }
    if profile["caseId"] == "local-mybatis-sql-formatter-head"
        && (profile["runtime"] != "web" || manifest["preload"] != "preload.js")
    {
        return Err(
            "Registered MyBatis fixture must use the pinned pure-JavaScript web preload".into(),
        );
    }
    if profile["caseId"] == "local-random-data-head"
        && (profile["runtime"] != "web"
            || profile["dataAccess"] != true
            || manifest["preload"] != "preload.js")
    {
        return Err(
            "Registered Random Data fixture must retain its exact web preload and data scope"
                .into(),
        );
    }
    if profile["runtime"] == "node"
        && manifest["preload"]
            .as_str()
            .is_none_or(|preload| preload.trim().is_empty())
    {
        return Err("Registered Node profile must retain its original preload entry".into());
    }
    let features = manifest["features"]
        .as_array()
        .ok_or("Original manifest has no features")?;
    if !features
        .iter()
        .any(|feature| feature["code"] == profile["featureCode"])
    {
        return Err("Original manifest does not contain the registered feature".into());
    }
    Ok(())
}

/// Verify a fresh copied full directory against the independently embedded source profile and witness.
pub fn verify_reviewed_local_package(
    review: &Value,
    profile: &Value,
    root: &Path,
    expected: &str,
) -> Result<Value, String> {
    if !matches!(profile["runtime"].as_str(), Some("web" | "node")) {
        return Err("Unsupported local original fixture runtime".into());
    }
    let registry_source = match profile["caseId"].as_str() {
        Some("local-uuid-kit" | "local-ascii-tree") => {
            include_str!("../../../tests/fixtures/local-original-input-cases.json")
        }
        Some("local-plain-text") => {
            include_str!("../../../tests/fixtures/local-plain-text-cases.json")
        }
        Some("local-subnet-calculator") => {
            include_str!("../../../tests/fixtures/local-subnet-calculator-cases.json")
        }
        Some("local-mybatis-sql-formatter-head") => {
            include_str!("../../../tests/fixtures/local-original-mybatis-cases.json")
        }
        Some("local-random-data-head") => {
            include_str!("../../../tests/fixtures/local-original-random-data-cases.json")
        }
        Some("local-image-stitch-head") => {
            include_str!("../../../tests/fixtures/local-original-image-stitch-cases.json")
        }
        _ => include_str!("../../../tests/fixtures/local-original-plugin-cases.json"),
    };
    let registry: Value =
        serde_json::from_str(registry_source).map_err(|error| error.to_string())?;
    let (_, snapshot) = registered_case(&registry, profile)?;
    if profile["sourceKind"] != "local_full_directory"
        || !(profile["pathAccess"] == "none"
            || (profile["caseId"] == "local-plain-text"
                && profile["id"] == "plain-text"
                && profile["runtime"] == "node"
                && profile["dataAccess"] == true
                && profile["verifyDataPersistence"] == true
                && profile["pathAccess"] == "standard"))
        || !profile["verifyDataPersistence"].is_boolean()
        || (profile["verifyDataPersistence"] == true && profile["dataAccess"] != true)
        || profile["directorySha256"] != expected
        || snapshot["directorySha256"] != expected
        || review["schemaVersion"] != 1
        || review["sourceKind"] != "local_full_directory"
        || review["status"] != profile["sourceReviewStatus"]
        || review["profile"]["caseId"] != profile["caseId"]
        || review["profile"]["id"] != profile["id"]
        || review["profile"]["version"] != profile["version"]
        || review["profile"]["sourceKind"] != profile["sourceKind"]
        || review["profile"]["directorySha256"] != expected
        || review["profile"]["fileCount"] != profile["fileCount"]
        || review["fixture"]["directorySha256"] != expected
        || review["fixture"]["fileCount"] != profile["fileCount"]
        || review["fixture"]["id"] != profile["id"]
        || review["fixture"]["version"] != profile["version"]
        || review["fixture"]["sourceKind"] != "local_full_directory"
        || review["fixture"]["pluginRoot"].as_str().map(Path::new) != Some(root)
    {
        return Err(
            "Local source review does not match the registered profile, digest, or fixture root"
                .into(),
        );
    }
    validate_root(root)?;
    validate_private_fixture_root(root)?;
    let (files, directories) = scan_tree(root)?;
    let (digest, file_witness) = digest_tree(&files, &directories)?;
    if files.len()
        != profile["fileCount"]
            .as_u64()
            .ok_or("Invalid registered file count")? as usize
        || digest != expected
        || witness_json(&file_witness) != snapshot["files"]
        || json!(directories.iter().collect::<Vec<_>>()) != snapshot["directories"]
        || review["fixture"]["files"] != snapshot["files"]
        || review["fixture"]["directories"] != snapshot["directories"]
    {
        return Err("Local package tree differs from the registered full-directory witness".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for relative in &directories {
            if fs::symlink_metadata(root.join(relative))
                .map_err(|error| error.to_string())?
                .permissions()
                .mode()
                & 0o777
                != 0o700
            {
                return Err("Local package directories must have mode 0700".into());
            }
        }
        for relative in files.keys() {
            if fs::symlink_metadata(root.join(relative))
                .map_err(|error| error.to_string())?
                .permissions()
                .mode()
                & 0o777
                != 0o600
            {
                return Err("Local fixture files must have mode 0600".into());
            }
        }
    }
    verify_manifest(root, profile)?;
    Ok(json!({
        "sourceBytesUnchanged": true,
        "fixtureBytesMatchRegisteredSource": true,
        "sourceKind": "local_full_directory",
        "directorySha256": digest,
        "unchangedFileCount": files.len(),
        "expandedBytes": files.values().map(Vec::len).sum::<usize>(),
        "files": file_witness.iter().map(|file| json!({"path":file.path,"bytes":file.bytes,"sha256":file.sha256})).collect::<Vec<_>>(),
        "directories": directories,
        "pluginCodeExecutedByVerification": false
    }))
}

#[cfg(test)]
#[path = "local_plain_subnet_verification_tests.rs"]
mod plain_subnet_tests;
#[cfg(test)]
#[path = "local_package_verification_tests.rs"]
mod tests;
