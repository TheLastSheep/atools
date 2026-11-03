use std::{
    env, fs,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde::Deserialize;

use super::profile::Profile;

const OWNER_MARKER_LIMIT: usize = 4 * 1024;
const OWNER_MARKER_NAME: &str = ".atools-renderer-smoke-owner.json";
const RESUME_PERMIT_NAME: &str = ".atools-builtin-state-resume-permit.json";
const RESUME_CLAIM_NAME: &str = ".atools-builtin-state-resume-claimed";
const HOTKEY_RESUME_PERMIT_NAME: &str = ".atools-main-hotkey-recovery-resume-permit.json";
const HOTKEY_RESUME_CLAIM_NAME: &str = ".atools-main-hotkey-recovery-resume-claimed";
const NOT_VERIFIED: &str = "fixture-owner-not-verified";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerMarker {
    schema_version: u64,
    pid: u64,
    identifier: String,
    root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResumePermit {
    schema_version: u64,
    journey: String,
    run_id: String,
    seed_pid: u64,
    identifier: String,
    root: String,
}

/// Verify the smoke profile's owner marker before using its fixture directory.
/// Catalog source path confinement remains separate from this profile binding.
pub(super) fn verify(profile: &Profile) -> Result<(), &'static str> {
    let path_metadata = fs::symlink_metadata(&profile.root).map_err(|_| NOT_VERIFIED)?;
    if !path_metadata.file_type().is_dir() {
        return Err(NOT_VERIFIED);
    }
    let root = fs::canonicalize(&profile.root).map_err(|_| NOT_VERIFIED)?;
    if root != profile.root || !is_allowed_temp_child(&root) {
        return Err(NOT_VERIFIED);
    }

    let bytes = read_regular_nofollow(&root.join(OWNER_MARKER_NAME), OWNER_MARKER_LIMIT)
        .map_err(|_| NOT_VERIFIED)?;
    let marker: OwnerMarker = serde_json::from_slice(&bytes).map_err(|_| NOT_VERIFIED)?;
    if marker.schema_version != 1
        || marker.pid != u64::from(std::process::id())
        || marker.identifier != profile.identifier
        || marker.root != root.to_string_lossy().into_owned()
    {
        return Err(NOT_VERIFIED);
    }
    Ok(())
}

/// Atomically hands the private fixture root from a terminal seed process to cold Main.
/// The old PID is accepted only when the OS confirms it no longer exists.
pub(super) fn resume_seed_profile(profile: &Profile, seed_pid: u32) -> Result<(), &'static str> {
    let root = checked_private_root(&profile.root)?;
    let expected_root = PathBuf::from("/private/tmp")
        .join(format!("atools-renderer-settings-input-{}", profile.run_id));
    let expected_identifier = format!("dev.atools.renderer-settings-input.{}", profile.run_id);
    if !profile.builtin_state_journey
        || profile.resume_seed_pid != Some(seed_pid)
        || root != expected_root
        || profile.identifier != expected_identifier
        || seed_pid == 0
        || seed_pid == std::process::id()
        || !pid_definitely_exited(seed_pid)
    {
        return Err(NOT_VERIFIED);
    }
    verify_private_child(&root.join("app-data"))?;
    verify_private_child(&root.join("webview"))?;

    let marker_path = root.join(OWNER_MARKER_NAME);
    let marker_before = read_private_file(&marker_path, OWNER_MARKER_LIMIT)?;
    let marker: OwnerMarker =
        serde_json::from_slice(&marker_before.bytes).map_err(|_| NOT_VERIFIED)?;
    if marker.schema_version != 1
        || marker.pid != u64::from(seed_pid)
        || marker.identifier != profile.identifier
        || marker.root != root.to_string_lossy().into_owned()
    {
        return Err(NOT_VERIFIED);
    }

    let permit_path = root.join(RESUME_PERMIT_NAME);
    let permit_file = read_private_file(&permit_path, OWNER_MARKER_LIMIT)?;
    let permit: ResumePermit =
        serde_json::from_slice(&permit_file.bytes).map_err(|_| NOT_VERIFIED)?;
    if permit.schema_version != 1
        || permit.journey != "builtin-state-resume"
        || permit.run_id != profile.run_id
        || permit.seed_pid != u64::from(seed_pid)
        || permit.identifier != profile.identifier
        || permit.root != root.to_string_lossy().into_owned()
    {
        return Err(NOT_VERIFIED);
    }

    let claim_path = root.join(RESUME_CLAIM_NAME);
    let mut claim = create_private_file(&claim_path).map_err(|_| NOT_VERIFIED)?;
    claim
        .write_all(profile.run_id.as_bytes())
        .and_then(|_| claim.sync_all())
        .map_err(|_| NOT_VERIFIED)?;

    // Recheck the old identities after claiming, so a swapped marker or permit cannot be used.
    if !pid_definitely_exited(seed_pid)
        || !same_file_identity(&marker_path, &marker_before.metadata)
        || !same_file_identity(&permit_path, &permit_file.metadata)
    {
        return Err(NOT_VERIFIED);
    }
    let replacement = serde_json::json!({
        "schemaVersion": 1,
        "pid": std::process::id(),
        "identifier": profile.identifier,
        "root": root.to_string_lossy(),
    });
    let bytes = serde_json::to_vec(&replacement).map_err(|_| NOT_VERIFIED)?;
    let temporary_path = root.join(format!(".owner-resume-{}.tmp", std::process::id()));
    let mut temporary = create_private_file(&temporary_path).map_err(|_| NOT_VERIFIED)?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.sync_all())
        .map_err(|_| NOT_VERIFIED)?;
    if !pid_definitely_exited(seed_pid)
        || !same_file_identity(&marker_path, &marker_before.metadata)
        || !same_file_identity(&permit_path, &permit_file.metadata)
    {
        let _ = fs::remove_file(&temporary_path);
        return Err(NOT_VERIFIED);
    }
    fs::rename(&temporary_path, &marker_path).map_err(|_| NOT_VERIFIED)?;
    if fs::remove_file(&permit_path).is_err() || verify(profile).is_err() {
        return Err(NOT_VERIFIED);
    }
    Ok(())
}

