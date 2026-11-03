//! Read-only checks for SHA-pinned native fixtures. No extraction or code execution.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
};

pub(super) const MAX_REVIEW_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_MANIFEST_BYTES: usize = atools_plugin::package_resolution::MAX_MANIFEST_BYTES;
pub(super) const MAX_PROBE_BYTES: usize = 512 * 1024;
pub(super) const MAX_PANEL_JS_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_PANEL_CSS_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_DEPTH: usize = 32;

pub(super) fn read_bounded_regular(path: &Path, cap: usize) -> Result<Vec<u8>, String> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() > cap as u64 {
        return Err(format!(
            "Fixture input must be a nonsymlink regular file within {cap} bytes: {}",
            path.display()
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if !opened.is_file() || opened.len() > cap as u64 {
        return Err("Fixture input changed type/size while opening".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != before.dev() || opened.ino() != before.ino() {
            return Err("Fixture input identity changed while opening".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > cap {
        return Err("Fixture input exceeded its stream read budget".into());
    }
    Ok(bytes)
}

fn safe_relative(name: &str, directory: bool) -> Result<String, String> {
    let value = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    let parts: Vec<_> = value.split('/').collect();
    if value.is_empty()
        || value.len() > 2048
        || value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || parts.len() > MAX_DEPTH
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
    {
        return Err("Unsafe published ZIP/file path".into());
    }
    Ok(value.into())
}

fn validate_root(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("Published plugin root must be absolute".into());
    }
    let mut current = PathBuf::new();
    for component in root.components() {
        match component {
            Component::RootDir | Component::Normal(_) => current.push(component),
            _ => return Err("Unsafe published root component".into()),
        }
        let metadata = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Published root contains a symlink or nondirectory".into());
        }
    }
    if fs::canonicalize(root).map_err(|e| e.to_string())? != root {
        return Err("Published root is not the exact canonical reviewed root".into());
    }
    Ok(())
}

fn tree_entries(root: &Path) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    fn walk(
        root: &Path,
        relative: &str,
        depth: usize,
        count: &mut usize,
        files: &mut BTreeSet<String>,
        directories: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("Fixture tree depth exceeds budget".into());
        }
        for entry in fs::read_dir(root.join(relative)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            *count += 1;
            if *count > MAX_ENTRIES * 2 {
                return Err("Fixture filesystem entry count exceeds budget".into());
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Non-UTF8 fixture filename")?;
            let name = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let name = safe_relative(&name, false)?;
            let metadata = fs::symlink_metadata(root.join(&name)).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("Fixture tree contains a symlink".into());
            }
            if metadata.is_dir() {
                directories.insert(name.clone());
                walk(root, &name, depth + 1, count, files, directories)?;
            } else if metadata.is_file() {
                if metadata.len() > MAX_ENTRY_BYTES as u64 {
                    return Err("Fixture file exceeds per-file budget".into());
                }
                files.insert(name);
            } else {
                return Err("Fixture tree contains a special file".into());
            }
        }
        Ok(())
    }
    let (mut files, mut directories, mut count) = (BTreeSet::new(), BTreeSet::new(), 0);
    walk(root, "", 0, &mut count, &mut files, &mut directories)?;
    Ok((files, directories))
}

fn native_content(name: &str, bytes: &[u8]) -> bool {
    let lower = name.to_ascii_lowercase();
    if [
        ".node", ".exe", ".dll", ".dylib", ".a", ".o", ".wasm", ".so",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
        || lower.contains(".so.")
    {
        return true;
    }
    let magic = bytes.get(..4).unwrap_or_default();
    [
        b"\x7fELF".as_slice(),
        b"\xfe\xed\xfa\xce",
        b"\xce\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
        b"\xca\xfe\xba\xbf",
        b"\xbf\xba\xfe\xca",
    ]
    .contains(&magic)
        || bytes.starts_with(b"MZ")
}

/// Compare the current directory with ZIP-derived bytes, never review.files hashes.
fn verify_archive_tree(bytes: &[u8], root: &Path, file_count: usize) -> Result<Value, String> {
    validate_root(root)?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("Published ZIP exceeds compressed budget".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    if archive.is_empty() || archive.len() > MAX_ENTRIES {
        return Err("Published ZIP entry count exceeds budget".into());
    }
    let mut files = BTreeMap::new();
    let mut directories = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = std::str::from_utf8(entry.name_raw()).map_err(|_| "Non-UTF8 ZIP filename")?;
        let name = safe_relative(name, entry.is_dir())?;
        let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
        if entry.encrypted()
            || ![0, 0o100000, 0o040000].contains(&kind)
            || (kind == 0o040000 && !entry.is_dir())
            || (kind == 0o100000 && entry.is_dir())
            || !paths.insert(name.to_ascii_lowercase())
        {
            return Err(
                "Published ZIP has encrypted, duplicate, symlink or special entries".into(),
            );
        }
        total = total.checked_add(entry.size()).ok_or("ZIP size overflow")?;
        if entry.size() > MAX_ENTRY_BYTES as u64
            || (name == "plugin.json" && entry.size() > MAX_MANIFEST_BYTES as u64)
            || total > MAX_EXPANDED_BYTES as u64
            || (entry.size() > 0 && entry.size() / entry.compressed_size().max(1) > 1000)
        {
            return Err("Published ZIP expanded size/ratio exceeds budget".into());
        }
        if entry.is_dir() {
            if entry.size() != 0 {
                return Err("ZIP directory contains data".into());
            }
            directories.insert(name);
        } else {
            files.insert(name, index);
        }
    }
    if files.len() != file_count || !files.contains_key("plugin.json") {
        return Err("Published ZIP must match the pinned file count and root plugin.json".into());
    }
    let file_paths_lower: BTreeSet<_> =
        files.keys().map(|name| name.to_ascii_lowercase()).collect();
    let all_paths: Vec<_> = files.keys().chain(directories.iter()).cloned().collect();
    for name in all_paths {
        for (offset, _) in name.match_indices('/') {
            let parent = &name[..offset];
            if file_paths_lower.contains(&parent.to_ascii_lowercase()) {
                return Err("ZIP file/directory path conflict".into());
            }
            directories.insert(parent.to_string());
        }
    }
    let (actual_files, actual_directories) = tree_entries(root)?;
    if actual_files != files.keys().cloned().collect() || actual_directories != directories {
        return Err("Fixture tree has missing or extra files/directories".into());
    }
    let mut verified_files = Vec::new();
    let mut actual_total = 0usize;
    for (name, index) in files {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let size = entry.size();
        let mut content = Vec::new();
        entry
            .take(MAX_ENTRY_BYTES as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|e| e.to_string())?;
        actual_total = actual_total
            .checked_add(content.len())
            .ok_or("ZIP expanded size overflow")?;
        if content.len() > MAX_ENTRY_BYTES
            || content.len() as u64 != size
            || actual_total > MAX_EXPANDED_BYTES
        {
            return Err("ZIP content exceeded its stream budget or declared size".into());
        }
        if native_content(&name, &content) {
            return Err("Native content is outside reviewed fixture scope".into());
        }
        let target = root.join(&name);
        if fs::canonicalize(&target).map_err(|e| e.to_string())? != target {
            return Err("Fixture file escaped its exact root".into());
        }
        let actual = read_bounded_regular(&target, MAX_ENTRY_BYTES)?;
        if actual != content {
            return Err(format!(
                "Fixture source bytes differ from pinned ZIP: {name}"
            ));
        }
        verified_files.push(json!({"path":name,"bytes":content.len(),"sha256":format!("{:x}",Sha256::digest(&content))}));
    }
    Ok(
        json!({"sourceBytesUnchanged":true,"unchangedFileCount":file_count,"expandedBytes":actual_total,
        "files":verified_files,"extractedToDisk":false,"pluginCodeExecutedByVerification":false,
        "boundary":"Bounded path/type/byte checks before GUI; not an OS sandbox and not protection from every later same-UID mutation"}),
    )
}

pub(super) fn verify_reviewed_package(
    review: &Value,
    profile: &Value,
    root: &Path,
    expected: &str,
) -> Result<Value, String> {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/published-plugin-cases.json"
    ))
    .map_err(|e| e.to_string())?;
    if !registry["cases"]
        .as_array()
        .is_some_and(|cases| cases.iter().any(|registered| registered == profile))
    {
        return Err("Unknown or modified published fixture profile".into());
    }
    validate_root(root)?;
    let fixture = &review["fixture"];
    if review["status"] != profile["sourceReviewStatus"]
        || fixture["id"] != profile["id"]
        || fixture["version"] != profile["version"]
        || fixture["archiveSha256"] != expected
        || profile["archiveSha256"] != expected
        || fixture["files"].as_array().map(|files| files.len() as u64)
            != profile["fileCount"].as_u64()
        || fixture["pluginRoot"].as_str().map(Path::new) != Some(root)
    {
        return Err(
            "Source review does not match the registered package root/identity/SHA/file count"
                .into(),
        );
    }
    let archive_path = fixture["archivePath"]
        .as_str()
        .ok_or("Review missing archivePath")?;
    let bytes = read_bounded_regular(Path::new(archive_path), MAX_ARCHIVE_BYTES)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err("Reviewed archive SHA changed before native execution".into());
    }
    let mut result = verify_archive_tree(
        &bytes,
        root,
        profile["fileCount"]
            .as_u64()
            .ok_or("Profile missing fileCount")? as usize,
    )?;
    result["archiveSha256"] = json!(expected);
    result["archiveBytes"] = json!(bytes.len());
    Ok(result)
}

#[cfg(test)]
#[path = "published_package_verification_tests.rs"]
mod tests;
