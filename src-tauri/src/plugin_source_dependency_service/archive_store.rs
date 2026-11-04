use super::super::staging::Directory;
use atools_plugin::source_build::LockedPackageV1;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[path = "archive_publication.rs"]
mod archive_publication;

pub(super) const ARCHIVE_LIMIT: u64 = 32 * 1024 * 1024;
pub(super) const PLAN_ARCHIVE_LIMIT: u64 = 128 * 1024 * 1024;
pub(super) const GLOBAL_CACHE_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ArchiveIdentity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    links: u64,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

impl ArchiveIdentity {
    fn from_stat(meta: &libc::stat) -> Self {
        Self {
            dev: meta.st_dev as u64,
            ino: meta.st_ino as u64,
            uid: meta.st_uid as u32,
            mode: meta.st_mode as u32,
            links: meta.st_nlink as u64,
            size: meta.st_size.max(0) as u64,
            mtime: 0,
            mtime_nsec: 0,
            ctime: 0,
            ctime_nsec: 0,
        }
    }

    fn matches_stat(&self, meta: &libc::stat) -> bool {
        let observed = Self::from_stat(meta);
        self.dev == observed.dev
            && self.ino == observed.ino
            && self.uid == observed.uid
            && self.mode == observed.mode
            && self.links == observed.links
            && self.size == observed.size
    }

    fn matches_stat_object(&self, meta: &libc::stat) -> bool {
        let observed = Self::from_stat(meta);
        self.dev == observed.dev
            && self.ino == observed.ino
            && self.uid == observed.uid
            && self.mode == observed.mode
            && self.links == observed.links
    }

    fn matches_metadata(&self, metadata: &std::fs::Metadata) -> bool {
        *self == Self::from_metadata(metadata)
    }

    fn matches_file_base(&self, metadata: &std::fs::Metadata) -> bool {
        let observed = Self::from_metadata(metadata);
        self.dev == observed.dev
            && self.ino == observed.ino
            && self.uid == observed.uid
            && self.mode == observed.mode
            && self.links == observed.links
            && self.size == observed.size
    }

    // A same-directory rename may update ctime. This relaxed comparison is
    // only used after the exact pre-rename identity and content were verified.
    fn matches_after_rename(&self, metadata: &std::fs::Metadata) -> bool {
        let observed = Self::from_metadata(metadata);
        self.dev == observed.dev
            && self.ino == observed.ino
            && self.uid == observed.uid
            && self.mode == observed.mode
            && self.links == observed.links
            && self.size == observed.size
            && self.mtime == observed.mtime
            && self.mtime_nsec == observed.mtime_nsec
    }

    fn matches_file_object(&self, metadata: &std::fs::Metadata) -> bool {
        let observed = Self::from_metadata(metadata);
        self.dev == observed.dev
            && self.ino == observed.ino
            && self.uid == observed.uid
            && self.mode == observed.mode
            && self.links == observed.links
    }

