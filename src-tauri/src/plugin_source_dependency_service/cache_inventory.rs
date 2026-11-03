//! Bounded accounting over app-owned dependency archives and published sets.
use super::super::staging::Directory;
use super::archive_store::{validate_id, GLOBAL_CACHE_LIMIT};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const ENTRY_LIMIT: usize = 1_000_000;
const FILE_LIMIT: u64 = 32 * 1024 * 1024;
const SCAN_LIMIT: Duration = Duration::from_secs(120);
const DEPTH_LIMIT: usize = 32;

pub(super) fn totals(
    archives: &Directory,
    sets: &Directory,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    totals_since(archives, sets, cancel, Instant::now())
}

pub(super) fn totals_since(
    archives: &Directory,
    sets: &Directory,
    cancel: &AtomicBool,
    started: Instant,
) -> Result<u64, String> {
    let root_archives = archives.metadata()?;
    let root_sets = sets.metadata()?;
    validate_cache_directory(&root_archives)?;
    validate_cache_directory(&root_sets)?;
    let mut state = State {
        bytes: 0,
        entries: 0,
        started,
        cancel,
    };
    scan_archive_names(archives, &mut state)?;
    scan_set_names(sets, &mut state)?;
    if !same_dir(&root_archives, &archives.metadata()?) || !same_dir(&root_sets, &sets.metadata()?)
    {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    Ok(state.bytes)
}

struct State<'a> {
    bytes: u64,
    entries: usize,
    started: Instant,
    cancel: &'a AtomicBool,
}
impl State<'_> {
    fn tick(&mut self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("SOURCE_DEPENDENCY_CANCELLED".into());
        }
        if self.started.elapsed() > SCAN_LIMIT {
            return Err("SOURCE_DEPENDENCY_CACHE_SCAN_TIMEOUT".into());
        }
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or("SOURCE_DEPENDENCY_CACHE_LIMIT")?;
        if self.entries > ENTRY_LIMIT {
            return Err("SOURCE_DEPENDENCY_CACHE_LIMIT".into());
        }
        Ok(())
    }
    fn add_file(&mut self, metadata: &libc::stat) -> Result<(), String> {
        self.tick()?;
        if metadata.st_mode & libc::S_IFMT != libc::S_IFREG
            || metadata.st_uid != unsafe { libc::geteuid() }
            || metadata.st_nlink != 1
            || metadata.st_mode & 0o7000 != 0
            || metadata.st_mode & 0o022 != 0
            || metadata.st_size < 0
            || metadata.st_size as u64 > FILE_LIMIT
        {
            return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
        }
        self.add_size(metadata.st_size as u64)
    }
    fn add_size(&mut self, bytes: u64) -> Result<(), String> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or("SOURCE_DEPENDENCY_CACHE_LIMIT")?;
        if self.bytes > GLOBAL_CACHE_LIMIT {
            return Err("SOURCE_DEPENDENCY_CACHE_LIMIT".into());
        }
        Ok(())
    }
}

