//! Fixed production paths and private recovery-directory handling for login-item host calls.

use std::{
    fs::{self, File},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::PathBuf,
};

use super::super::{RECOVERY_FAILED, UNAVAILABLE};

const RECOVERY_DIRECTORY: &str = "login-item-recovery";
const JOURNAL_NAME: &str = "transaction.json";
const PENDING_NAME: &str = "transaction.pending";
const BACKUP_NAME: &str = "legacy-login-item.plist";
const LOCK_NAME: &str = ".login-item-migration.lock";

pub(in crate::general_settings_runtime::login_items) struct HostPaths {
    pub(super) app_data: PathBuf,
    pub(super) source: PathBuf,
    pub(super) executable: PathBuf,
    pub(super) recovery: PathBuf,
}

impl HostPaths {
    /// Checks for recovery artifacts without creating a directory or lock file.
    pub(super) fn has_recovery_artifacts(&self) -> Result<bool, &'static str> {
        self.validate_bindings()?;
        match fs::symlink_metadata(&self.app_data) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(UNAVAILABLE),
        }
        let Some(directory) = self.open_recovery_directory()? else {
            return Ok(false);
        };
        let before = directory.metadata().map_err(|_| RECOVERY_FAILED)?;
        validate_private_recovery_directory(&before)?;
        self.validate_same_volume(&before)?;

        let mut has_transaction_artifact = false;
        let mut has_lock_entry = false;
        for entry in fs::read_dir(&self.recovery).map_err(|_| RECOVERY_FAILED)? {
            let entry = entry.map_err(|_| RECOVERY_FAILED)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(RECOVERY_FAILED);
            };
            match name {
                JOURNAL_NAME | PENDING_NAME | BACKUP_NAME => has_transaction_artifact = true,
                LOCK_NAME => has_lock_entry = true,
                _ => return Err(RECOVERY_FAILED),
            }
        }
        let lock_file = if has_lock_entry {
            Some(self.open_existing_lock(&directory)?)
        } else {
            None
        };

        let after = directory.metadata().map_err(|_| RECOVERY_FAILED)?;
        let named = fs::symlink_metadata(&self.recovery).map_err(|_| RECOVERY_FAILED)?;
        if identity(&before) != identity(&after)
            || identity(&before) != identity(&named)
            || self.recovery.canonicalize().map_err(|_| RECOVERY_FAILED)? != self.recovery
        {
            return Err(RECOVERY_FAILED);
        }
        if let Some(lock_file) = lock_file.as_ref() {
            self.verify_existing_lock(lock_file, before.dev())?;
        }
        Ok(has_transaction_artifact)
    }

    fn open_existing_lock(&self, directory: &File) -> Result<File, &'static str> {
        let path = self.recovery.join(LOCK_NAME);
        let before = fs::symlink_metadata(&path).map_err(|_| RECOVERY_FAILED)?;
        let directory_device = directory.metadata().map_err(|_| RECOVERY_FAILED)?.dev();
        if !valid_lock_metadata(&before, directory_device) {
            return Err(RECOVERY_FAILED);
        }
        let name = std::ffi::CString::new(LOCK_NAME).map_err(|_| RECOVERY_FAILED)?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(RECOVERY_FAILED);
        }
        let file = unsafe { File::from_raw_fd(fd) };
        self.verify_existing_lock(&file, directory_device)?;
        let opened = file.metadata().map_err(|_| RECOVERY_FAILED)?;
        if identity(&before) != identity(&opened) || before.len() != opened.len() {
            return Err(RECOVERY_FAILED);
        }
        Ok(file)
    }

    fn verify_existing_lock(&self, file: &File, directory_device: u64) -> Result<(), &'static str> {
        let descriptor = file.metadata().map_err(|_| RECOVERY_FAILED)?;
        let named =
            fs::symlink_metadata(self.recovery.join(LOCK_NAME)).map_err(|_| RECOVERY_FAILED)?;
        if !valid_lock_metadata(&descriptor, directory_device)
            || !valid_lock_metadata(&named, directory_device)
            || identity(&descriptor) != identity(&named)
            || descriptor.len() != named.len()
        {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    /// Creates the one fixed recovery child only after the caller has validated a
    /// current user choice and CAS. It never repairs or changes the parent mode.
    pub(super) fn ensure_recovery_directory(&self) -> Result<(), &'static str> {
        self.validate_bindings()?;
        let parent = self.open_app_data_directory()?;
        let name = std::ffi::CString::new(RECOVERY_DIRECTORY).map_err(|_| RECOVERY_FAILED)?;
        let mut created = false;

        let child_fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        let child_fd = if child_fd >= 0 {
            child_fd
        } else {
            let mkdir_result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
            if mkdir_result != 0 {
                return Err(RECOVERY_FAILED);
            }
            created = true;
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                )
            };
            if fd < 0 {
                return Err(RECOVERY_FAILED);
            }
            if unsafe { libc::fchmod(fd, 0o700) } != 0 {
                unsafe { libc::close(fd) };
                return Err(RECOVERY_FAILED);
            }
            fd
        };

        let directory = unsafe { File::from_raw_fd(child_fd) };
        let metadata = directory.metadata().map_err(|_| RECOVERY_FAILED)?;
        validate_private_recovery_directory(&metadata)?;
        self.validate_same_volume(&metadata)?;
        if self.recovery.canonicalize().map_err(|_| RECOVERY_FAILED)? != self.recovery {
            return Err(RECOVERY_FAILED);
        }
        let named = fs::symlink_metadata(&self.recovery).map_err(|_| RECOVERY_FAILED)?;
        if identity(&metadata) != identity(&named) {
            return Err(RECOVERY_FAILED);
        }
        if created && unsafe { libc::fsync(parent.as_raw_fd()) } != 0 {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    fn validate_bindings(&self) -> Result<(), &'static str> {
        if !self.app_data.is_absolute()
            || self.recovery != self.app_data.join(RECOVERY_DIRECTORY)
            || self.source.file_name().and_then(|name| name.to_str())
                != Some("com.atools.desktop.plist")
            || !self.source.is_absolute()
            || !self.executable.is_absolute()
            || self.executable.canonicalize().map_err(|_| UNAVAILABLE)? != self.executable
        {
            return Err(UNAVAILABLE);
        }
        Ok(())
    }

    fn open_app_data_directory(&self) -> Result<File, &'static str> {
        let metadata = fs::symlink_metadata(&self.app_data).map_err(|_| UNAVAILABLE)?;
        validate_app_data_metadata(&metadata)?;
        if self.app_data.canonicalize().map_err(|_| UNAVAILABLE)? != self.app_data {
            return Err(UNAVAILABLE);
        }
        let path = std::ffi::CString::new(self.app_data.as_os_str().as_bytes())
            .map_err(|_| UNAVAILABLE)?;
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(UNAVAILABLE);
        }
        let directory = unsafe { File::from_raw_fd(fd) };
        let opened = directory.metadata().map_err(|_| UNAVAILABLE)?;
        if identity(&metadata) != identity(&opened) {
            return Err(UNAVAILABLE);
        }
        Ok(directory)
    }

    fn open_recovery_directory(&self) -> Result<Option<File>, &'static str> {
        let parent = self.open_app_data_directory()?;
        let name = std::ffi::CString::new(RECOVERY_DIRECTORY).map_err(|_| RECOVERY_FAILED)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd >= 0 {
            return Ok(Some(unsafe { File::from_raw_fd(fd) }));
        }
        match fs::symlink_metadata(&self.recovery) {
            Ok(_) => return Err(RECOVERY_FAILED),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(RECOVERY_FAILED),
        }
        Ok(None)
    }

    fn validate_same_volume(&self, recovery: &fs::Metadata) -> Result<(), &'static str> {
        let source_parent = self.source.parent().ok_or(RECOVERY_FAILED)?;
        let source_meta = fs::symlink_metadata(source_parent).map_err(|_| RECOVERY_FAILED)?;
        if !source_meta.is_dir()
            || source_meta.file_type().is_symlink()
            || source_meta.uid() != unsafe { libc::geteuid() }
            || source_meta.mode() & 0o022 != 0
            || source_parent.canonicalize().map_err(|_| RECOVERY_FAILED)? != source_parent
            || source_meta.dev() != recovery.dev()
            || self.recovery == source_parent
            || self.recovery.starts_with(source_parent)
            || source_parent.starts_with(&self.recovery)
        {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn for_test(app_data: PathBuf, source: PathBuf, executable: PathBuf) -> Self {
        let recovery = app_data.join(RECOVERY_DIRECTORY);
        Self {
            app_data,
            source,
            executable,
            recovery,
        }
    }
}

