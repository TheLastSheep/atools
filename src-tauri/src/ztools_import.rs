use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use atools_core::models::{Cmd, CmdType, PluginManifest};
use atools_core::Plugin;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportCandidate {
    pub path: String,
    pub source_type: String,
    pub name: String,
    pub title: Option<String>,
    pub version: String,
    pub features_count: usize,
    pub platform_supported: bool,
    pub main_exists: bool,
    pub preload_exists: bool,
    pub logo_exists: bool,
    pub unsupported_cmd_types: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: usize = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_ARCHIVE_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportReport {
    pub imported: Vec<String>,
    pub skipped: Vec<ZToolsImportCandidate>,
    pub failed: Vec<ZToolsImportFailure>,
}

pub fn scan_ztools_plugin_candidates(root: &Path) -> Result<Vec<ZToolsImportCandidate>, String> {
    let mut sources = Vec::new();
    collect_plugin_sources(root, &mut sources)?;

    let mut candidates = Vec::new();
    for source in sources {
        candidates.push(
            candidate_from_source(&source)
                .unwrap_or_else(|error| failed_candidate_from_source(&source, error)),
        );
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    Ok(candidates)
}

fn failed_candidate_from_source(source: &Path, error: String) -> ZToolsImportCandidate {
    ZToolsImportCandidate {
        path: source.to_string_lossy().to_string(),
        source_type: if source.is_dir() {
            "directory"
        } else {
            archive_source_type(source)
        }
        .to_string(),
        name: source
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("invalid-plugin")
            .to_string(),
        title: None,
        version: String::new(),
        features_count: 0,
        platform_supported: true,
        main_exists: false,
        preload_exists: false,
        logo_exists: false,
        unsupported_cmd_types: Vec::new(),
        warnings: Vec::new(),
        errors: vec![error],
    }
}

pub fn scan_default_ztools_plugin_candidates() -> Result<Vec<ZToolsImportCandidate>, String> {
    let mut candidates = Vec::new();
    for root in default_ztools_plugin_roots() {
        if root.is_dir() {
            candidates.extend(scan_ztools_plugin_candidates(&root)?);
        }
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    candidates.dedup_by(|a, b| a.path == b.path);
    Ok(candidates)
}

pub fn default_ztools_plugin_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut roots = vec![home.join(".ztools").join("plugins")];
    #[cfg(target_os = "macos")]
    roots.push(
        home.join("Library")
            .join("Application Support")
            .join("ZTools")
            .join("plugins"),
    );
    #[cfg(target_os = "windows")]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(app_data).join("ZTools").join("plugins"));
    }
    #[cfg(target_os = "linux")]
    roots.push(home.join(".config").join("ZTools").join("plugins"));
    roots
}

pub fn import_ztools_plugins(
    db: &atools_core::Database,
    install_root: &Path,
    paths: &[String],
    overwrite: bool,
) -> Result<ZToolsImportReport, String> {
    let _mutation_guard = crate::commands::acquire_plugin_mutation_lock()?;
    fs::create_dir_all(install_root).map_err(|e| e.to_string())?;

    let mut report = ZToolsImportReport {
        imported: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };

    for path in paths {
        let source = PathBuf::from(path);
        match import_one(db, install_root, &source, overwrite) {
            Ok(name) => report.imported.push(name),
            Err(ImportSkip::Skip(candidate)) => report.skipped.push(candidate),
            Err(ImportSkip::Fail(error)) => report.failed.push(ZToolsImportFailure {
                path: path.clone(),
                error,
            }),
        }
    }

    Ok(report)
}

enum ImportSkip {
    Skip(ZToolsImportCandidate),
    Fail(String),
}

#[allow(clippy::result_large_err)] // Skip returns the full candidate for the import report.
fn import_one(
    db: &atools_core::Database,
    install_root: &Path,
    source: &Path,
    overwrite: bool,
) -> Result<String, ImportSkip> {
    let mut candidate = candidate_from_source(source).map_err(ImportSkip::Fail)?;
    if !candidate.errors.is_empty() {
        return Err(ImportSkip::Skip(candidate));
    }

    let manifest_content = read_manifest_from_source(source).map_err(ImportSkip::Fail)?;
    let manifest: PluginManifest =
        serde_json::from_str(&manifest_content).map_err(|e| ImportSkip::Fail(e.to_string()))?;
    let plugin_id = atools_core::utils::sanitize_id(&manifest.name);
    let install_dir = install_root.join(&plugin_id);

    let existing = db.get_plugin(&plugin_id).ok();
    if fs::symlink_metadata(&install_dir).is_ok() && !overwrite {
        candidate
            .warnings
            .push("Plugin already installed; overwrite disabled".to_string());
        return Err(ImportSkip::Skip(candidate));
    }

    let staged_dir = if source.is_dir() {
        crate::commands::stage_plugin_directory(source, &install_dir).map_err(ImportSkip::Fail)?
    } else {
        stage_plugin_archive(source, &install_dir).map_err(ImportSkip::Fail)?
    };

    let now = atools_core::utils::now_iso();
    let plugin = Plugin {
        id: plugin_id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: install_dir.to_string_lossy().to_string(),
        enabled: true,
        manifest: manifest.clone(),
        created_at: existing
            .as_ref()
            .map(|plugin| plugin.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };

    crate::commands::replace_plugin_directory_transactionally(&staged_dir, &install_dir, || {
        db.save_plugin_with_features(&plugin, &manifest.features)
            .map_err(|error| error.to_string())
    })
    .map_err(ImportSkip::Fail)?;

    Ok(plugin_id)
}

fn collect_plugin_sources(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if root.is_file() {
        if is_supported_archive(root) {
            out.push(root.to_path_buf());
            return Ok(());
        }
        return Err(format!(
            "Unsupported ZTools plugin source: {}",
            root.display()
        ));
    }
    if root.file_name().and_then(|name| name.to_str()) == Some("node_modules") {
        return Ok(());
    }

    if root.join("plugin.json").is_file() {
        out.push(root.to_path_buf());
        return Ok(());
    }

    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            let _ = collect_plugin_sources(&entry.path(), out);
        } else if file_type.is_file() && is_supported_archive(&entry.path()) {
            out.push(entry.path());
        }
    }

    Ok(())
}