fn scan_archive_names(directory: &Directory, state: &mut State<'_>) -> Result<(), String> {
    let allowance = ENTRY_LIMIT.saturating_sub(state.entries);
    let names = directory.names(allowance)?;
    for name in &names {
        let text = name.to_str().ok_or("SOURCE_DEPENDENCY_CACHE_INVALID")?;
        if let Some(id) = text.strip_prefix(".tmp-") {
            if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
                return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
            }
        } else {
            validate_id(text)?;
        }
        let metadata = directory.child_metadata(name.as_os_str())?;
        state.add_file(&metadata)?;
        if !directory.is_same_child(name.as_os_str(), &metadata)? {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
    }
    if directory.names(allowance)? != names {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    Ok(())
}

fn scan_set_names(directory: &Directory, state: &mut State<'_>) -> Result<(), String> {
    let allowance = ENTRY_LIMIT.saturating_sub(state.entries);
    let names = directory.names(allowance)?;
    for name in &names {
        validate_id(name.to_str().ok_or("SOURCE_DEPENDENCY_CACHE_INVALID")?)?;
        state.tick()?;
        let metadata = directory.child_metadata(name.as_os_str())?;
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR
            || metadata.st_uid != unsafe { libc::geteuid() }
            || metadata.st_mode & 0o077 != 0
            || metadata.st_mode & 0o7000 != 0
        {
            return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
        }
        let child = directory.open_directory(name.as_os_str(), Some(&metadata))?;
        scan_tree(&child, state, 1)?;
        if !directory.is_same_child(name.as_os_str(), &metadata)? {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
    }
    if directory.names(allowance)? != names {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    Ok(())
}

fn scan_tree(directory: &Directory, state: &mut State<'_>, depth: usize) -> Result<(), String> {
    if depth > DEPTH_LIMIT {
        return Err("SOURCE_DEPENDENCY_CACHE_LIMIT".into());
    }
    let allowance = ENTRY_LIMIT.saturating_sub(state.entries);
    let names = directory.names(allowance)?;
    for name in &names {
        validate_cache_name(name.as_os_str())?;
        state.tick()?;
        let metadata = directory.child_metadata(name.as_os_str())?;
        match metadata.st_mode & libc::S_IFMT {
            libc::S_IFDIR => {
                validate_payload_directory(&metadata)?;
                let child = directory.open_directory(name.as_os_str(), Some(&metadata))?;
                scan_tree(&child, state, depth + 1)?;
                if !directory.is_same_child(name.as_os_str(), &metadata)? {
                    return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
                }
            }
            libc::S_IFREG => {
                if metadata.st_nlink != 1
                    || metadata.st_size < 0
                    || metadata.st_size as u64 > FILE_LIMIT
                    || metadata.st_uid != unsafe { libc::geteuid() }
                    || metadata.st_mode & 0o7000 != 0
                    || metadata.st_mode & 0o022 != 0
                {
                    return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
                }
                state.add_size(metadata.st_size as u64)?;
                if !directory.is_same_child(name.as_os_str(), &metadata)? {
                    return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
                }
            }
            _ => return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into()),
        }
    }
    if directory.names(allowance)? != names {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    Ok(())
}

fn validate_cache_name(name: &std::ffi::OsStr) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let text =
        std::str::from_utf8(name.as_bytes()).map_err(|_| "SOURCE_DEPENDENCY_CACHE_INVALID")?;
    if text.is_empty()
        || text == "."
        || text == ".."
        || text.contains('/')
        || text.contains('\\')
        || text.contains(':')
        || text.chars().any(char::is_control)
    {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    Ok(())
}

fn validate_payload_directory(meta: &libc::stat) -> Result<(), String> {
    if meta.st_mode & libc::S_IFMT != libc::S_IFDIR
        || meta.st_uid != unsafe { libc::geteuid() }
        || meta.st_mode & 0o7000 != 0
        || meta.st_mode & 0o022 != 0
    {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    Ok(())
}

fn validate_cache_directory(meta: &libc::stat) -> Result<(), String> {
    if meta.st_mode & libc::S_IFMT != libc::S_IFDIR
        || meta.st_uid != unsafe { libc::geteuid() }
        || meta.st_mode & 0o077 != 0
        || meta.st_mode & 0o7000 != 0
    {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    Ok(())
}

fn same_dir(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_mode == b.st_mode
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicBool};

    #[test]
    fn global_cache_accounting_includes_archives_and_published_set_files() {
        let workspace = super::super::super::staging::Workspace::create().unwrap();
        let archive_path = workspace.root.join("archives");
        let set_path = workspace.root.join("sets");
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir(&archive_path).unwrap();
        fs::set_permissions(&archive_path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(&set_path).unwrap();
        fs::set_permissions(&set_path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(archive_path.join("a".repeat(64)), b"archive-bytes").unwrap();
        let set = set_path.join("b".repeat(64));
        fs::create_dir(&set).unwrap();
        fs::set_permissions(&set, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(set.join("installed-file"), b"installed-bytes").unwrap();
        let archives = Directory::absolute(&archive_path).unwrap();
        let sets = Directory::absolute(&set_path).unwrap();
        assert_eq!(
            totals(&archives, &sets, &AtomicBool::new(false)).unwrap(),
            13 + 15
        );
        assert_eq!(
            totals(&archives, &sets, &AtomicBool::new(true)).unwrap_err(),
            "SOURCE_DEPENDENCY_CANCELLED"
        );
        drop(workspace);
    }

    fn cache_layout() -> (
        super::super::super::staging::Workspace,
        Directory,
        Directory,
        std::path::PathBuf,
    ) {
        use std::os::unix::fs::PermissionsExt;
        let workspace = super::super::super::staging::Workspace::create().unwrap();
        let archive_path = workspace.root.join("archives");
        let sets_path = workspace.root.join("sets");
        fs::create_dir(&archive_path).unwrap();
        fs::set_permissions(&archive_path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(&sets_path).unwrap();
        fs::set_permissions(&sets_path, fs::Permissions::from_mode(0o700)).unwrap();
        let set_path = sets_path.join("c".repeat(64));
        fs::create_dir(&set_path).unwrap();
        fs::set_permissions(&set_path, fs::Permissions::from_mode(0o700)).unwrap();
        (
            workspace,
            Directory::absolute(&archive_path).unwrap(),
            Directory::absolute(&sets_path).unwrap(),
            set_path,
        )
    }

    #[test]
    fn published_set_payload_directories_allow_readable_modes_and_count_files() {
        use std::os::unix::fs::PermissionsExt;
        let (_workspace, archives, sets, set_path) = cache_layout();
        let package = set_path.join("node_modules/@types/react");
        fs::create_dir_all(&package).unwrap();
        for path in [
            set_path.join("node_modules"),
            set_path.join("node_modules/@types"),
            package.clone(),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let payload = b"locked-package-bytes";
        fs::write(package.join("package.json"), payload).unwrap();
        assert_eq!(
            totals(&archives, &sets, &AtomicBool::new(false)).unwrap(),
            payload.len() as u64
        );
    }

    #[test]
    fn payload_directory_write_special_mode_and_symlink_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for mode in [0o775, 0o1755] {
            let (_workspace, archives, sets, set_path) = cache_layout();
            let nested = set_path.join("node_modules");
            fs::create_dir(&nested).unwrap();
            fs::set_permissions(&nested, fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(
                totals(&archives, &sets, &AtomicBool::new(false)).unwrap_err(),
                "SOURCE_DEPENDENCY_CACHE_INVALID"
            );
        }
        let (_workspace, archives, sets, set_path) = cache_layout();
        fs::create_dir(set_path.join("target")).unwrap();
        symlink("target", set_path.join("link")).unwrap();
        assert_eq!(
            totals(&archives, &sets, &AtomicBool::new(false)).unwrap_err(),
            "SOURCE_DEPENDENCY_CACHE_INVALID"
        );
    }

    #[test]
    fn set_id_directory_rejects_special_bits_and_public_modes() {
        use std::os::unix::fs::PermissionsExt;
        for mode in [0o755, 0o1700] {
            let (_workspace, archives, sets, set_path) = cache_layout();
            fs::set_permissions(&set_path, fs::Permissions::from_mode(mode)).unwrap();
            let observed_mode = fs::metadata(&set_path).unwrap().permissions().mode() & 0o7777;
            assert_eq!(
                observed_mode, mode,
                "fixture must retain requested permission bits"
            );
            assert_eq!(
                totals(&archives, &sets, &AtomicBool::new(false)).unwrap_err(),
                "SOURCE_DEPENDENCY_CACHE_INVALID"
            );
        }
    }

    #[test]
    fn cache_root_permissions_remain_private_even_when_payload_dirs_are_readable() {
        use std::os::unix::fs::PermissionsExt;
        let workspace = super::super::super::staging::Workspace::create().unwrap();
        let archive_path = workspace.root.join("archives");
        let sets_path = workspace.root.join("sets");
        fs::create_dir(&archive_path).unwrap();
        fs::set_permissions(&archive_path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(&sets_path).unwrap();
        fs::set_permissions(&sets_path, fs::Permissions::from_mode(0o755)).unwrap();
        let archives = Directory::absolute(&archive_path).unwrap();
        let sets = Directory::absolute(&sets_path).unwrap();
        assert_eq!(
            totals(&archives, &sets, &AtomicBool::new(false)).unwrap_err(),
            "SOURCE_DEPENDENCY_CACHE_INVALID"
        );
    }

    #[test]
    fn combined_cache_limit_rejects_archive_plus_set_overflow() {
        let cancelled = AtomicBool::new(false);
        let mut state = State {
            bytes: GLOBAL_CACHE_LIMIT,
            entries: 0,
            started: Instant::now(),
            cancel: &cancelled,
        };
        assert_eq!(
            state.add_size(1).unwrap_err(),
            "SOURCE_DEPENDENCY_CACHE_LIMIT"
        );
    }
}
