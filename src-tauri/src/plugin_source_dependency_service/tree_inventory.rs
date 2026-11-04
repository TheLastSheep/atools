//! Host-owned bounded digest of the materialized dependency tree.
//! The host receipt itself is excluded to avoid a self-referential digest.
use super::super::staging::Directory;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    os::unix::ffi::OsStrExt,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const FILE_LIMIT: u64 = 32 * 1024 * 1024;
// Dependency stage, including its worker manifest, is capped at 512 MiB.
// Inferred parent directories can add at most
// package_count * path_depth beyond the archive-entry cap.
const TREE_LIMIT: u64 = 512 * 1024 * 1024;
const ENTRY_LIMIT: u64 = 65_536 + 4096 * 32 + 1;
const PATH_BYTES_LIMIT: u64 = 4 * 1024 * 1024;
const DEPTH_LIMIT: usize = 32;
const IO_CHUNK: usize = 64 * 1024;
const WALK_LIMIT: Duration = Duration::from_secs(120);
const HOST_RECEIPT: &str = ".atools-host-receipt-v1.json";
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_FILE_LIMIT: u64 = 64;
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_DIRECTORY_LIMIT: u64 = 64;
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_ENTRY_LIMIT: u64 = 128;
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_FILE_BYTES_LIMIT: u64 = 8 * 1024 * 1024;
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_TREE_BYTES_LIMIT: u64 = 32 * 1024 * 1024;
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_PATH_BYTES_LIMIT: u64 = 2048 * PACKAGE_ENTRY_LIMIT;
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_DEPTH_LIMIT: usize = 16;

#[derive(Clone, Copy)]
struct Limits {
    file_bytes: u64,
    tree_bytes: u64,
    files: u64,
    directories: u64,
    entries: u64,
    path_bytes: u64,
    max_entry_path_bytes: u64,
    depth: usize,
    ignore_host_receipt: bool,
}

const DEPENDENCY_LIMITS: Limits = Limits {
    file_bytes: FILE_LIMIT,
    tree_bytes: TREE_LIMIT,
    files: u64::MAX,
    directories: u64::MAX,
    entries: ENTRY_LIMIT,
    path_bytes: PATH_BYTES_LIMIT,
    max_entry_path_bytes: PATH_BYTES_LIMIT,
    depth: DEPTH_LIMIT,
    ignore_host_receipt: true,
};
#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
const PACKAGE_LIMITS: Limits = Limits {
    file_bytes: PACKAGE_FILE_BYTES_LIMIT,
    tree_bytes: PACKAGE_TREE_BYTES_LIMIT,
    files: PACKAGE_FILE_LIMIT,
    directories: PACKAGE_DIRECTORY_LIMIT,
    entries: PACKAGE_ENTRY_LIMIT,
    path_bytes: PACKAGE_PATH_BYTES_LIMIT,
    max_entry_path_bytes: 2048,
    depth: PACKAGE_DEPTH_LIMIT,
    ignore_host_receipt: false,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TreeInventory {
    pub sha256: String,
    pub entries: u64,
    pub files: u64,
    pub bytes: u64,
}

#[cfg(test)]
pub(super) fn calculate(root: &Directory, cancelled: &AtomicBool) -> Result<TreeInventory, String> {
    calculate_since(root, cancelled, Instant::now())
}

#[cfg(any(
    test,
    feature = "legacy-node-smoke",
    feature = "source-dependency-smoke"
))]
pub(super) fn calculate_package(root: &Directory) -> Result<TreeInventory, String> {
    calculate_with_limits(
        root,
        &AtomicBool::new(false),
        Instant::now(),
        PACKAGE_LIMITS,
    )
}

pub(super) fn calculate_since(
    root: &Directory,
    cancelled: &AtomicBool,
    started: Instant,
) -> Result<TreeInventory, String> {
    calculate_with_limits(root, cancelled, started, DEPENDENCY_LIMITS)
}

fn calculate_with_limits(
    root: &Directory,
    cancelled: &AtomicBool,
    started: Instant,
    limits: Limits,
) -> Result<TreeInventory, String> {
    let root_identity = root.metadata()?;
    let mut state = State {
        digest: Sha256::new(),
        inventory: TreeInventory {
            sha256: String::new(),
            entries: 0,
            files: 0,
            bytes: 0,
        },
        path_bytes: 0,
        directories: 0,
        limits,
    };
    visit(root, &mut PathBuf::new(), 0, cancelled, started, &mut state)?;
    if !same_dir_meta(&root_identity, &root.metadata()?) {
        return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
    }
    state.inventory.sha256 = hex(&state.digest.finalize());
    Ok(state.inventory)
}

struct State {
    digest: Sha256,
    inventory: TreeInventory,
    path_bytes: u64,
    directories: u64,
    limits: Limits,
}

