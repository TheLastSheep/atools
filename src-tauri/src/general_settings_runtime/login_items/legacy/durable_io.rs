//! Descriptor-anchored I/O for the private legacy-login recovery transaction.
use std::ffi::{CStr, OsStr};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::{
    fd::{AsRawFd, FromRawFd, OwnedFd},
    unix::fs::MetadataExt,
};
use std::path::{Path, PathBuf};

use super::super::{RECOVERY_FAILED, UNAVAILABLE};
use super::configuration::FileIdentity;

#[path = "durable_lock.rs"]
mod lock;
pub(super) use lock::Lock;
#[path = "durable_directory.rs"]
mod directory;

const MAX_JOURNAL_BYTES: u64 = 4 * 1024;
pub(super) const SOURCE_NAME: &str = "com.atools.desktop.plist";

pub(super) struct Directory {
    fd: OwnedFd,
    path: PathBuf,
    identity: DirectoryIdentity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}

pub(super) struct FileContents {
    pub(super) bytes: Vec<u8>,
    pub(super) identity: FileIdentity,
}

pub(super) fn validate_source_path(path: &Path) -> Result<(), &'static str> {
    if path.file_name().and_then(OsStr::to_str) != Some(SOURCE_NAME)
        || !path.is_absolute()
        || path
            .parent()
            .ok_or(UNAVAILABLE)?
            .canonicalize()
            .map_err(|_| UNAVAILABLE)?
            != path.parent().ok_or(UNAVAILABLE)?
    {
        return Err(UNAVAILABLE);
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(UNAVAILABLE),
        Ok(_) if path.canonicalize().map_err(|_| UNAVAILABLE)? != path => Err(UNAVAILABLE),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(UNAVAILABLE),
    }
}