/// One-time handoff for the two-process hotkey recovery fixture; R39 uses separate permit names.
pub(super) fn resume_main_hotkey_profile(
    profile: &Profile,
    previous_pid: u32,
) -> Result<(), &'static str> {
    let root = checked_private_root(&profile.root)?;
    let expected_root = PathBuf::from("/private/tmp")
        .join(format!("atools-renderer-settings-input-{}", profile.run_id));
    let expected_identifier = format!("dev.atools.renderer-settings-input.{}", profile.run_id);
    if !profile.main_hotkey_recovery_second
        || profile.resume_hotkey_owner_pid != Some(previous_pid)
        || root != expected_root
        || profile.identifier != expected_identifier
        || previous_pid == 0
        || previous_pid == std::process::id()
        || !pid_definitely_exited(previous_pid)
    {
        return Err(NOT_VERIFIED);
    }
    verify_private_child(&root.join("app-data"))?;
    verify_private_child(&root.join("webview"))?;

    let marker_path = root.join(OWNER_MARKER_NAME);
    let marker_before = read_private_file(&marker_path, OWNER_MARKER_LIMIT)?;
    let marker: OwnerMarker =
        serde_json::from_slice(&marker_before.bytes).map_err(|_| NOT_VERIFIED)?;
    if marker.schema_version != 1
        || marker.pid != u64::from(previous_pid)
        || marker.identifier != profile.identifier
        || marker.root != root.to_string_lossy().into_owned()
    {
        return Err(NOT_VERIFIED);
    }

    let permit_path = root.join(HOTKEY_RESUME_PERMIT_NAME);
    let permit_file = read_private_file(&permit_path, OWNER_MARKER_LIMIT)?;
    let permit: ResumePermit =
        serde_json::from_slice(&permit_file.bytes).map_err(|_| NOT_VERIFIED)?;
    if permit.schema_version != 1
        || permit.journey != "main-hotkey-startup-recovery-resume"
        || permit.run_id != profile.run_id
        || permit.seed_pid != u64::from(previous_pid)
        || permit.identifier != profile.identifier
        || permit.root != root.to_string_lossy().into_owned()
    {
        return Err(NOT_VERIFIED);
    }

    let mut claim =
        create_private_file(&root.join(HOTKEY_RESUME_CLAIM_NAME)).map_err(|_| NOT_VERIFIED)?;
    claim
        .write_all(profile.run_id.as_bytes())
        .and_then(|_| claim.sync_all())
        .map_err(|_| NOT_VERIFIED)?;
    if !pid_definitely_exited(previous_pid)
        || !same_file_identity(&marker_path, &marker_before.metadata)
        || !same_file_identity(&permit_path, &permit_file.metadata)
    {
        return Err(NOT_VERIFIED);
    }

    let replacement = serde_json::json!({
        "schemaVersion": 1,
        "pid": std::process::id(),
        "identifier": profile.identifier,
        "root": root.to_string_lossy(),
    });
    let bytes = serde_json::to_vec(&replacement).map_err(|_| NOT_VERIFIED)?;
    let temporary_path = root.join(format!(".owner-hotkey-resume-{}.tmp", std::process::id()));
    let mut temporary = create_private_file(&temporary_path).map_err(|_| NOT_VERIFIED)?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.sync_all())
        .map_err(|_| NOT_VERIFIED)?;
    if !pid_definitely_exited(previous_pid)
        || !same_file_identity(&marker_path, &marker_before.metadata)
        || !same_file_identity(&permit_path, &permit_file.metadata)
    {
        let _ = fs::remove_file(&temporary_path);
        return Err(NOT_VERIFIED);
    }
    fs::rename(&temporary_path, &marker_path).map_err(|_| NOT_VERIFIED)?;
    if fs::remove_file(&permit_path).is_err() || verify(profile).is_err() {
        return Err(NOT_VERIFIED);
    }
    Ok(())
}