fn candidate_from_source(source: &Path) -> Result<ZToolsImportCandidate, String> {
    if source.is_dir() {
        candidate_from_manifest(&source.join("plugin.json"), "directory")
    } else if is_supported_archive(source) {
        candidate_from_archive(source)
    } else {
        Err(format!(
            "Unsupported ZTools plugin source: {}",
            source.display()
        ))
    }
}

fn candidate_from_manifest(
    manifest_path: &Path,
    source_type: &str,
) -> Result<ZToolsImportCandidate, String> {
    let plugin_dir = manifest_path
        .parent()
        .ok_or_else(|| "Invalid plugin path".to_string())?;
    let text = fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let manifest: PluginManifest =
        serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;

    let title = raw
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let platform_supported = raw
        .get("platform")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|item| item == "darwin" || item == "macos")
        })
        .unwrap_or(true);
    let main_exists = manifest
        .main
        .as_ref()
        .map(|main| plugin_dir.join(main).is_file())
        .unwrap_or(false);
    let preload_exists = manifest
        .preload
        .as_ref()
        .map(|preload| plugin_dir.join(preload).is_file())
        .unwrap_or(true);
    let logo_exists = manifest
        .logo
        .as_ref()
        .map(|logo| plugin_dir.join(logo).is_file())
        .unwrap_or(true);
    let unsupported_cmd_types = unsupported_cmd_types(&manifest);
    let mut warnings = Vec::new();
    let mut errors = Vec::new();

    if !platform_supported {
        warnings.push("Plugin platform does not include darwin".to_string());
    }
    if !main_exists {
        errors.push("Missing main file".to_string());
    }
    if !preload_exists {
        warnings.push("Missing preload file".to_string());
    }
    if !logo_exists {
        warnings.push("Missing logo file".to_string());
    }
    if !unsupported_cmd_types.is_empty() {
        warnings.push(format!(
            "Unsupported command types: {}",
            unsupported_cmd_types.join(", ")
        ));
    }

    Ok(ZToolsImportCandidate {
        path: plugin_dir.to_string_lossy().to_string(),
        source_type: source_type.to_string(),
        name: manifest.name,
        title,
        version: manifest.version,
        features_count: manifest.features.len(),
        platform_supported,
        main_exists,
        preload_exists,
        logo_exists,
        unsupported_cmd_types,
        warnings,
        errors,
    })
}

