//! Fixed-source and private-root setup for the opt-in native pipeline fixture.
use super::case::{self, SourceCase};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};

pub(super) struct Fixture {
    pub(super) case: SourceCase,
    pub root: PathBuf,
    pub cache: PathBuf,
    pub app_data: PathBuf,
    pub report: PathBuf,
    pub source: PathBuf,
    pub source_manifest_sha256: String,
    pub source_inventory_sha256: String,
    pub source_bytes: u64,
    pub source_files: usize,
    pub source_revision_before: String,
    pub retain_converted_handoff: bool,
}

pub(super) fn prepare(args: &[String]) -> Result<Fixture, String> {
    let source_case = case::case_from_args(args).map_err(str::to_owned)?;
    let retain_converted_handoff = optional_flag(args, "--retain-converted-handoff")?;
    let root = canonical_fresh_child(argument(args, "--fixture-root")?)?;
    let report = canonical_fresh_child(argument(args, "--output")?)?;
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if root.parent() != Some(Path::new("/private/tmp"))
        || !root_name.starts_with("atools-batch235-")
    {
        return Err("Fixture root must be under the fixed private scratch prefix".into());
    }
    let report_name = report
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if report.parent() != Some(Path::new("/private/tmp"))
        || !report_name.starts_with("atools-batch235-")
    {
        return Err("Report must be a fresh file under the fixed private scratch prefix".into());
    }
    let source = PathBuf::from(source_case.source_root);
    let (manifest_sha, inventory_sha, files, bytes) = verify_fixed_source(source_case, &source)?;
    let canonical_source =
        fs::canonicalize(&source).map_err(|_| "Fixed-HEAD source root is unavailable")?;
    if canonical_source != source {
        return Err("Fixed-HEAD source root must not resolve through an alias".into());
    }
    if fs::symlink_metadata(&root).is_ok() {
        return Err("Fixture root must be fresh".into());
    }
    fs::create_dir(&root).map_err(|_| "Fixture root must be fresh")?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Fixture root permissions could not be set")?;
    validate_report_path(&root, &report)?;
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let (source_revision_before, stats) =
        super::super::super::staging::source_digest(&source, &cancelled)?;
    if stats.entries == 0 || stats.bytes != source_case.source_bytes {
        return Err("Pinned source digest inventory differs from the fixed HEAD manifest".into());
    }

    let cache = root.join("app-cache");
    let app_data = root.join("app-data");
    fs::create_dir(&cache).map_err(|_| "Private cache root could not be created")?;
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Private cache permissions could not be set")?;
    if fs::symlink_metadata(&app_data).is_ok() {
        return Err("Private app-data root must not already exist".into());
    }
    Ok(Fixture {
        case: source_case,
        root,
        cache,
        app_data,
        report,
        source,
        source_manifest_sha256: manifest_sha,
        source_inventory_sha256: inventory_sha,
        source_bytes: bytes,
        source_files: files,
        source_revision_before,
        retain_converted_handoff,
    })
}

pub(super) fn verify_fixed_source(
    case: SourceCase,
    root: &Path,
) -> Result<(String, String, usize, u64), String> {
    if root != Path::new(case.source_root) {
        return Err("Only a catalogued fixed-HEAD source root is accepted".into());
    }
    let manifest_path = Path::new(case.source_manifest_path);
    if fs::canonicalize(manifest_path).ok().as_deref() != Some(manifest_path) {
        return Err("Fixed-HEAD manifest path must not resolve through an alias".into());
    }
    let manifest_bytes = read_regular(manifest_path, 2 * 1024 * 1024)?;
    let manifest_sha = sha256(&manifest_bytes);
    if manifest_sha != case.source_manifest_sha256 {
        return Err("Fixed-HEAD source manifest pin mismatch".into());
    }
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "Fixed-HEAD source manifest is invalid")?;
    case::validate_inventory_metadata(case, &root.to_string_lossy(), &manifest)
        .map_err(str::to_owned)?;
    let sources = manifest
        .get("sources")
        .and_then(Value::as_object)
        .ok_or("Fixed-HEAD source inventory is missing")?;
    let mut total = 0u64;
    let mut plugin_manifest_seen = false;
    for (relative, entry) in sources {
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            || relative.contains('\\')
        {
            return Err("Fixed-HEAD source has an invalid relative path".into());
        }
        let path = root.join(relative_path);
        let bytes = read_regular(&path, 64 * 1024 * 1024)?;
        let expected_len = entry
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or("Fixed-HEAD source entry length is invalid")?;
        let expected_sha = entry
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|value| value.len() == 64)
            .ok_or("Fixed-HEAD source entry hash is invalid")?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or("Fixed-HEAD source byte count overflow")?;
        if bytes.len() as u64 != expected_len || sha256(&bytes) != expected_sha {
            return Err("Fixed-HEAD source file pin mismatch".into());
        }
        if relative == case.plugin_manifest_path {
            if expected_sha != case.plugin_manifest_sha256 {
                return Err("Fixed-HEAD plugin manifest inventory pin mismatch".into());
            }
            case::validate_plugin_manifest(case, &bytes).map_err(str::to_owned)?;
            plugin_manifest_seen = true;
        }
    }
    if !plugin_manifest_seen || total != case.source_bytes {
        return Err("Fixed-HEAD source inventory is incomplete".into());
    }
    Ok((
        manifest_sha,
        case.inventory_sha256.into(),
        sources.len(),
        total,
    ))
}

