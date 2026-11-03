//! Open and continuously validate the fixed source/recovery directory handles.
use std::ffi::OsStr;
use std::fs;
use std::os::{
    fd::{AsRawFd, FromRawFd, OwnedFd},
    unix::{ffi::OsStrExt, fs::MetadataExt},
};
use std::path::{Component, Path, PathBuf};

use super::super::super::UNAVAILABLE;
use super::{Directory, DirectoryIdentity};

impl Directory {
    pub(in crate::general_settings_runtime::login_items::legacy) fn open_layout(
        source: &Path,
        recovery: &Path,
    ) -> Result<(Self, Self), &'static str> {
        if !source.is_absolute() || !recovery.is_absolute() {
            return Err(UNAVAILABLE);
        }
        let source_parent = source.parent().ok_or(UNAVAILABLE)?;
        let source_dir = Self::open_absolute(source_parent)?;
        let recovery_dir = Self::open_absolute(recovery)?;
        let source_metadata = source_dir.metadata()?;
        let recovery_metadata = recovery_dir.metadata()?;
        let uid = unsafe { libc::geteuid() };
        if source_metadata.st_uid != uid
            || source_metadata.st_mode & 0o022 != 0
            || recovery_metadata.st_uid != uid
            || recovery_metadata.st_mode & 0o777 != 0o700
            || recovery_metadata.st_mode & 0o7000 != 0
            || source_metadata.st_dev != recovery_metadata.st_dev
            || recovery == source_parent
            || recovery.starts_with(source_parent)
            || source_parent.starts_with(recovery)
        {
            return Err(UNAVAILABLE);
        }
        Ok((source_dir, recovery_dir))
    }

    fn open_absolute(path: &Path) -> Result<Self, &'static str> {
        if !path.is_absolute() || path.canonicalize().map_err(|_| UNAVAILABLE)? != path {
            return Err(UNAVAILABLE);
        }
        let root = unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if root < 0 {
            return Err(UNAVAILABLE);
        }
        let mut current = Self::from_fd(root, PathBuf::from("/"))?;
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let child = name_c(name)?;
                    let fd = unsafe {
                        libc::openat(
                            current.fd.as_raw_fd(),
                            child.as_ptr(),
                            libc::O_RDONLY
                                | libc::O_DIRECTORY
                                | libc::O_CLOEXEC
                                | libc::O_NOFOLLOW
                                | libc::O_NONBLOCK,
                        )
                    };
                    if fd < 0 {
                        return Err(UNAVAILABLE);
                    }
                    let mut next_path = current.path.clone();
                    next_path.push(name);
                    current = Self::from_fd(fd, next_path)?;
                }
                _ => return Err(UNAVAILABLE),
            }
        }
        current.ensure_path_identity()?;
        Ok(current)
    }

    fn from_fd(fd: libc::c_int, path: PathBuf) -> Result<Self, &'static str> {
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(owned.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
            return Err(UNAVAILABLE);
        }
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(UNAVAILABLE);
        }
        Ok(Self {
            fd: owned,
            path,
            identity: identity_from_stat(&metadata),
        })
    }

    pub(super) fn metadata(&self) -> Result<libc::stat, &'static str> {
        let mut output = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(self.fd.as_raw_fd(), output.as_mut_ptr()) } != 0 {
            return Err(UNAVAILABLE);
        }
        Ok(unsafe { output.assume_init() })
    }

    pub(in crate::general_settings_runtime::login_items::legacy) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn ensure_path_identity(&self) -> Result<(), &'static str> {
        let held = identity_from_stat(&self.metadata()?);
        let named_metadata = fs::symlink_metadata(&self.path).map_err(|_| UNAVAILABLE)?;
        if named_metadata.file_type().is_symlink() || !named_metadata.is_dir() {
            return Err(UNAVAILABLE);
        }
        let named = DirectoryIdentity {
            device: named_metadata.dev(),
            inode: named_metadata.ino(),
            uid: named_metadata.uid(),
            gid: named_metadata.gid(),
            mode: named_metadata.mode(),
        };
        let canonical = self.path.canonicalize().map_err(|_| UNAVAILABLE)?;
        if canonical != self.path || held != self.identity || named != held {
            return Err(UNAVAILABLE);
        }
        Ok(())
    }
}

fn identity_from_stat(metadata: &libc::stat) -> DirectoryIdentity {
    DirectoryIdentity {
        device: metadata.st_dev as u64,
        inode: metadata.st_ino as u64,
        uid: metadata.st_uid,
        gid: metadata.st_gid,
        mode: metadata.st_mode as u32,
    }
}

fn name_c(name: &OsStr) -> Result<std::ffi::CString, &'static str> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(UNAVAILABLE);
    }
    std::ffi::CString::new(bytes).map_err(|_| UNAVAILABLE)
}