fn candidate_from_archive(source: &Path) -> Result<ZToolsImportCandidate, String> {
    let archive = read_archive(source)?;
    let manifest_content = read_archive_entry(source, &archive, Path::new("plugin.json"))?
        .ok_or_else(|| format!("Archive does not contain plugin.json: {}", source.display()))?;
    let raw: serde_json::Value = serde_json::from_slice(manifest_content)
        .map_err(|error| format!("Invalid plugin.json in {}: {error}", source.display()))?;
    let manifest: PluginManifest = serde_json::from_value(raw.clone())
        .map_err(|error| format!("Invalid plugin.json in {}: {error}", source.display()))?;
    let title = raw
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let platform_supported = raw
        .get("platform")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|item| item == "darwin" || item == "macos")
        })
        .unwrap_or(true);
    let main_exists = manifest
        .main
        .as_deref()
        .is_some_and(|path| archive_entry_exists(&archive, path));
    let preload_exists = manifest
        .preload
        .as_deref()
        .map(|path| archive_entry_exists(&archive, path))
        .unwrap_or(true);
    let logo_exists = manifest
        .logo
        .as_deref()
        .map(|path| archive_entry_exists(&archive, path))
        .unwrap_or(true);
    let unsupported_cmd_types = unsupported_cmd_types(&manifest);
    let mut warnings = Vec::new();
    let mut errors = Vec::new();
    if !platform_supported {
        warnings.push("Plugin platform does not include darwin".to_string());
    }
    if !main_exists {
        errors.push("Missing main file".to_string());
    }
    if !preload_exists {
        warnings.push("Missing preload file".to_string());
    }
    if !logo_exists {
        warnings.push("Missing logo file".to_string());
    }
    if !unsupported_cmd_types.is_empty() {
        warnings.push(format!(
            "Unsupported command types: {}",
            unsupported_cmd_types.join(", ")
        ));
    }
    Ok(ZToolsImportCandidate {
        path: source.to_string_lossy().to_string(),
        source_type: archive_source_type(source).to_string(),
        name: manifest.name,
        title,
        version: manifest.version,
        features_count: manifest.features.len(),
        platform_supported,
        main_exists,
        preload_exists,
        logo_exists,
        unsupported_cmd_types,
        warnings,
        errors,
    })
}

fn read_manifest_from_source(source: &Path) -> Result<String, String> {
    if source.is_dir() {
        return fs::read_to_string(source.join("plugin.json")).map_err(|error| error.to_string());
    }
    let archive = read_archive(source)?;
    let bytes = read_archive_entry(source, &archive, Path::new("plugin.json"))?
        .ok_or_else(|| format!("Archive does not contain plugin.json: {}", source.display()))?;
    String::from_utf8(bytes.to_vec())
        .map_err(|error| format!("plugin.json is not UTF-8 in {}: {error}", source.display()))
}

fn stage_plugin_archive(source: &Path, install_dir: &Path) -> Result<PathBuf, String> {
    let parent = install_dir.parent().ok_or_else(|| {
        format!(
            "Plugin destination has no parent: {}",
            install_dir.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staged_dir = crate::commands::unique_plugin_sibling_path(install_dir, "stage")?;
    fs::create_dir(&staged_dir).map_err(|error| error.to_string())?;
    let result =
        read_archive(source).and_then(|archive| extract_archive(source, &archive, &staged_dir));
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staged_dir);
        return Err(error);
    }
    Ok(staged_dir)
}

fn is_supported_archive(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("zpx") || extension.eq_ignore_ascii_case("asar")
        })
}

fn archive_source_type(path: &Path) -> &'static str {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zpx"))
    {
        "zpx"
    } else {
        "asar"
    }
}

fn read_archive(source: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(source).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "ZTools plugin archive exceeds {} MiB: {}",
            MAX_ARCHIVE_BYTES / 1024 / 1024,
            source.display()
        ));
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    if archive_source_type(source) == "asar" {
        return Ok(bytes);
    }
    decompress_zpx(source, &bytes)
}

fn decompress_zpx(source: &Path, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let result = if bytes.starts_with(&[0x1f, 0x8b]) {
        flate2::read::GzDecoder::new(bytes)
            .take((MAX_EXTRACTED_BYTES + 1) as u64)
            .read_to_end(&mut output)
    } else {
        brotli::Decompressor::new(bytes, 4096)
            .take((MAX_EXTRACTED_BYTES + 1) as u64)
            .read_to_end(&mut output)
    };
    result.map_err(|error| format!("Invalid ZPX compression in {}: {error}", source.display()))?;
    if output.len() > MAX_EXTRACTED_BYTES {
        return Err(format!(
            "Expanded ZPX exceeds {} MiB: {}",
            MAX_EXTRACTED_BYTES / 1024 / 1024,
            source.display()
        ));
    }
    Ok(output)
}

