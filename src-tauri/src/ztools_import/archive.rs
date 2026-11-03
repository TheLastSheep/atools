//! Bounded regular archive I/O, ZPX decompression and safe ASAR staging.
use super::{
    zip, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_DEPTH, MAX_ARCHIVE_ENTRIES, MAX_ENTRY_BYTES,
    MAX_EXTRACTED_BYTES,
};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(super) fn stage_plugin_archive(source: &Path, install_dir: &Path) -> Result<PathBuf, String> {
    let parent = install_dir.parent().ok_or_else(|| {
        format!(
            "Plugin destination has no parent: {}",
            install_dir.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staged_dir = crate::commands::unique_plugin_sibling_path(install_dir, "stage")?;
    fs::create_dir(&staged_dir).map_err(|error| error.to_string())?;
    let result = if archive_source_type(source) == "zip" {
        zip::extract(source, &staged_dir)
    } else {
        read_archive(source).and_then(|archive| extract_archive(source, &archive, &staged_dir))
    };
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staged_dir);
        return Err(error);
    }
    Ok(staged_dir)
}

pub(super) fn is_supported_archive(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("zpx")
                || extension.eq_ignore_ascii_case("asar")
                || extension.eq_ignore_ascii_case("zip")
        })
}

pub(super) fn archive_source_type(path: &Path) -> &'static str {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return "zip";
    }
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

pub(super) fn read_archive_bytes(source: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "ZTools plugin archive must be a regular file within {} MiB: {}",
            MAX_ARCHIVE_BYTES / 1024 / 1024,
            source.display()
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(source).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() {
        return Err("Plugin archive is not a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err("Plugin archive changed while opening".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("Plugin archive exceeded read budget".into());
    }
    Ok(bytes)
}

pub(super) fn read_archive(source: &Path) -> Result<Vec<u8>, String> {
    let bytes = read_archive_bytes(source)?;
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

pub(super) struct ParsedAsar<'a> {
    pub(super) bytes: &'a [u8],
    pub(super) content_offset: usize,
    pub(super) root: serde_json::Value,
}

pub(super) fn parse_asar(archive: &[u8]) -> Result<ParsedAsar<'_>, String> {
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

pub(super) fn asar_entry<'a>(
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

pub(super) fn packed_entry_data<'a>(
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

pub(super) fn read_unpacked_archive_entry(
    source: &Path,
    relative: &Path,
) -> Result<Vec<u8>, String> {
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
    // Resolve only the parent, keeping the selected unpacked root itself visible to
    // the no-follow reader even if it is replaced after the metadata check above.
    let parent = unpacked_root
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let root = parent
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join(
            unpacked_root
                .file_name()
                .ok_or("Invalid ASAR unpacked root")?,
        );
    atools_plugin::package_resolution::read_package_asset_bytes(&root, relative, MAX_ENTRY_BYTES)
        .map_err(|error| format!("Unsafe or oversized ASAR unpacked entry: {error}"))?
        .ok_or_else(|| format!("Missing ASAR unpacked entry: {}", relative.display()))
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