fn visit(
    directory: &Directory,
    relative: &mut PathBuf,
    depth: usize,
    cancelled: &AtomicBool,
    started: Instant,
    state: &mut State,
) -> Result<(), String> {
    check(cancelled, started)?;
    if depth > state.limits.depth {
        return Err("SOURCE_DEPENDENCY_TREE_LIMIT".into());
    }
    let dir_meta = directory.metadata()?;
    if dir_meta.st_uid != unsafe { libc::geteuid() }
        || dir_meta.st_mode & libc::S_IFMT != libc::S_IFDIR
        || dir_meta.st_mode & 0o7022 != 0
    {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let allowance = state
        .limits
        .entries
        .saturating_sub(state.inventory.entries)
        .saturating_add(if depth == 0 { 1 } else { 0 });
    let names = directory.names(allowance as usize)?;
    for name in names.iter() {
        let name = name.as_os_str();
        check(cancelled, started)?;
        if state.limits.ignore_host_receipt && depth == 0 && name == OsStr::new(HOST_RECEIPT) {
            continue;
        }
        validate_name(name)?;
        state.inventory.entries = state
            .inventory
            .entries
            .checked_add(1)
            .ok_or("SOURCE_DEPENDENCY_TREE_LIMIT")?;
        if state.inventory.entries > state.limits.entries {
            return Err("SOURCE_DEPENDENCY_TREE_LIMIT".into());
        }
        relative.push(name);
        let path_bytes = relative.as_os_str().as_bytes().to_vec();
        let path_total = state
            .path_bytes
            .checked_add(path_bytes.len() as u64)
            .ok_or("SOURCE_DEPENDENCY_TREE_LIMIT")?;
        if path_total > state.limits.path_bytes
            || path_bytes.len() as u64 > state.limits.max_entry_path_bytes
        {
            return Err("SOURCE_DEPENDENCY_TREE_LIMIT".into());
        }
        state.path_bytes = path_total;
        match directory.child_metadata(name)? {
            meta if meta.st_mode & libc::S_IFMT == libc::S_IFDIR => {
                if meta.st_uid != unsafe { libc::geteuid() } || meta.st_mode & 0o7022 != 0 {
                    return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
                }
                let child = directory.open_directory(name, Some(&meta))?;
                state.directories = state
                    .directories
                    .checked_add(1)
                    .ok_or("SOURCE_DEPENDENCY_TREE_LIMIT")?;
                if state.directories > state.limits.directories {
                    return Err("SOURCE_DEPENDENCY_TREE_LIMIT".into());
                }
                hash_entry(&mut state.digest, b'd', &path_bytes, 0);
                visit(&child, relative, depth + 1, cancelled, started, state)?;
                if !directory.is_same_child(name, &meta)? {
                    return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
                }
            }
            meta if meta.st_mode & libc::S_IFMT == libc::S_IFREG => {
                if meta.st_uid != unsafe { libc::geteuid() }
                    || meta.st_nlink != 1
                    || meta.st_mode & 0o7000 != 0
                    || meta.st_mode & 0o022 != 0
                    || meta.st_size < 0
                    || meta.st_size as u64 > state.limits.file_bytes
                {
                    return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
                }
                let mut file = directory.open_file(name, Some(&meta))?;
                let before = file.metadata().map_err(|_| "SOURCE_DEPENDENCY_SET_READ")?;
                if !same_stat_file_meta(&meta, &before) {
                    return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
                }
                let length = before.len();
                state.inventory.files = state
                    .inventory
                    .files
                    .checked_add(1)
                    .ok_or("SOURCE_DEPENDENCY_TREE_LIMIT")?;
                if state.inventory.files > state.limits.files {
                    return Err("SOURCE_DEPENDENCY_TREE_LIMIT".into());
                }
                state.inventory.bytes = state
                    .inventory
                    .bytes
                    .checked_add(length)
                    .ok_or("SOURCE_DEPENDENCY_TREE_LIMIT")?;
                if state.inventory.bytes > state.limits.tree_bytes {
                    return Err("SOURCE_DEPENDENCY_TREE_LIMIT".into());
                }
                hash_entry(&mut state.digest, b'f', &path_bytes, length);
                let mut buffer = [0u8; IO_CHUNK];
                let mut read = 0u64;
                loop {
                    check(cancelled, started)?;
                    let count = file
                        .read(&mut buffer)
                        .map_err(|_| "SOURCE_DEPENDENCY_SET_READ")?;
                    if count == 0 {
                        break;
                    }
                    read = read
                        .checked_add(count as u64)
                        .ok_or("SOURCE_DEPENDENCY_TREE_LIMIT")?;
                    if read > length {
                        return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
                    }
                    state.digest.update(&buffer[..count]);
                }
                let after = file.metadata().map_err(|_| "SOURCE_DEPENDENCY_SET_READ")?;
                if read != length
                    || !same_file_meta(&before, &after)
                    || !directory.is_same_child(name, &meta)?
                {
                    return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
                }
            }
            _ => return Err("SOURCE_DEPENDENCY_SET_INVALID".into()),
        }
        relative.pop();
    }
    let current_names = directory.names(allowance as usize)?;
    if current_names != names {
        return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
    }
    Ok(())
}

fn hash_entry(digest: &mut Sha256, kind: u8, path: &[u8], length: u64) {
    digest.update([kind]);
    digest.update((path.len() as u64).to_le_bytes());
    digest.update(path);
    digest.update(length.to_le_bytes());
}

fn validate_name(name: &OsStr) -> Result<(), String> {
    let bytes = name.as_bytes();
    let text = std::str::from_utf8(bytes).map_err(|_| "SOURCE_DEPENDENCY_SET_INVALID")?;
    if text.is_empty()
        || text == "."
        || text == ".."
        || text.contains('/')
        || text.contains('\\')
        || text.contains(':')
        || text.chars().any(char::is_control)
    {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    Ok(())
}

fn same_file_meta(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

fn same_stat_file_meta(a: &libc::stat, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.st_size >= 0
        && a.st_dev as u64 == b.dev()
        && a.st_ino as u64 == b.ino()
        && a.st_uid as u32 == b.uid()
        && a.st_mode as u32 == b.mode()
        && a.st_nlink as u64 == b.nlink()
        && a.st_size as u64 == b.len()
        && a.st_mtime as i64 == b.mtime()
        && a.st_mtime_nsec as i64 == b.mtime_nsec()
        && a.st_ctime as i64 == b.ctime()
        && a.st_ctime_nsec as i64 == b.ctime_nsec()
}

fn same_dir_meta(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_mode == b.st_mode
}

fn check(cancelled: &AtomicBool, started: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("SOURCE_DEPENDENCY_CANCELLED".into());
    }
    if started.elapsed() > WALK_LIMIT {
        return Err("SOURCE_DEPENDENCY_TREE_TIMEOUT".into());
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 15) as usize] as char);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    #[test]
    fn inventory_is_stable_changes_with_content_and_ignores_only_host_receipt() {
        let workspace = super::super::super::staging::Workspace::create().unwrap();
        let root = Directory::absolute(&workspace.root).unwrap();
        fs::create_dir(workspace.root.join("node_modules")).unwrap();
        let package = workspace.root.join("node_modules/pkg");
        fs::create_dir(&package).unwrap();
        fs::write(package.join("package.json"), b"{\"name\":\"pkg\"}").unwrap();
        let cancelled = AtomicBool::new(false);
        let first = calculate(&root, &cancelled).unwrap();
        assert_eq!(calculate(&root, &cancelled).unwrap(), first);
        let mut host_receipt = fs::File::create(workspace.root.join(HOST_RECEIPT)).unwrap();
        host_receipt.write_all(b"host metadata").unwrap();
        host_receipt.sync_all().unwrap();
        assert_eq!(calculate(&root, &cancelled).unwrap(), first);
        fs::write(package.join("package.json"), b"{\"name\":\"changed\"}").unwrap();
        assert_ne!(calculate(&root, &cancelled).unwrap().sha256, first.sha256);
        drop(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn inventory_rejects_links_and_cancellation() {
        use std::os::unix::fs::symlink;
        let workspace = super::super::super::staging::Workspace::create().unwrap();
        let root = Directory::absolute(&workspace.root).unwrap();
        fs::write(workspace.root.join("file"), b"data").unwrap();
        symlink("file", workspace.root.join("link")).unwrap();
        assert_eq!(
            calculate(&root, &AtomicBool::new(false)).unwrap_err(),
            "SOURCE_DEPENDENCY_SET_INVALID"
        );
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            calculate(&root, &cancelled).unwrap_err(),
            "SOURCE_DEPENDENCY_CANCELLED"
        );
        drop(workspace);
    }
    #[test]
    fn converted_package_inventory_uses_the_same_digest_with_small_package_budgets() {
        let workspace = super::super::super::staging::Workspace::create().unwrap();
        let root = Directory::absolute(&workspace.root).unwrap();
        fs::create_dir(workspace.root.join("assets")).unwrap();
        fs::write(workspace.root.join("plugin.json"), b"manifest").unwrap();
        fs::write(workspace.root.join("assets/index.js"), b"bundle").unwrap();
        let summary = calculate_package(&root).unwrap();
        assert_eq!((summary.entries, summary.files, summary.bytes), (3, 2, 14));
        fs::write(
            workspace.root.join(HOST_RECEIPT),
            b"must be included for a plugin tree",
        )
        .unwrap();
        let with_receipt = calculate_package(&root).unwrap();
        assert_ne!(with_receipt.sha256, summary.sha256);
        assert_eq!(with_receipt.files, 3);
        for index in 0..62 {
            fs::write(workspace.root.join(format!("extra-{index}")), b"x").unwrap();
        }
        assert_eq!(
            calculate_package(&root).unwrap_err(),
            "SOURCE_DEPENDENCY_TREE_LIMIT"
        );
        drop(workspace);
    }
}