struct ParsedAsar<'a> {
    bytes: &'a [u8],
    content_offset: usize,
    root: serde_json::Value,
}

fn parse_asar(archive: &[u8]) -> Result<ParsedAsar<'_>, String> {
    if archive.len() < 16 {
        return Err("Invalid ASAR archive: header is truncated".to_string());
    }
    let read_u32 = |offset: usize| {
        u32::from_le_bytes(
            archive[offset..offset + 4]
                .try_into()
                .expect("ASAR header offsets are bounds checked"),
        ) as usize
    };
    let marker = read_u32(0);
    let header_size = read_u32(4);
    let header_payload_size = read_u32(8);
    let json_size = read_u32(12);
    let json_end = 16usize
        .checked_add(json_size)
        .ok_or_else(|| "Invalid ASAR archive: JSON header overflows".to_string())?;
    let content_offset = header_size
        .checked_add(8)
        .ok_or_else(|| "Invalid ASAR archive: content offset overflows".to_string())?;
    if marker != 4
        || header_size < 8
        || header_payload_size.checked_add(4) != Some(header_size)
        || json_end > archive.len()
        || content_offset > archive.len()
        || json_end > content_offset
    {
        return Err("Invalid ASAR archive: header sizes are inconsistent".to_string());
    }
    let root = serde_json::from_slice(&archive[16..json_end])
        .map_err(|error| format!("Invalid ASAR JSON header: {error}"))?;
    Ok(ParsedAsar {
        bytes: archive,
        content_offset,
        root,
    })
}

fn asar_entry<'a>(
    parsed: &'a ParsedAsar<'_>,
    path: &Path,
) -> Result<Option<&'a serde_json::Value>, String> {
    validate_archive_path(path)?;
    let mut current = &parsed.root;
    for component in path.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(format!("Unsafe ASAR path: {}", path.display()));
        };
        current = current
            .get("files")
            .and_then(serde_json::Value::as_object)
            .and_then(|files| files.get(name.to_string_lossy().as_ref()))
            .ok_or_else(|| format!("ASAR entry is missing: {}", path.display()))?;
    }
    Ok(Some(current))
}

fn read_archive_entry<'a>(
    source: &Path,
    archive: &'a [u8],
    path: &Path,
) -> Result<Option<&'a [u8]>, String> {
    let parsed = parse_asar(archive)?;
    let Some(node) = asar_entry(&parsed, path)? else {
        return Ok(None);
    };
    if node.get("unpacked").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err(format!(
            "Required ASAR entry is external and cannot be read in place: {} ({})",
            path.display(),
            source.display()
        ));
    }
    packed_entry_data(&parsed, node, path).map(Some)
}

fn archive_entry_exists(archive: &[u8], value: &str) -> bool {
    let path = Path::new(value);
    validate_archive_path(path).is_ok()
        && parse_asar(archive)
            .ok()
            .and_then(|parsed| {
                asar_entry(&parsed, path)
                    .ok()
                    .flatten()
                    .filter(|node| node.get("link").is_none() && node.get("files").is_none())
                    .map(|_| ())
            })
            .is_some()
}

fn extract_archive(source: &Path, archive: &[u8], destination: &Path) -> Result<(), String> {
    let parsed = parse_asar(archive)
        .map_err(|error| format!("Invalid ASAR archive {}: {error}", source.display()))?;
    let mut entries = 0usize;
    let mut total_bytes = 0usize;
    extract_asar_entries(
        source,
        &parsed,
        &parsed.root,
        Path::new(""),
        destination,
        &mut entries,
        &mut total_bytes,
    )
}

