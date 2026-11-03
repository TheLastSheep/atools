//! Bounded regular-file snapshots and independently checked build output.
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;

pub(super) const FILE_LIMIT: u64 = 32 * 1024 * 1024;
const TREE_LIMIT: u64 = 128 * 1024 * 1024;
const ENTRY_LIMIT: usize = 4096;
const DEPTH_LIMIT: usize = 32;

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreeStats {
    pub entries: usize,
    pub bytes: u64,
}

#[cfg(unix)]
#[path = "staging_directory.rs"]
mod directory;
#[cfg(unix)]
pub(super) use directory::Directory;
#[cfg(unix)]
#[path = "staging_walk.rs"]
mod walk;
#[cfg(unix)]
#[path = "staging_workspace.rs"]
mod workspace;
#[cfg(unix)]
pub(super) use workspace::Workspace;
#[cfg(not(unix))]
pub(super) struct Workspace;

pub(super) fn canonical_file(path: &Path) -> Result<PathBuf, String> {
    no_link_components(path)?;
    let meta = fs::symlink_metadata(path).map_err(|_| "SourceBuildFileUnavailable")?;
    if !meta.is_file() {
        return Err("SourceBuildExpectedRegularFile".into());
    }
    path.canonicalize()
        .map_err(|_| "SourceBuildFileUnavailable".into())
}

pub(super) fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    no_link_components(path)?;
    if !fs::symlink_metadata(path)
        .map_err(|_| "SourceBuildDirectoryUnavailable")?
        .is_dir()
    {
        return Err("SourceBuildExpectedDirectory".into());
    }
    path.canonicalize()
        .map_err(|_| "SourceBuildDirectoryUnavailable".into())
}

fn no_link_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("SourceBuildUnsafePath".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part.as_os_str());
        if fs::symlink_metadata(&current)
            .map_err(|_| "SourceBuildPathUnavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("SourceBuildSymlinkRejected".into());
        }
    }
    Ok(())
}

