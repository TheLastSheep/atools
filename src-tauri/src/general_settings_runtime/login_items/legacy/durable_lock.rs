//! Advisory lock identity is bound to its fixed directory entry, not just its open fd.
use std::fs::File;
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::fs::MetadataExt,
};

use super::super::super::{RECOVERY_FAILED, UNAVAILABLE};
use super::super::configuration::FileIdentity;
use super::{identity_from_metadata, identity_from_stat, Directory, DirectoryIdentity};

const LOCK_NAME: &std::ffi::CStr = c".login-item-migration.lock";

pub(in crate::general_settings_runtime::login_items::legacy) struct Lock {
    file: File,
    identity: FileIdentity,
    directory: DirectoryIdentity,
}

impl Directory {
    pub(in crate::general_settings_runtime::login_items::legacy) fn lock(
        &self,
    ) -> Result<Lock, &'static str> {
        self.ensure_path_identity()?;
        if let Some(existing) = self.child_stat_optional(LOCK_NAME)? {
            validate_lock_stat(&existing, self.identity)?;
        }
        let fd = unsafe {
            libc::openat(
                self.fd.as_raw_fd(),
                LOCK_NAME.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(RECOVERY_FAILED);
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|_| RECOVERY_FAILED)?;
        validate_lock_metadata(&metadata, self.identity)?;
        let identity = identity_from_metadata(&metadata);
        if self
            .child_stat_optional(LOCK_NAME)?
            .as_ref()
            .map(identity_from_stat)
            != Some(identity.clone())
        {
            return Err(RECOVERY_FAILED);
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(RECOVERY_FAILED);
        }
        self.sync()?;
        let lock = Lock {
            file,
            identity,
            directory: self.identity,
        };
        lock.ensure_named(self)?;
        Ok(lock)
    }
}

impl Lock {
    pub(in crate::general_settings_runtime::login_items::legacy) fn ensure_named(
        &self,
        directory: &Directory,
    ) -> Result<(), &'static str> {
        directory.ensure_path_identity()?;
        if directory.identity != self.directory {
            return Err(RECOVERY_FAILED);
        }
        let metadata = self.file.metadata().map_err(|_| RECOVERY_FAILED)?;
        validate_lock_metadata(&metadata, self.directory)?;
        if identity_from_metadata(&metadata) != self.identity {
            return Err(RECOVERY_FAILED);
        }
        let named = directory
            .child_stat_optional(LOCK_NAME)?
            .ok_or(RECOVERY_FAILED)?;
        validate_lock_stat(&named, self.directory)?;
        if identity_from_stat(&named) != self.identity {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }
}

fn validate_lock_metadata(
    metadata: &std::fs::Metadata,
    directory: DirectoryIdentity,
) -> Result<(), &'static str> {
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o777 != 0o600
        || metadata.len() != 0
        || metadata.dev() != directory.device
    {
        return Err(RECOVERY_FAILED);
    }
    Ok(())
}

fn validate_lock_stat(
    metadata: &libc::stat,
    directory: DirectoryIdentity,
) -> Result<(), &'static str> {
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_nlink != 1
        || metadata.st_mode & 0o777 != 0o600
        || metadata.st_size != 0
        || metadata.st_dev as u64 != directory.device
    {
        return Err(UNAVAILABLE);
    }
    Ok(())
}