pub(super) fn write_report(path: &Path, report: &Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(report).map_err(|_| "Smoke report could not be encoded")?;
    if bytes.len() > 256 * 1024 {
        return Err("Smoke report exceeded its 256 KiB limit".into());
    }
    let mut options = fs::OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    use std::io::Write;
    let mut file = options
        .open(path)
        .map_err(|_| "Smoke report path must be fresh")?;
    file.write_all(&bytes)
        .map_err(|_| "Smoke report could not be written")?;
    file.sync_all()
        .map_err(|_| "Smoke report could not be synced".to_string())
}

fn optional_flag(args: &[String], flag: &str) -> Result<bool, String> {
    let positions = args
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (value == flag).then_some(index))
        .collect::<Vec<_>>();
    if positions.len() > 1 {
        return Err(format!("{flag} must be provided at most once"));
    }
    if positions.first().is_some_and(|index| {
        args.get(*index + 1)
            .is_some_and(|value| !value.starts_with("--"))
    }) {
        return Err(format!("{flag} is a standalone opt-in flag"));
    }
    Ok(!positions.is_empty())
}

fn argument(args: &[String], key: &str) -> Result<PathBuf, String> {
    let positions = args
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (value == key).then_some(index))
        .collect::<Vec<_>>();
    if positions.len() != 1 {
        return Err(format!("{key} must be provided exactly once"));
    }
    let path = args
        .get(positions[0] + 1)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {key}"))?;
    if path.to_string_lossy().len() > 4096 || path.to_string_lossy().contains('\0') {
        return Err("Fixture path is invalid".into());
    }
    Ok(path)
}

fn validate_report_path(root: &Path, report: &Path) -> Result<(), String> {
    if fs::symlink_metadata(report).is_ok() || report.parent().is_none() {
        return Err("Smoke report must be a fresh path".into());
    }
    let parent =
        fs::canonicalize(report.parent().unwrap()).map_err(|_| "Smoke report parent must exist")?;
    if parent.starts_with(root) {
        return Err("Smoke report must be outside the private fixture root".into());
    }
    Ok(())
}

fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::os::unix::fs::MetadataExt;
    let mut options = fs::OpenOptions::new();
    options.read(true).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|_| "Pinned source file is unavailable")?;
    let before = file
        .metadata()
        .map_err(|_| "Pinned source file is unavailable")?;
    if !before.is_file() || before.len() > limit {
        return Err("Pinned source file is not a bounded regular file".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Pinned source file could not be read")?;
    let after = file
        .metadata()
        .map_err(|_| "Pinned source file changed while reading")?;
    let unchanged = before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec();
    if bytes.len() as u64 > limit || bytes.len() as u64 != before.len() || !unchanged {
        return Err("Pinned source file changed while reading".into());
    }
    Ok(bytes)
}

fn canonical_fresh_child(path: PathBuf) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Fixture path must have a parent")?;
    let name = path
        .file_name()
        .ok_or("Fixture path must name a file or directory")?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| "Fixture path parent must already exist")?;
    let canonical = canonical_parent.join(name);
    if !path.is_absolute() || path != canonical || name == "." || name == ".." {
        return Err("Fixture path must be a canonical absolute child path".into());
    }
    Ok(canonical)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