pub(super) fn main_hotkey_resume_claimed(profile: &Profile) -> bool {
    if !profile.main_hotkey_recovery_second || verify(profile).is_err() {
        return false;
    }
    let path = profile.root.join(HOTKEY_RESUME_CLAIM_NAME);
    let claim_valid = read_private_file(&path, 128).is_ok_and(|claim| {
        claim.bytes == profile.run_id.as_bytes() && same_file_identity(&path, &claim.metadata)
    });
    let permit_consumed = matches!(
        fs::symlink_metadata(profile.root.join(HOTKEY_RESUME_PERMIT_NAME)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    );
    claim_valid && permit_consumed
}

fn checked_private_root(path: &Path) -> Result<PathBuf, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| NOT_VERIFIED)?;
    if !metadata.file_type().is_dir() || private_mode(&metadata) != Some(0o700) {
        return Err(NOT_VERIFIED);
    }
    let root = fs::canonicalize(path).map_err(|_| NOT_VERIFIED)?;
    if root != path || !is_allowed_temp_child(&root) {
        return Err(NOT_VERIFIED);
    }
    Ok(root)
}

fn verify_private_child(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| NOT_VERIFIED)?;
    if !metadata.file_type().is_dir()
        || private_mode(&metadata) != Some(0o700)
        || fs::canonicalize(path)
            .map(|canonical| canonical != path)
            .unwrap_or(true)
    {
        return Err(NOT_VERIFIED);
    }
    Ok(())
}

struct PrivateFile {
    bytes: Vec<u8>,
    metadata: fs::Metadata,
}

fn read_private_file(path: &Path, limit: usize) -> Result<PrivateFile, &'static str> {
    let before = fs::symlink_metadata(path).map_err(|_| NOT_VERIFIED)?;
    if !before.file_type().is_file()
        || private_mode(&before) != Some(0o600)
        || before.nlink() != 1
        || before.len() > limit as u64
    {
        return Err(NOT_VERIFIED);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| NOT_VERIFIED)?;
    let opened = file.metadata().map_err(|_| NOT_VERIFIED)?;
    if !opened.is_file()
        || opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || opened.nlink() != 1
    {
        return Err(NOT_VERIFIED);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| NOT_VERIFIED)?;
    if bytes.len() > limit {
        return Err(NOT_VERIFIED);
    }
    Ok(PrivateFile {
        bytes,
        metadata: opened,
    })
}

fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

fn same_file_identity(path: &Path, expected: &fs::Metadata) -> bool {
    fs::symlink_metadata(path).is_ok_and(|actual| {
        actual.file_type().is_file()
            && actual.dev() == expected.dev()
            && actual.ino() == expected.ino()
            && actual.nlink() == 1
            && private_mode(&actual) == Some(0o600)
    })
}

fn private_mode(metadata: &fs::Metadata) -> Option<u32> {
    Some(metadata.permissions().mode() & 0o777)
}

fn pid_definitely_exited(pid: u32) -> bool {
    if pid == 0 || pid > libc::pid_t::MAX as u32 {
        return false;
    }
    // Signal 0 only asks the kernel whether the PID exists; it sends no signal.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

fn is_allowed_temp_child(root: &Path) -> bool {
    let Some(parent) = root.parent() else {
        return false;
    };
    [env::temp_dir(), PathBuf::from("/private/tmp")]
        .into_iter()
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .any(|candidate| candidate == parent)
}

fn read_regular_nofollow(path: &Path, limit: usize) -> Result<Vec<u8>, ()> {
    let before = fs::symlink_metadata(path).map_err(|_| ())?;
    if !before.file_type().is_file() || before.len() > limit as u64 {
        return Err(());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() || opened.dev() != before.dev() || opened.ino() != before.ino() {
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

#[cfg(test)]
#[path = "fixture_owner_tests.rs"]
mod tests;