#[allow(clippy::too_many_arguments)]
fn extract_asar_entries(
    source: &Path,
    parsed: &ParsedAsar<'_>,
    node: &serde_json::Value,
    relative: &Path,
    destination: &Path,
    entries: &mut usize,
    total_bytes: &mut usize,
) -> Result<(), String> {
    if let Some(files) = node.get("files").and_then(serde_json::Value::as_object) {
        if relative.components().count() > MAX_ARCHIVE_DEPTH {
            return Err(format!(
                "ASAR path depth exceeds limit: {}",
                relative.display()
            ));
        }
        if !relative.as_os_str().is_empty() {
            fs::create_dir_all(destination.join(relative)).map_err(|error| error.to_string())?;
        }
        for (name, child) in files {
            validate_archive_component(name)?;
            extract_asar_entries(
                source,
                parsed,
                child,
                &relative.join(name),
                destination,
                entries,
                total_bytes,
            )?;
        }
        return Ok(());
    }
    if node.get("link").is_some() {
        return Err(format!(
            "ASAR symbolic links are not supported: {}",
            relative.display()
        ));
    }

    *entries += 1;
    if *entries > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "ASAR contains more than {MAX_ARCHIVE_ENTRIES} entries"
        ));
    }
    validate_archive_path(relative)?;
    let declared_size = asar_entry_size(node, relative)?;
    if declared_size > MAX_ENTRY_BYTES {
        return Err(format!(
            "ASAR entry exceeds size limit: {}",
            relative.display()
        ));
    }
    let bytes = if node.get("unpacked").and_then(serde_json::Value::as_bool) == Some(true) {
        read_unpacked_archive_entry(source, relative)?
    } else {
        packed_entry_data(parsed, node, relative)?.to_vec()
    };
    if bytes.len() > MAX_ENTRY_BYTES {
        return Err(format!(
            "ASAR entry exceeds size limit: {}",
            relative.display()
        ));
    }
    *total_bytes = total_bytes.saturating_add(bytes.len());
    if *total_bytes > MAX_EXTRACTED_BYTES {
        return Err(format!(
            "ASAR expanded size exceeds {} MiB",
            MAX_EXTRACTED_BYTES / 1024 / 1024
        ));
    }
    let target = destination.join(relative);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    if node.get("executable").and_then(serde_json::Value::as_bool) == Some(true) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn packed_entry_data<'a>(
    parsed: &ParsedAsar<'a>,
    node: &serde_json::Value,
    path: &Path,
) -> Result<&'a [u8], String> {
    let size = asar_entry_size(node, path)?;
    let offset = node
        .get("offset")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| format!("ASAR entry has invalid offset: {}", path.display()))?;
    let start = parsed
        .content_offset
        .checked_add(offset)
        .ok_or_else(|| format!("ASAR entry offset overflows: {}", path.display()))?;
    let end = start
        .checked_add(size)
        .ok_or_else(|| format!("ASAR entry size overflows: {}", path.display()))?;
    parsed
        .bytes
        .get(start..end)
        .ok_or_else(|| format!("ASAR entry is truncated: {}", path.display()))
}

fn asar_entry_size(node: &serde_json::Value, path: &Path) -> Result<usize, String> {
    node.get("size")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("ASAR entry has invalid size: {}", path.display()))
}

fn read_unpacked_archive_entry(source: &Path, relative: &Path) -> Result<Vec<u8>, String> {
    if archive_source_type(source) == "zpx" {
        return Err(format!(
            "Compressed ZPX references an external unpacked entry: {}",
            relative.display()
        ));
    }
    validate_archive_path(relative)?;
    let unpacked_root = source.with_extension("asar.unpacked");
    let metadata = fs::symlink_metadata(&unpacked_root).map_err(|error| {
        format!(
            "Missing ASAR unpacked directory {}: {error}",
            unpacked_root.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Unsafe ASAR unpacked directory: {}",
            unpacked_root.display()
        ));
    }
    let target = unpacked_root.join(relative);
    let mut current = unpacked_root.clone();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "ASAR unpacked entry contains symlink: {}",
                current.display()
            ));
        }
    }
    let size = fs::metadata(&target)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_ENTRY_BYTES as u64 {
        return Err(format!(
            "ASAR unpacked entry exceeds size limit: {}",
            target.display()
        ));
    }
    fs::read(target).map_err(|error| error.to_string())
}

fn validate_archive_path(path: &Path) -> Result<(), String> {
    if path.is_absolute() || path.components().count() > MAX_ARCHIVE_DEPTH {
        return Err(format!("Unsafe ASAR path: {}", path.display()));
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                validate_archive_component(&value.to_string_lossy())?
            }
            _ => return Err(format!("Unsafe ASAR path: {}", path.display())),
        }
    }
    Ok(())
}

fn validate_archive_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(format!("Unsafe ASAR path component: {value:?}"));
    }
    Ok(())
}

