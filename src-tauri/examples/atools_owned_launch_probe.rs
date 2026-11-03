use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::ExitCode,
    thread,
    time::Duration,
};

const CONFIG_LIMIT: usize = 128;
const OWNER_MARKER_LIMIT: usize = 4096;
const RUN_ID_LENGTH: usize = 32;
const PROBE_LIFETIME: Duration = Duration::from_millis(125);

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(()) => ExitCode::FAILURE,
    }
}

fn run() -> Result<(), ()> {
    let executable = fs::canonicalize(env::current_exe().map_err(|_| ())?).map_err(|_| ())?;
    let contents = executable
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == "MacOS"))
        .and_then(Path::parent)
        .filter(|path| path.file_name().is_some_and(|name| name == "Contents"))
        .ok_or(())?;
    let bundle = contents.parent().ok_or(())?;
    let resources = contents.join("Resources");
    ensure_real_directory(contents)?;
    ensure_real_directory(&resources)?;

    let config_bytes = read_regular_nofollow(&resources.join("probe-config.txt"), CONFIG_LIMIT)?;
    let (run_id, probe_id) = parse_config(&config_bytes)?;
    let expected_bundle = format!(
        "AToolsOwnedProbe{}.app",
        if probe_id == "first" {
            "First"
        } else {
            "Second"
        }
    );
    if bundle.file_name().and_then(|name| name.to_str()) != Some(expected_bundle.as_str()) {
        return Err(());
    }

    let profile_root = find_owned_profile_root(bundle)?;
    let launcher_apps = fs::canonicalize(profile_root.join("launcher-apps")).map_err(|_| ())?;
    if bundle.parent() != Some(launcher_apps.as_path()) {
        return Err(());
    }

    let pid = std::process::id();
    let marker = format!(
        "{{\"schemaVersion\":1,\"runId\":\"{run_id}\",\"probeId\":\"{probe_id}\",\"pid\":{pid}}}\n"
    );
    write_new_marker(&resources.join("probe-started.json"), marker.as_bytes())?;
    thread::sleep(PROBE_LIFETIME);
    write_new_marker(&resources.join("probe-exiting.json"), marker.as_bytes())?;
    Ok(())
}

fn parse_config(bytes: &[u8]) -> Result<(String, String), ()> {
    if bytes.is_empty() || bytes.len() > CONFIG_LIMIT || bytes.last() != Some(&b'\n') {
        return Err(());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let mut lines = text.split_terminator('\n');
    let run_id = lines.next().ok_or(())?;
    let probe_id = lines.next().ok_or(())?;
    if lines.next().is_some()
        || run_id.len() != RUN_ID_LENGTH
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !matches!(probe_id, "first" | "second")
    {
        return Err(());
    }
    Ok((run_id.to_owned(), probe_id.to_owned()))
}

fn find_owned_profile_root(bundle: &Path) -> Result<PathBuf, ()> {
    let mut found = None;
    for candidate in bundle.ancestors().skip(1) {
        let marker = candidate.join(".atools-renderer-smoke-owner.json");
        if fs::symlink_metadata(&marker).is_ok_and(|metadata| metadata.file_type().is_file()) {
            found = Some((candidate.to_path_buf(), marker));
            break;
        }
    }
    let (root, marker) = found.ok_or(())?;
    let canonical_root = fs::canonicalize(&root).map_err(|_| ())?;
    if canonical_root != root {
        return Err(());
    }
    validate_temp_child(&canonical_root)?;

    let marker_bytes = read_regular_nofollow(&marker, OWNER_MARKER_LIMIT)?;
    let marker_text = std::str::from_utf8(&marker_bytes).map_err(|_| ())?;
    let expected_root = format!("\"root\":\"{}\"", canonical_root.display());
    if !marker_text.contains("\"schemaVersion\":1") || !marker_text.contains(&expected_root) {
        return Err(());
    }
    Ok(canonical_root)
}

fn validate_temp_child(root: &Path) -> Result<(), ()> {
    let parent = root.parent().ok_or(())?;
    let candidates = [env::temp_dir(), PathBuf::from("/private/tmp")];
    for candidate in candidates {
        if fs::canonicalize(candidate).is_ok_and(|canonical| canonical == parent) {
            return Ok(());
        }
    }
    Err(())
}

fn ensure_real_directory(path: &Path) -> Result<(), ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        Err(())
    }
}

fn read_regular_nofollow(path: &Path, limit: usize) -> Result<Vec<u8>, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.file_type().is_file() || metadata.len() > limit as u64 {
        return Err(());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() || opened.ino() != metadata.ino() || opened.len() > limit as u64 {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > limit {
        return Err(());
    }
    Ok(bytes)
}

fn write_new_marker(path: &Path, bytes: &[u8]) -> Result<(), ()> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file: File = options.open(path).map_err(|_| ())?;
    file.write_all(bytes).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())
}
