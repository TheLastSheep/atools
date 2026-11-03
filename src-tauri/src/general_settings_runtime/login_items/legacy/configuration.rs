use serde::{Deserialize, Serialize};
#[cfg(unix)]
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

#[cfg(unix)]
use super::super::UNAVAILABLE;
#[cfg(not(unix))]
use super::super::UNSUPPORTED;

const MAX_CONFIGURATION_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct FileIdentity {
    pub(super) device: u64,
    pub(super) inode: u64,
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) mode: u32,
    pub(super) length: u64,
    pub(super) mtime_seconds: i64,
    pub(super) mtime_nanoseconds: i64,
    pub(super) ctime_seconds: i64,
    pub(super) ctime_nanoseconds: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ValidatedConfiguration {
    pub(super) source: PathBuf,
    pub(super) executable: PathBuf,
    pub(super) identity: FileIdentity,
    pub(super) sha256: String,
    pub(super) bytes: Vec<u8>,
}

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPlist {
    #[serde(rename = "Label")]
    label: String,
    #[serde(rename = "RunAtLoad")]
    run_at_load: bool,
    #[serde(default, rename = "Program")]
    program: Option<String>,
    #[serde(default, rename = "ProgramArguments")]
    program_arguments: Option<Vec<String>>,
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ParentIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}

#[cfg(unix)]
pub(super) fn inspect(
    path: &Path,
    expected_label: &str,
    expected_executable: &Path,
) -> Result<Option<ValidatedConfiguration>, &'static str> {
    let (parent, parent_before) = validate_parent(path)?;
    let executable = canonical_executable(expected_executable)?;
    let source_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let (parent_after, identity_after) = validate_parent(path)?;
            if parent_after != parent || identity_after != parent_before {
                return Err(UNAVAILABLE);
            }
            return Ok(None);
        }
        Err(_) => return Err(UNAVAILABLE),
    };
    validate_source_metadata(&source_metadata)?;
    if path.canonicalize().map_err(|_| UNAVAILABLE)? != path {
        return Err(UNAVAILABLE);
    }
    let identity = FileIdentity::from_metadata(&source_metadata);

    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| UNAVAILABLE)?;
    let descriptor_before = file.metadata().map_err(|_| UNAVAILABLE)?;
    validate_source_metadata(&descriptor_before)?;
    if FileIdentity::from_metadata(&descriptor_before) != identity {
        return Err(UNAVAILABLE);
    }

    let mut bytes = Vec::with_capacity(identity.length as usize);
    let mut bounded = (&mut file).take(MAX_CONFIGURATION_BYTES + 1);
    bounded.read_to_end(&mut bytes).map_err(|_| UNAVAILABLE)?;
    drop(bounded);
    if bytes.is_empty()
        || bytes.len() as u64 > MAX_CONFIGURATION_BYTES
        || bytes.len() as u64 != identity.length
    {
        return Err(UNAVAILABLE);
    }

    let descriptor_after = file.metadata().map_err(|_| UNAVAILABLE)?;
    validate_source_metadata(&descriptor_after)?;
    let path_after = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    validate_source_metadata(&path_after)?;
    let (parent_after_path, parent_after) = validate_parent(path)?;
    if parent_after_path != parent
        || parent_after != parent_before
        || FileIdentity::from_metadata(&descriptor_after) != identity
        || FileIdentity::from_metadata(&path_after) != identity
    {
        return Err(UNAVAILABLE);
    }

    let parsed: LegacyPlist = plist::from_bytes(&bytes).map_err(|_| UNAVAILABLE)?;
    validate_plist(parsed, expected_label, &executable)?;

    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(Some(ValidatedConfiguration {
        source: path.to_path_buf(),
        executable,
        identity,
        sha256,
        bytes,
    }))
}

#[cfg(not(unix))]
pub(super) fn inspect(
    _path: &Path,
    _expected_label: &str,
    _expected_executable: &Path,
) -> Result<Option<ValidatedConfiguration>, &'static str> {
    Err(UNSUPPORTED)
}

#[cfg(unix)]
impl FileIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode(),
            length: metadata.len(),
            mtime_seconds: metadata.mtime(),
            mtime_nanoseconds: metadata.mtime_nsec(),
            ctime_seconds: metadata.ctime(),
            ctime_nanoseconds: metadata.ctime_nsec(),
        }
    }

    /// Compares metadata preserved by rename, not a complete validation.
    /// Callers must also verify nlink, original bytes/hash, valid paths, and source absence.
    pub(super) fn preserved_metadata_after_rename(&self, other: &Self) -> bool {
        self.device == other.device
            && self.inode == other.inode
            && self.uid == other.uid
            && self.gid == other.gid
            && self.mode == other.mode
            && self.length == other.length
            && self.mtime_seconds == other.mtime_seconds
            && self.mtime_nanoseconds == other.mtime_nanoseconds
    }
}

#[cfg(unix)]
fn validate_parent(path: &Path) -> Result<(PathBuf, ParentIdentity), &'static str> {
    if !path.is_absolute() || has_dot_components(path) {
        return Err(UNAVAILABLE);
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or(UNAVAILABLE)?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| UNAVAILABLE)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o022 != 0
        || parent.canonicalize().map_err(|_| UNAVAILABLE)? != parent
    {
        return Err(UNAVAILABLE);
    }
    Ok((
        parent.to_path_buf(),
        ParentIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode(),
        },
    ))
}

#[cfg(unix)]
fn canonical_executable(path: &Path) -> Result<PathBuf, &'static str> {
    if !path.is_absolute()
        || has_dot_components(path)
        || path.canonicalize().map_err(|_| UNAVAILABLE)? != path
    {
        return Err(UNAVAILABLE);
    }
    validate_executable(path)?;
    Ok(path.to_path_buf())
}

#[cfg(unix)]
fn validate_executable(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.mode() & 0o111 == 0 {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(unix)]
fn validate_supplied_executable(path: &str, expected: &Path) -> Result<(), &'static str> {
    let supplied = Path::new(path);
    if !supplied.is_absolute() || has_dot_components(supplied) {
        return Err(UNAVAILABLE);
    }
    let resolved = supplied.canonicalize().map_err(|_| UNAVAILABLE)?;
    if resolved != expected {
        return Err(UNAVAILABLE);
    }
    validate_executable(&resolved)
}

#[cfg(unix)]
fn validate_source_metadata(metadata: &std::fs::Metadata) -> Result<(), &'static str> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o7000 != 0
        || metadata.mode() & 0o022 != 0
        || metadata.len() == 0
        || metadata.len() > MAX_CONFIGURATION_BYTES
    {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(unix)]
fn validate_plist(
    plist: LegacyPlist,
    expected_label: &str,
    expected_executable: &Path,
) -> Result<(), &'static str> {
    if plist.label != expected_label || !plist.run_at_load {
        return Err(UNAVAILABLE);
    }
    let mut found_executable = false;
    if let Some(program) = plist.program {
        validate_supplied_executable(&program, expected_executable)?;
        found_executable = true;
    }
    if let Some(arguments) = plist.program_arguments {
        if arguments.len() != 1 {
            return Err(UNAVAILABLE);
        }
        validate_supplied_executable(&arguments[0], expected_executable)?;
        found_executable = true;
    }
    if !found_executable {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(unix)]
fn has_dot_components(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str()
        .as_bytes()
        .split(|byte| *byte == b'/')
        .any(|component| component == b"." || component == b"..")
}

#[cfg(all(test, unix))]
#[path = "configuration_tests.rs"]
mod tests;