pub(super) fn validate_executable(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if !path.is_absolute()
        || path.canonicalize().map_err(|_| UNAVAILABLE)? != path
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o111 == 0
        || metadata.mode() & 0o7000 != 0
    {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

impl Directory {
    pub(super) fn read_child(
        &self,
        name: &CStr,
        maximum: u64,
    ) -> Result<Option<FileContents>, &'static str> {
        let Some(before) = self.child_stat_optional(name)? else {
            return Ok(None);
        };
        validate_regular_owned(&before, maximum)?;
        let fd = unsafe {
            libc::openat(
                self.fd.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(RECOVERY_FAILED);
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let metadata_before = file.metadata().map_err(|_| RECOVERY_FAILED)?;
        let identity_before = identity_from_metadata(&metadata_before);
        if identity_before != identity_from_stat(&before) {
            return Err(RECOVERY_FAILED);
        }
        validate_regular_owned(&before, maximum)?;
        let mut bytes = Vec::with_capacity(before.st_size as usize);
        let mut reader = (&mut file).take(maximum + 1);
        reader
            .read_to_end(&mut bytes)
            .map_err(|_| RECOVERY_FAILED)?;
        drop(reader);
        let metadata_after = file.metadata().map_err(|_| RECOVERY_FAILED)?;
        let identity_after = identity_from_metadata(&metadata_after);
        let after_path = self.child_stat_optional(name)?.ok_or(RECOVERY_FAILED)?;
        if identity_after != identity_before
            || identity_from_stat(&after_path) != identity_before
            || after_path.st_nlink != before.st_nlink
            || bytes.is_empty()
            || bytes.len() as u64 > maximum
            || bytes.len() as u64 != identity_before.length
        {
            return Err(RECOVERY_FAILED);
        }
        validate_regular_owned(&after_path, maximum)?;
        Ok(Some(FileContents {
            bytes,
            identity: identity_before,
        }))
    }

    pub(super) fn write_exclusive(
        &self,
        name: &CStr,
        bytes: &[u8],
        maximum: u64,
    ) -> Result<(), &'static str> {
        if bytes.is_empty() || bytes.len() as u64 > maximum {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_path_identity()?;
        let fd = unsafe {
            libc::openat(
                self.fd.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(RECOVERY_FAILED);
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(RECOVERY_FAILED);
        }
        file.write_all(bytes).map_err(|_| RECOVERY_FAILED)?;
        file.sync_all().map_err(|_| RECOVERY_FAILED)?;
        Ok(())
    }

    pub(super) fn publish_exclusive(
        &self,
        source: &CStr,
        destination_directory: &Self,
        destination: &CStr,
        expected_source: &FileContents,
        maximum: u64,
    ) -> Result<(), &'static str> {
        let current = self.read_child(source, maximum)?.ok_or(RECOVERY_FAILED)?;
        if current.bytes != expected_source.bytes || current.identity != expected_source.identity {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_path_identity()?;
        destination_directory.ensure_path_identity()?;
        rename_noreplace(
            self.fd.as_raw_fd(),
            source,
            destination_directory.fd.as_raw_fd(),
            destination,
        )?;
        Ok(())
    }

    pub(super) fn replace_owned_child(
        &self,
        temporary: &CStr,
        destination: &CStr,
        expected_current: &[u8],
        expected_temporary: &[u8],
    ) -> Result<(), &'static str> {
        let staged = self
            .read_child(temporary, MAX_JOURNAL_BYTES)?
            .ok_or(RECOVERY_FAILED)?;
        if staged.bytes != expected_temporary
            || staged.identity.mode & 0o777 != 0o600
            || staged.identity.uid != unsafe { libc::geteuid() }
        {
            return Err(RECOVERY_FAILED);
        }
        let current = self
            .read_child(destination, MAX_JOURNAL_BYTES)?
            .ok_or(RECOVERY_FAILED)?;
        if current.bytes != expected_current
            || current.identity.mode & 0o777 != 0o600
            || current.identity.uid != unsafe { libc::geteuid() }
        {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_path_identity()?;
        if unsafe {
            libc::renameat(
                self.fd.as_raw_fd(),
                temporary.as_ptr(),
                self.fd.as_raw_fd(),
                destination.as_ptr(),
            )
        } != 0
        {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    pub(super) fn remove_exact(
        &self,
        name: &CStr,
        expected: &[u8],
        expected_identity: &FileIdentity,
        maximum: u64,
    ) -> Result<(), &'static str> {
        let Some(current) = self.read_child(name, maximum)? else {
            return Err(RECOVERY_FAILED);
        };
        if current.bytes != expected || current.identity != *expected_identity {
            return Err(RECOVERY_FAILED);
        }
        let current_stat = self.child_stat_optional(name)?.ok_or(RECOVERY_FAILED)?;
        if identity_from_stat(&current_stat) != current.identity {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_path_identity()?;
        if unsafe { libc::unlinkat(self.fd.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    pub(super) fn sync(&self) -> Result<(), &'static str> {
        if unsafe { libc::fsync(self.fd.as_raw_fd()) } != 0 {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    pub(super) fn contains(&self, name: &CStr) -> Result<bool, &'static str> {
        Ok(self.child_stat_optional(name)?.is_some())
    }

    fn child_stat_optional(&self, name: &CStr) -> Result<Option<libc::stat>, &'static str> {
        let mut output = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                self.fd.as_raw_fd(),
                name.as_ptr(),
                output.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            return Ok(Some(unsafe { output.assume_init() }));
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(RECOVERY_FAILED)
        }
    }
}

fn validate_regular_owned(metadata: &libc::stat, maximum: u64) -> Result<(), &'static str> {
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        || metadata.st_uid != unsafe { libc::geteuid() }
        || metadata.st_nlink != 1
        || metadata.st_mode & 0o7000 != 0
        || metadata.st_mode & 0o022 != 0
        || metadata.st_size <= 0
        || metadata.st_size as u64 > maximum
    {
        return Err(RECOVERY_FAILED);
    }
    Ok(())
}

fn identity_from_metadata(metadata: &std::fs::Metadata) -> FileIdentity {
    FileIdentity {
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

fn identity_from_stat(metadata: &libc::stat) -> FileIdentity {
    FileIdentity {
        device: metadata.st_dev as u64,
        inode: metadata.st_ino as u64,
        uid: metadata.st_uid,
        gid: metadata.st_gid,
        mode: metadata.st_mode as u32,
        length: metadata.st_size as u64,
        mtime_seconds: metadata.st_mtime as i64,
        mtime_nanoseconds: metadata.st_mtime_nsec as i64,
        ctime_seconds: metadata.st_ctime as i64,
        ctime_nanoseconds: metadata.st_ctime_nsec as i64,
    }
}

fn rename_noreplace(
    source_directory: libc::c_int,
    source: &CStr,
    destination_directory: libc::c_int,
    destination: &CStr,
) -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    {
        const RENAME_EXCL: u32 = 0x0000_0004;
        unsafe extern "C" {
            fn renameatx_np(
                fromfd: libc::c_int,
                from: *const libc::c_char,
                tofd: libc::c_int,
                to: *const libc::c_char,
                flags: u32,
            ) -> libc::c_int;
        }
        if unsafe {
            renameatx_np(
                source_directory,
                source.as_ptr(),
                destination_directory,
                destination.as_ptr(),
                RENAME_EXCL,
            )
        } == 0
        {
            return Ok(());
        }
        return Err(RECOVERY_FAILED);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source_directory, source, destination_directory, destination);
        Err(super::super::UNSUPPORTED)
    }
}

#[cfg(test)]
#[path = "durable_directory_tests.rs"]
mod tests;
