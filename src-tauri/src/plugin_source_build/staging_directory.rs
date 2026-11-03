//! Directory handles anchor enumeration and child opens across pathname swaps.
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::os::{
    fd::{AsRawFd, FromRawFd, OwnedFd},
    unix::ffi::{OsStrExt, OsStringExt},
};
use std::path::{Component, Path};

pub(in crate::plugin_source_build) struct Directory(OwnedFd);
pub(super) type Metadata = libc::stat;

impl Directory {
    /// Open an absolute directory chain without following links, creating only
    /// missing owned directories with mode 0700. Every traversal is descriptor-relative.
    pub fn ensure_absolute(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("SourceBuildUnsafePath".into());
        }
        let mut current = Self::absolute(Path::new("/"))?;
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => match current.child_metadata_optional(name)? {
                    Some(metadata) => current = current.open_directory(name, Some(&metadata))?,
                    None => current = current.create_child_directory(name)?,
                },
                _ => return Err("SourceBuildUnsafePath".into()),
            }
        }
        Ok(current)
    }

    pub fn open_child_directory(&self, name: &OsStr) -> Result<Self, String> {
        let expected = self.child_metadata(name)?;
        self.open_directory(name, Some(&expected))
    }

    pub fn open_or_create_child_directory(&self, name: &OsStr) -> Result<Self, String> {
        match self.child_metadata_optional(name)? {
            Some(_) => self.open_child_directory(name),
            None => match self.create_child_directory(name) {
                Ok(directory) => Ok(directory),
                Err(error) if error == "SourceBuildDestinationExists" => {
                    self.open_child_directory(name)
                }
                Err(error) => Err(error),
            },
        }
    }

    /// Create one private child directory without following or replacing names.
    pub fn create_child_directory(&self, name: &OsStr) -> Result<Self, String> {
        let name = name_c(name)?;
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
                    "SourceBuildDestinationExists".into()
                } else {
                    "SourceBuildDirectoryCreateFailed".into()
                },
            );
        }
        let expected = self.child_metadata(OsStr::from_bytes(name.as_bytes()))?;
        let opened = self.open_directory(OsStr::from_bytes(name.as_bytes()), Some(&expected))?;
        let meta = opened.metadata()?;
        if meta.st_uid != unsafe { libc::geteuid() } || meta.st_mode & 0o077 != 0 {
            return Err("SourceBuildDirectoryPermissionsInvalid".into());
        }
        Ok(opened)
    }

    /// Atomically publish a child name only if the destination does not exist.
    /// macOS uses renameatx_np(RENAME_EXCL); unsupported platforms fail closed.
    pub fn rename_child_noreplace(&self, from: &OsStr, to: &OsStr) -> Result<(), String> {
        let from = name_c(from)?;
        let to = name_c(to)?;
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
            let result = unsafe {
                renameatx_np(
                    self.0.as_raw_fd(),
                    from.as_ptr(),
                    self.0.as_raw_fd(),
                    to.as_ptr(),
                    RENAME_EXCL,
                )
            };
            if result == 0 {
                return Ok(());
            }
            return Err(
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
                    "SourceBuildDestinationExists".into()
                } else {
                    "SourceBuildAtomicPublishFailed".into()
                },
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (from, to);
            Err("SOURCE_BUILD_PLATFORM_UNSUPPORTED".into())
        }
    }

    pub fn duplicate(&self) -> Result<Self, String> {
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err("SourceBuildDirectoryOpenFailed".into());
        }
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    pub fn absolute(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("SourceBuildUnsafePath".into());
        }
        let root = unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if root < 0 {
            return Err("SourceBuildDirectoryOpenFailed".into());
        }
        let mut current = Self(unsafe { OwnedFd::from_raw_fd(root) });
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => current = current.open_directory(name, None)?,
                _ => return Err("SourceBuildUnsafePath".into()),
            }
        }
        Ok(current)
    }

    pub fn metadata(&self) -> Result<Metadata, String> {
        stat(|out| unsafe { libc::fstat(self.0.as_raw_fd(), out) })
    }
    pub fn child_metadata(&self, name: &OsStr) -> Result<Metadata, String> {
        let name = name_c(name)?;
        stat(|out| unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                out,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        })
    }

    pub fn child_metadata_optional(&self, name: &OsStr) -> Result<Option<Metadata>, String> {
        let name = name_c(name)?;
        let mut output = std::mem::MaybeUninit::uninit();
        let result = unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                output.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            return Ok(Some(unsafe { output.assume_init() }));
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        Err("SourceBuildMetadataReadFailed".into())
    }

    pub fn open_directory(
        &self,
        name: &OsStr,
        expected: Option<&Metadata>,
    ) -> Result<Self, String> {
        let name = name_c(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_DIRECTORY
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err("SourceBuildDirectorySwapRejected".into());
        }
        let directory = Self(unsafe { OwnedFd::from_raw_fd(fd) });
        let opened = directory.metadata()?;
        if expected.is_some_and(|old| !same(old, &opened)) {
            return Err("SourceBuildDirectorySwapRejected".into());
        }
        Ok(directory)
    }

    pub fn open_file(&self, name: &OsStr, expected: Option<&Metadata>) -> Result<File, String> {
        let name = name_c(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err("SourceBuildFileReadFailed".into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let opened = stat(|out| unsafe { libc::fstat(file.as_raw_fd(), out) })?;
        if expected.is_some_and(|old| !same(old, &opened)) {
            return Err("SourceBuildFileSwapRejected".into());
        }
        Ok(file)
    }

    pub fn create_file_exclusive(&self, name: &OsStr, mode: libc::mode_t) -> Result<File, String> {
        let name = name_c(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                mode as libc::c_uint,
            )
        };
        if fd < 0 {
            return Err("SourceBuildFileCreateFailed".into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub fn file_metadata(&self, file: &File) -> Result<Metadata, String> {
        stat(|out| unsafe { libc::fstat(file.as_raw_fd(), out) })
    }

    pub fn is_same_child(&self, name: &OsStr, expected: &Metadata) -> Result<bool, String> {
        Ok(self
            .child_metadata_optional(name)?
            .is_some_and(|actual| same(expected, &actual)))
    }

    pub fn rename_child(&self, from: &OsStr, to: &OsStr) -> Result<(), String> {
        let from = name_c(from)?;
        let to = name_c(to)?;
        if unsafe {
            libc::renameat(
                self.0.as_raw_fd(),
                from.as_ptr(),
                self.0.as_raw_fd(),
                to.as_ptr(),
            )
        } != 0
        {
            return Err("SourceBuildFileReplaceFailed".into());
        }
        Ok(())
    }

    /// Atomically move a child between pinned directories without replacing the target.
    pub fn rename_child_to_noreplace(
        &self,
        from: &OsStr,
        destination: &Directory,
        to: &OsStr,
    ) -> Result<(), String> {
        let from = name_c(from)?;
        let to = name_c(to)?;
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
            let result = unsafe {
                renameatx_np(
                    self.0.as_raw_fd(),
                    from.as_ptr(),
                    destination.0.as_raw_fd(),
                    to.as_ptr(),
                    RENAME_EXCL,
                )
            };
            if result == 0 {
                return Ok(());
            }
            return Err(
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
                    "SourceBuildDestinationExists".into()
                } else {
                    "SourceBuildAtomicPublishFailed".into()
                },
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (from, to, destination);
            Err("SOURCE_BUILD_PLATFORM_UNSUPPORTED".into())
        }
    }

    pub fn sync(&self) -> Result<(), String> {
        if unsafe { libc::fsync(self.0.as_raw_fd()) } != 0 {
            return Err("SourceBuildDirectorySyncFailed".into());
        }
        Ok(())
    }

    pub fn names(&self, maximum: usize) -> Result<Vec<OsString>, String> {
        // openat(".") obtains a separate open-file description; unlike dup it
        // cannot leave this directory's next enumeration sharing an EOF offset.
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err("SourceBuildTreeReadFailed".into());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err("SourceBuildTreeReadFailed".into());
        }
        struct Stream(*mut libc::DIR);
        impl Drop for Stream {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let stream = Stream(stream);
        let mut names = Vec::new();
        loop {
            let errno = errno_pointer()?;
            unsafe {
                *errno = 0;
            }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                if unsafe { *errno } != 0 {
                    return Err("SourceBuildTreeReadFailed".into());
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            if names.len() >= maximum {
                return Err("SourceBuildTreeEntriesExceeded".into());
            }
            names.push(OsString::from_vec(bytes.to_vec()));
        }
        names.sort();
        Ok(names)
    }

    pub fn owner_access(&self) -> Result<(), String> {
        if unsafe { libc::fchmod(self.0.as_raw_fd(), 0o700) } != 0 {
            return Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into());
        }
        Ok(())
    }

    pub fn write_recovery(&self, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c".atools-cleanup-recovery.json".as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if fd < 0 {
            return Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)
            .map_err(|_| "SOURCE_BUILD_CLEANUP_UNCONFIRMED".into())
    }

    pub fn unlink(
        &self,
        name: &OsStr,
        directory: bool,
        expected: Option<&Metadata>,
    ) -> Result<(), String> {
        if let Some(expected) = expected {
            if !same(expected, &self.child_metadata(name)?) {
                return Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into());
            }
        }
        let name = name_c(name)?;
        if unsafe {
            libc::unlinkat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into());
        }
        Ok(())
    }
}

pub(super) fn same(left: &Metadata, right: &Metadata) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode & libc::S_IFMT == right.st_mode & libc::S_IFMT
}
pub(super) fn kind(meta: &Metadata) -> libc::mode_t {
    meta.st_mode & libc::S_IFMT
}

fn name_c(name: &OsStr) -> Result<CString, String> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err("SourceBuildUnsafePath".into());
    }
    CString::new(bytes).map_err(|_| "SourceBuildUnsafePath".into())
}
fn stat(call: impl FnOnce(*mut Metadata) -> i32) -> Result<Metadata, String> {
    let mut output = std::mem::MaybeUninit::uninit();
    if call(output.as_mut_ptr()) != 0 {
        return Err("SourceBuildMetadataReadFailed".into());
    }
    Ok(unsafe { output.assume_init() })
}
fn errno_pointer() -> Result<*mut i32, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(unsafe { libc::__error() })
    }
    #[cfg(target_os = "linux")]
    {
        Ok(unsafe { libc::__errno_location() })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("SourceBuildSandboxUnsupported".into())
    }
}