pub(super) fn production_paths() -> Result<HostPaths, &'static str> {
    let config = atools_core::config::AppConfig::new().map_err(|_| UNAVAILABLE)?;
    let app_data = config.base_dir().to_path_buf();
    let source = super::super::spec::legacy_path().map_err(|_| UNAVAILABLE)?;
    let executable = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|_| UNAVAILABLE)?;
    let paths = HostPaths {
        recovery: app_data.join(RECOVERY_DIRECTORY),
        app_data,
        source,
        executable,
    };
    paths.validate_bindings()?;
    Ok(paths)
}

fn validate_app_data_metadata(metadata: &fs::Metadata) -> Result<(), &'static str> {
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
        || metadata.mode() & 0o7000 != 0
    {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

fn validate_private_recovery_directory(metadata: &fs::Metadata) -> Result<(), &'static str> {
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
        || metadata.mode() & 0o7000 != 0
    {
        return Err(RECOVERY_FAILED);
    }
    Ok(())
}

fn valid_lock_metadata(metadata: &fs::Metadata, directory_device: u64) -> bool {
    metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.nlink() == 1
        && metadata.mode() & 0o777 == 0o600
        && metadata.mode() & 0o7000 == 0
        && metadata.len() == 0
        && metadata.dev() == directory_device
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}

fn identity(metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        mode: metadata.mode(),
    }
}