fn unsupported_cmd_types(manifest: &PluginManifest) -> Vec<String> {
    for feature in &manifest.features {
        for cmd in &feature.cmds {
            if let Cmd::Typed(typed) = cmd {
                match typed.type_ {
                    CmdType::Regex
                    | CmdType::Over
                    | CmdType::Img
                    | CmdType::Files
                    | CmdType::Window => {}
                }
            }
        }
    }

    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn plugin_manifest() -> &'static [u8] {
        br#"{
          "name":"ztools-archive-fixture",
          "title":"Archive Fixture",
          "version":"3.0.1",
          "main":"index.html",
          "preload":"preload.js",
          "features":[{"code":"archive","explain":"Archive","cmds":["archive"]}]
        }"#
    }

    fn asar_fixture() -> Vec<u8> {
        build_asar(
            &[
                ("plugin.json", plugin_manifest()),
                ("index.html", b"<main>archive</main>"),
                ("preload.js", b"window.fixture = true"),
            ],
            None,
        )
    }

    fn build_asar(files: &[(&str, &[u8])], link: Option<(&str, &str)>) -> Vec<u8> {
        let mut offset = 0usize;
        let mut entries = serde_json::Map::new();
        let mut content = Vec::new();
        for (name, data) in files {
            entries.insert(
                (*name).to_string(),
                serde_json::json!({ "size": data.len(), "offset": offset.to_string() }),
            );
            offset += data.len();
            content.extend_from_slice(data);
        }
        if let Some((name, target)) = link {
            entries.insert(name.to_string(), serde_json::json!({ "link": target }));
        }
        let json = serde_json::to_vec(&serde_json::json!({ "files": entries })).unwrap();
        let aligned_size = (json.len() + 3) & !3;
        let mut archive = Vec::with_capacity(16 + aligned_size + content.len());
        archive.extend_from_slice(&4u32.to_le_bytes());
        archive.extend_from_slice(&((aligned_size + 8) as u32).to_le_bytes());
        archive.extend_from_slice(&((aligned_size + 4) as u32).to_le_bytes());
        archive.extend_from_slice(&(json.len() as u32).to_le_bytes());
        archive.extend_from_slice(&json);
        archive.resize(16 + aligned_size, 0);
        archive.extend_from_slice(&content);
        archive
    }

    #[test]
    fn scans_and_imports_asar_plugin() {
        let temp = TempDir::new().unwrap();
        let archive_path = temp.path().join("fixture.asar");
        fs::write(&archive_path, asar_fixture()).unwrap();

        let candidates = scan_ztools_plugin_candidates(&archive_path).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source_type, "asar");
        assert!(candidates[0].errors.is_empty());

        let db = atools_core::Database::in_memory().unwrap();
        let install_root = temp.path().join("installed");
        let report = import_ztools_plugins(
            &db,
            &install_root,
            &[archive_path.to_string_lossy().to_string()],
            true,
        )
        .unwrap();
        assert_eq!(report.imported, vec!["ztools-archive-fixture"]);
        let installed = install_root.join("ztools-archive-fixture");
        assert_eq!(
            fs::read(installed.join("index.html")).unwrap(),
            b"<main>archive</main>"
        );
        assert!(installed.join("plugin.json").is_file());
    }

    #[test]
    fn scans_gzip_and_brotli_zpx_plugins() {
        let temp = TempDir::new().unwrap();
        let asar = asar_fixture();

        let gzip_path = temp.path().join("gzip.zpx");
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&asar).unwrap();
        fs::write(&gzip_path, gzip.finish().unwrap()).unwrap();

        let brotli_path = temp.path().join("brotli.zpx");
        let mut brotli_bytes = Vec::new();
        {
            let mut encoder = brotli::CompressorWriter::new(&mut brotli_bytes, 4096, 5, 22);
            encoder.write_all(&asar).unwrap();
        }
        fs::write(&brotli_path, brotli_bytes).unwrap();

        for path in [gzip_path, brotli_path] {
            let candidates = scan_ztools_plugin_candidates(&path).unwrap();
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].source_type, "zpx");
            assert_eq!(candidates[0].name, "ztools-archive-fixture");
        }
    }

    #[test]
    fn rejects_asar_symbolic_links() {
        let temp = TempDir::new().unwrap();
        let archive_path = temp.path().join("linked.asar");
        fs::write(
            &archive_path,
            build_asar(
                &[
                    ("plugin.json", plugin_manifest()),
                    ("index.html", b"ok"),
                    ("preload.js", b"ok"),
                ],
                Some(("linked.js", "preload.js")),
            ),
        )
        .unwrap();

        let error =
            stage_plugin_archive(&archive_path, &temp.path().join("installed")).unwrap_err();
        assert!(error.contains("symbolic links"));
    }

    #[test]
    fn default_roots_include_ztools_3_plugins_directory() {
        assert!(default_ztools_plugin_roots()
            .iter()
            .any(|path| path.ends_with(Path::new(".ztools/plugins"))));
    }
}