    pub(super) fn from_metadata(meta: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            uid: meta.uid(),
            mode: meta.mode(),
            links: meta.nlink(),
            size: meta.len(),
            mtime: meta.mtime(),
            mtime_nsec: meta.mtime_nsec(),
            ctime: meta.ctime(),
            ctime_nsec: meta.ctime_nsec(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CorruptArchive {
    archive_id: String,
    identity: ArchiveIdentity,
    content_sha256: [u8; 32],
}

impl CorruptArchive {
    pub fn bytes(&self) -> u64 {
        self.identity.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CachedArchive {
    Missing,
    Verified { bytes: u64 },
    Corrupt(CorruptArchive),
}

pub(super) struct ArchiveStore {
    archive_path: PathBuf,
    sets_path: PathBuf,
    root: Directory,
    archives: Directory,
    sets: Directory,
}

impl ArchiveStore {
    pub fn open_for_write(cache_root: &Path) -> Result<Self, String> {
        if !cfg!(target_os = "macos") {
            return Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into());
        }
        let root_path = cache_root.join("ztools-source-dependencies-v1");
        let root = Directory::ensure_absolute(&root_path)?;
        Self::from_root(root_path, root, true)
    }

    pub fn open_existing(cache_root: &Path) -> Result<Option<Self>, String> {
        if !cfg!(target_os = "macos") {
            return Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into());
        }
        let root_path = cache_root.join("ztools-source-dependencies-v1");
        match std::fs::symlink_metadata(&root_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("SOURCE_DEPENDENCY_CACHE_UNAVAILABLE".into()),
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
            }
            Ok(_) => {}
        }
        let root = Directory::absolute(&root_path)?;
        Self::from_root(root_path, root, false).map(Some)
    }

    fn from_root(root_path: PathBuf, root: Directory, create: bool) -> Result<Self, String> {
        validate_private_directory(&root)?;
        let archives = if create {
            root.open_or_create_child_directory(OsStr::new("archives"))?
        } else {
            root.open_child_directory(OsStr::new("archives"))?
        };
        let sets = if create {
            root.open_or_create_child_directory(OsStr::new("sets"))?
        } else {
            root.open_child_directory(OsStr::new("sets"))?
        };
        validate_private_directory(&archives)?;
        validate_private_directory(&sets)?;
        let archive_path = root_path.join("archives");
        let sets_path = root_path.join("sets");
        Ok(Self {
            archive_path,
            sets_path,
            root,
            archives,
            sets,
        })
    }

    pub fn archive_root(&self) -> &Path {
        &self.archive_path
    }
    pub fn set_path(&self, set_id: &str) -> PathBuf {
        self.sets_path.join(set_id)
    }
    pub fn sets(&self) -> &Directory {
        &self.sets
    }

    pub fn open_archive(&self, package: &LockedPackageV1) -> Result<File, String> {
        validate_id(&package.archive_id_sha256)?;
        let file = self
            .archives
            .open_file(OsStr::new(&package.archive_id_sha256), None)?;
        validate_file_metadata(
            &file
                .metadata()
                .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?,
        )?;
        Ok(file)
    }

    pub fn create_archive_temp(&self) -> Result<(String, File, ArchiveIdentity), String> {
        for _ in 0..4 {
            let name = format!(".tmp-{}", uuid::Uuid::new_v4());
            match self
                .archives
                .create_file_exclusive(OsStr::new(&name), 0o600)
            {
                Ok(file) => {
                    let metadata = file
                        .metadata()
                        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
                    validate_file_metadata(&metadata)?;
                    return Ok((name, file, ArchiveIdentity::from_metadata(&metadata)));
                }
                Err(error) if error == "SourceBuildFileCreateFailed" => continue,
                Err(error) => return Err(error),
            }
        }
        Err("SOURCE_DEPENDENCY_TEMP_CREATE_FAILED".into())
    }

    pub fn publish_archive(&self, temporary: &str, archive_id: &str) -> Result<(), String> {
        archive_publication::publish_archive(self, temporary, archive_id)
    }

    pub fn publish_repaired_archive(
        &self,
        temporary: &str,
        package: &LockedPackageV1,
        corrupt: &CorruptArchive,
    ) -> Result<(), String> {
        archive_publication::publish_repaired_archive(self, temporary, package, corrupt)
    }

    #[cfg(test)]
    pub fn remove_archive_temp(&self, name: &str) -> Result<(), String> {
        match self.archives.child_metadata_optional(OsStr::new(name))? {
            Some(meta) => self.archives.unlink(OsStr::new(name), false, Some(&meta)),
            None => Ok(()),
        }
    }

    pub fn remove_archive_temp_if_identity(
        &self,
        name: &str,
        expected: &ArchiveIdentity,
    ) -> Result<(), String> {
        let name = OsStr::new(name);
        let Some(observed) = self.archives.child_metadata_optional(name)? else {
            return Ok(());
        };
        if !expected.matches_stat_object(&observed) {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
        let file = self.archives.open_file(name, Some(&observed))?;
        let metadata = file
            .metadata()
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        // A temp file is intentionally mutable while being streamed. Cleanup
        // binds to its original inode identity, not its changing size/times.
        if !expected.matches_file_object(&metadata) {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
        drop(file);
        self.archives.unlink(name, false, Some(&observed))
    }

    pub fn cache_totals(&self, cancelled: &std::sync::atomic::AtomicBool) -> Result<u64, String> {
        super::cache_inventory::totals(&self.archives, &self.sets, cancelled)
    }

    pub fn cache_totals_since(
        &self,
        cancelled: &std::sync::atomic::AtomicBool,
        started: std::time::Instant,
    ) -> Result<u64, String> {
        super::cache_inventory::totals_since(&self.archives, &self.sets, cancelled, started)
    }

    pub fn duplicate_for_inventory(&self) -> Result<Self, String> {
        Ok(Self {
            archive_path: self.archive_path.clone(),
            sets_path: self.sets_path.clone(),
            root: self.root.duplicate()?,
            archives: self.archives.duplicate()?,
            sets: self.sets.duplicate()?,
        })
    }

    pub fn inspect_archive(&self, package: &LockedPackageV1) -> Result<CachedArchive, String> {
        validate_id(&package.archive_id_sha256)?;
        let archive_name = OsStr::new(&package.archive_id_sha256);
        let Some(path_meta) = self.archives.child_metadata_optional(archive_name)? else {
            return Ok(CachedArchive::Missing);
        };
        validate_archive_metadata(&path_meta)?;
        let mut file = self.archives.open_file(archive_name, Some(&path_meta))?;
        let before = file
            .metadata()
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        let expected_identity = ArchiveIdentity::from_stat(&path_meta);
        if !expected_identity.matches_file_base(&before) {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
        let before_identity = ArchiveIdentity::from_metadata(&before);
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file)
            .take(ARCHIVE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        let after = file
            .metadata()
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        let after_identity = ArchiveIdentity::from_metadata(&after);
        if bytes.len() as u64 != before.len()
            || before_identity != after_identity
            || !self.archives.is_same_child(archive_name, &path_meta)?
        {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
        if atools_plugin::source_build::verify_archive_integrity(package, &bytes) {
            Ok(CachedArchive::Verified {
                bytes: bytes.len() as u64,
            })
        } else {
            Ok(CachedArchive::Corrupt(CorruptArchive {
                archive_id: package.archive_id_sha256.clone(),
                identity: after_identity,
                content_sha256: Sha256::digest(&bytes).into(),
            }))
        }
    }

    pub fn read_archive(&self, package: &LockedPackageV1) -> Result<Vec<u8>, String> {
        let mut file = self.open_archive(package)?;
        let before = file
            .metadata()
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        if before.len() == 0 || before.len() > ARCHIVE_LIMIT {
            return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file)
            .take(ARCHIVE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        let after = file
            .metadata()
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        if bytes.len() as u64 != before.len() || !same_file(&before, &after) {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
        Ok(bytes)
    }

    pub fn write_receipt_file(&self, stage: &Directory, bytes: &[u8]) -> Result<(), String> {
        let file =
            stage.create_file_exclusive(OsStr::new(".atools-host-receipt-v1.json"), 0o600)?;
        write_synced(file, bytes)
    }

    pub fn read_bounded_child(
        directory: &Directory,
        name: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let mut file = directory.open_file(OsStr::new(name), None)?;
        let before = file
            .metadata()
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        validate_file_metadata(&before)?;
        if before.len() > limit as u64 {
            return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        let after = file
            .metadata()
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        if bytes.len() > limit || !same_file(&before, &after) {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
        Ok(bytes)
    }
}

fn write_synced(mut file: File, bytes: &[u8]) -> Result<(), String> {
    file.write_all(bytes)
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_WRITE".to_owned())?;
    file.sync_all()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_SYNC".to_owned())
}

pub(super) fn validate_id(value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "archive_store_tests.rs"]
mod tests;

fn validate_archive_metadata(metadata: &libc::stat) -> Result<(), String> {
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_nlink != 1
        || metadata.st_mode & 0o7000 != 0
        || metadata.st_mode & 0o022 != 0
        || metadata.st_size < 0
        || metadata.st_size as u64 > ARCHIVE_LIMIT
    {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    Ok(())
}

fn validate_private_directory(directory: &Directory) -> Result<(), String> {
    let metadata = directory.metadata()?;
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_mode & 0o077 != 0
    {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    Ok(())
}

fn validate_file_metadata(metadata: &std::fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o7000 != 0
        || metadata.mode() & 0o022 != 0
        || metadata.len() > ARCHIVE_LIMIT
    {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    Ok(())
}

fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.mode() == b.mode()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