pub(super) fn snapshot(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<TreeStats, String> {
    canonical_directory(source)?;
    fs::create_dir(destination).map_err(|_| "SourceBuildSnapshotCreateFailed")?;
    #[cfg(unix)]
    {
        return walk::tree(source, Some(destination), true, cancel, |_| {}).map(|(_, stats)| stats);
    }
    #[cfg(not(unix))]
    {
        Err("SourceBuildSandboxUnsupported".into())
    }
}

pub(super) fn verify_output(root: &Path, cancel: &AtomicBool) -> Result<TreeStats, String> {
    canonical_directory(root)?;
    #[cfg(unix)]
    {
        return walk::tree(root, None, false, cancel, |_| {}).map(|(_, stats)| stats);
    }
    #[cfg(not(unix))]
    {
        Err("SourceBuildSandboxUnsupported".into())
    }
}

pub(super) fn copy_output(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<TreeStats, String> {
    canonical_directory(source)?;
    fs::create_dir(destination).map_err(|_| "SourceBuildSnapshotCreateFailed")?;
    #[cfg(unix)]
    {
        return walk::tree(source, Some(destination), false, cancel, |_| {})
            .map(|(_, stats)| stats);
    }
    #[cfg(not(unix))]
    {
        Err("SourceBuildSandboxUnsupported".into())
    }
}

pub(super) fn source_digest(
    root: &Path,
    cancel: &AtomicBool,
) -> Result<(String, TreeStats), String> {
    canonical_directory(root)?;
    #[cfg(unix)]
    {
        return walk::tree(root, None, true, cancel, |_| {});
    }
    #[cfg(not(unix))]
    {
        Err("SourceBuildSandboxUnsupported".into())
    }
}

fn input_excluded(name: &std::ffi::OsStr) -> bool {
    let text = name.to_string_lossy();
    text == ".env"
        || text.starts_with(".env.")
        || text.starts_with(".yarnrc")
        || [
            "node_modules",
            ".npm-cache",
            ".git",
            "dist",
            "__atools_dist",
            ".npmrc",
            ".ssh",
            ".aws",
        ]
        .iter()
        .any(|excluded| name == *excluded)
}

fn hash_entry(digest: &mut Sha256, kind: u8, relative: &Path, bytes: &[u8]) {
    #[cfg(unix)]
    let path_bytes = {
        use std::os::unix::ffi::OsStrExt;
        relative.as_os_str().as_bytes().to_vec()
    };
    #[cfg(not(unix))]
    let path_bytes = relative.to_string_lossy().as_bytes().to_vec();
    digest.update([kind]);
    digest.update((path_bytes.len() as u64).to_le_bytes());
    digest.update(path_bytes);
    digest.update((bytes.len() as u64).to_le_bytes());
    digest.update(bytes);
}

pub(super) fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    read_file(open_no_follow(path)?, limit)
}

#[cfg(unix)]
pub(super) struct RegularFileSnapshot {
    pub bytes: Vec<u8>,
    identity: directory::Metadata,
}

#[cfg(unix)]
pub(super) fn read_relative_regular(
    root: &Directory,
    relative: &Path,
    limit: u64,
) -> Result<Option<RegularFileSnapshot>, String> {
    use std::path::Component;

    let parts = relative
        .components()
        .map(|part| match part {
            Component::Normal(name) => Ok(name),
            _ => Err("SourceBuildUnsafePath".to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some((last, parents)) = parts.split_last() else {
        return Err("SourceBuildUnsafePath".into());
    };
    let mut directory = root.duplicate()?;
    for name in parents {
        let name = *name;
        let Some(metadata) = directory.child_metadata_optional(name)? else {
            return Ok(None);
        };
        if directory::kind(&metadata) != libc::S_IFDIR {
            return Err("SourceBuildExpectedDirectory".into());
        }
        directory = directory.open_directory(name, Some(&metadata))?;
    }
    let last = *last;
    let Some(identity) = directory.child_metadata_optional(last)? else {
        return Ok(None);
    };
    if directory::kind(&identity) != libc::S_IFREG {
        return Err("SourceBuildExpectedRegularFile".into());
    }
    let file = directory.open_file(last, Some(&identity))?;
    Ok(Some(RegularFileSnapshot {
        bytes: read_file(file, limit)?,
        identity,
    }))
}

#[cfg(unix)]
pub(super) fn replace_relative_regular(
    root: &Directory,
    name: &std::ffi::OsStr,
    expected: &RegularFileSnapshot,
    bytes: &[u8],
) -> Result<(), String> {
    use std::ffi::OsString;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    if !root.is_same_child(name, &expected.identity)? {
        return Err("SourceBuildOutputManifestChanged".into());
    }
    let temporary: OsString = format!(
        ".atools-manifest-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    )
    .into();
    let mut file = root.create_file_exclusive(&temporary, 0o600)?;
    let temporary_identity = match root.file_metadata(&file) {
        Ok(identity) => identity,
        Err(error) => {
            drop(file);
            root.unlink(&temporary, false, None)
                .map_err(|_| "SOURCE_BUILD_CLEANUP_UNCONFIRMED")?;
            return Err(error);
        }
    };
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "SourceBuildOutputManifestTempWriteFailed".to_owned());
    drop(file);
    if let Err(error) = result {
        root.unlink(&temporary, false, Some(&temporary_identity))?;
        return Err(error);
    }
    let still_current = root
        .is_same_child(name, &expected.identity)
        .and_then(|manifest| {
            root.is_same_child(&temporary, &temporary_identity)
                .map(|temporary| manifest && temporary)
        });
    match still_current {
        Ok(true) => {}
        Ok(false) => {
            root.unlink(&temporary, false, Some(&temporary_identity))?;
            return Err("SourceBuildOutputManifestChanged".into());
        }
        Err(error) => {
            root.unlink(&temporary, false, Some(&temporary_identity))?;
            return Err(error);
        }
    }
    if let Err(error) = root.rename_child(&temporary, name) {
        root.unlink(&temporary, false, Some(&temporary_identity))?;
        return Err(error);
    }
    root.sync()
}

fn read_file(file: File, limit: u64) -> Result<Vec<u8>, String> {
    let meta = file
        .metadata()
        .map_err(|_| "SourceBuildMetadataReadFailed")?;
    if !meta.is_file() || meta.len() > limit {
        return Err("SourceBuildFileLimitExceeded".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("SourceBuildHardlinkRejected".into());
        }
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "SourceBuildFileReadFailed")?;
    if bytes.len() as u64 > limit {
        return Err("SourceBuildFileLimitExceeded".into());
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> Result<File, String> {
    use std::os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    };
    if !path.is_absolute() {
        return Err("SourceBuildUnsafePath".into());
    }
    let parts = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(Ok(part)),
            Component::RootDir => None,
            _ => Some(Err("SourceBuildUnsafePath")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let root = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root < 0 {
        return Err("SourceBuildFileReadFailed".into());
    }
    let mut directory = unsafe { OwnedFd::from_raw_fd(root) };
    for (index, part) in parts.iter().enumerate() {
        let name = std::ffi::CString::new(part.as_bytes()).map_err(|_| "SourceBuildUnsafePath")?;
        let final_part = index + 1 == parts.len();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if final_part {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err("SourceBuildFileReadFailed".into());
        }
        if final_part {
            return Ok(unsafe { File::from_raw_fd(fd) });
        }
        directory = unsafe { OwnedFd::from_raw_fd(fd) };
    }
    Err("SourceBuildExpectedRegularFile".into())
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> Result<File, String> {
    no_link_components(path)?;
    File::open(path).map_err(|_| "SourceBuildFileReadFailed".into())
}

#[cfg(all(test, unix))]
#[path = "staging_race_tests.rs"]
mod race_tests;
#[cfg(all(test, unix))]
#[path = "staging_tests.rs"]
mod tests;
