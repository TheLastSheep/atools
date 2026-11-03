use std::{fmt, io};

const MAX_DOCUMENT_BYTES: u64 = 512 * 1024;
const MAX_RELATIVE_PATH_BYTES: usize = 16 * 1024;
const MAX_RELATIVE_COMPONENTS: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DocumentAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DocumentMetadata {
    pub is_file: bool,
    pub is_directory: bool,
    pub len: u64,
    pub modified_ms: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ScopedDocumentError {
    code: &'static str,
}

impl ScopedDocumentError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ScopedDocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ScopedDocumentError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DocumentBytesFailure {
    Unsupported(ScopedDocumentError),
    Error(ScopedDocumentError),
}

impl From<ScopedDocumentError> for DocumentBytesFailure {
    fn from(error: ScopedDocumentError) -> Self {
        Self::Error(error)
    }
}

#[cfg(unix)]
fn io_code(error: &io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EACCES) | Some(libc::EPERM) | Some(libc::ELOOP) => "EACCES",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EEXIST) => "EEXIST",
        Some(libc::ENOSPC) => "ENOSPC",
        Some(libc::EFBIG) => "EFBIG",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::ENOTSUP) => "ENOTSUP",
        _ => match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::InvalidData => "EINVAL",
            _ => "EIO",
        },
    }
}

#[cfg(unix)]
mod platform {
    use super::{
        io_code, DocumentAccess, DocumentBytesFailure, DocumentMetadata, ScopedDocumentError,
        MAX_DOCUMENT_BYTES, MAX_RELATIVE_COMPONENTS, MAX_RELATIVE_PATH_BYTES,
    };
    use std::{
        ffi::CString,
        fs::{self, File},
        io::{self, Read, Write},
        os::fd::{AsRawFd, FromRawFd},
        os::unix::ffi::OsStrExt,
        os::unix::fs::MetadataExt,
        path::Path,
    };

    /// A root opened by the host after authorization. The root and descendant
    /// directory descriptors anchor filesystem object identity. If another
    /// process moves an opened directory, its descriptor still refers to that
    /// object even when its current absolute-path ancestry changes. This is not
    /// a filesystem sandbox for an already-authorized Node process; revocation
    /// belongs to the caller's session grant/revision lifecycle.
    pub(crate) struct ScopedDocumentRoot {
        root: File,
        access: DocumentAccess,
    }

    impl ScopedDocumentRoot {
        pub(crate) fn open(
            root: impl AsRef<Path>,
            access: DocumentAccess,
        ) -> Result<Self, ScopedDocumentError> {
            if !root.as_ref().is_absolute() {
                return Err(ScopedDocumentError::new("EINVAL"));
            }
            let canonical = fs::canonicalize(root).map_err(map_io)?;
            let root = open_absolute_directory(&canonical)?;
            Ok(Self { root, access })
        }

        pub(crate) fn read_text(&self, relative: &str) -> Result<String, ScopedDocumentError> {
            let bytes = self.read_bytes(relative).map_err(|failure| match failure {
                DocumentBytesFailure::Unsupported(error) | DocumentBytesFailure::Error(error) => {
                    error
                }
            })?;
            String::from_utf8(bytes).map_err(|_| ScopedDocumentError::new("EINVAL"))
        }

        pub(crate) fn read_bytes(&self, relative: &str) -> Result<Vec<u8>, DocumentBytesFailure> {
            let (parent, leaf) = self.open_parent(relative)?;
            let expected =
                stat_at(parent.as_raw_fd(), &leaf).map_err(DocumentBytesFailure::Error)?;
            let file_type = expected.st_mode & libc::S_IFMT;
            if file_type == libc::S_IFLNK {
                return Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
                    "EACCES",
                )));
            }
            if file_type == libc::S_IFDIR {
                return Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
                    "EISDIR",
                )));
            }
            if file_type != libc::S_IFREG {
                return Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
                    "EINVAL",
                )));
            }
            if expected.st_size > MAX_DOCUMENT_BYTES as libc::off_t {
                return Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
                    "EFBIG",
                )));
            }
            let fd = openat(
                parent.as_raw_fd(),
                &leaf,
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
                0,
            )
            .map_err(DocumentBytesFailure::Error)?;
            // SAFETY: openat returned a fresh owned descriptor.
            let file = unsafe { File::from_raw_fd(fd) };
            let metadata = file
                .metadata()
                .map_err(map_io)
                .map_err(DocumentBytesFailure::Error)?;
            if !metadata.is_file()
                || metadata.dev() != expected.st_dev as u64
                || metadata.ino() != expected.st_ino as u64
            {
                return Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
                    "EINVAL",
                )));
            }
            if metadata.len() > MAX_DOCUMENT_BYTES {
                return Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
                    "EFBIG",
                )));
            }
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            file.take(MAX_DOCUMENT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(map_io)
                .map_err(DocumentBytesFailure::Error)?;
            if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
                return Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
                    "EFBIG",
                )));
            }
            Ok(bytes)
        }

        /// Replaces the document atomically with a new mode-0600 file.
        /// Existing ownership, mode, ACLs, and extended attributes are not
        /// preserved; this is not a full Node fs adapter. Temporary cleanup is
        /// best-effort. A parent fsync failure after rename can mean the
        /// destination already changed, so callers must not blindly retry.
        pub(crate) fn write_text_atomic(
            &self,
            relative: &str,
            text: &str,
        ) -> Result<(), ScopedDocumentError> {
            if self.access != DocumentAccess::ReadWrite {
                return Err(ScopedDocumentError::new("EACCES"));
            }
            if text.len() as u64 > MAX_DOCUMENT_BYTES {
                return Err(ScopedDocumentError::new("EFBIG"));
            }
            let (parent, leaf) = self.open_parent(relative)?;
            reject_nonregular_existing(parent.as_raw_fd(), &leaf)?;
            let (temp_name, mut file) = create_temp(parent.as_raw_fd())?;
            let mut cleanup = PendingEntry {
                parent_fd: parent.as_raw_fd(),
                name: temp_name.clone(),
                armed: true,
            };
            file.write_all(text.as_bytes()).map_err(map_io)?;
            file.sync_all().map_err(map_io)?;
            let result = unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temp_name.as_ptr(),
                    parent.as_raw_fd(),
                    leaf.as_ptr(),
                )
            };
            if result != 0 {
                return Err(last_error());
            }
            cleanup.armed = false;
            let result = unsafe { libc::fsync(parent.as_raw_fd()) };
            if result != 0 {
                return Err(last_error());
            }
            Ok(())
        }

        pub(crate) fn metadata(
            &self,
            relative: &str,
        ) -> Result<DocumentMetadata, ScopedDocumentError> {
            let (parent, leaf) = self.open_parent(relative)?;
            let stat = stat_at(parent.as_raw_fd(), &leaf)?;
            let file_type = stat.st_mode & libc::S_IFMT;
            if file_type == libc::S_IFLNK {
                return Err(ScopedDocumentError::new("EACCES"));
            }
            Ok(metadata_from_stat(&stat))
        }

        pub(crate) fn exists(&self, relative: &str) -> Result<bool, ScopedDocumentError> {
            match self.metadata(relative) {
                Ok(_) => Ok(true),
                Err(error) if error.code() == "ENOENT" => Ok(false),
                Err(error) => Err(error),
            }
        }

        fn open_parent(&self, relative: &str) -> Result<(File, CString), ScopedDocumentError> {
            let components = relative_components(relative)?;
            let (leaf, parents) = components
                .split_last()
                .ok_or_else(|| ScopedDocumentError::new("EINVAL"))?;
            let mut current = self.root.try_clone().map_err(map_io)?;
            for component in parents {
                let name = c_string(component)?;
                let fd = openat(
                    current.as_raw_fd(),
                    &name,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                    0,
                )?;
                // SAFETY: openat returned a fresh owned descriptor.
                current = unsafe { File::from_raw_fd(fd) };
            }
            Ok((current, c_string(leaf)?))
        }
    }

    fn relative_components(path: &str) -> Result<Vec<&str>, ScopedDocumentError> {
        if path.len() > MAX_RELATIVE_PATH_BYTES {
            return Err(ScopedDocumentError::new("ENAMETOOLONG"));
        }
        if path.is_empty() || path.starts_with('/') || path.contains('\0') {
            return Err(ScopedDocumentError::new("EINVAL"));
        }
        if path.bytes().filter(|byte| *byte == b'/').count() + 1 > MAX_RELATIVE_COMPONENTS {
            return Err(ScopedDocumentError::new("ENAMETOOLONG"));
        }
        let components: Vec<_> = path.split('/').collect();
        if components
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        {
            return Err(ScopedDocumentError::new("EINVAL"));
        }
        Ok(components)
    }

    fn c_string(value: &str) -> Result<CString, ScopedDocumentError> {
        CString::new(value).map_err(|_| ScopedDocumentError::new("EINVAL"))
    }

    fn c_string_bytes(value: &[u8]) -> Result<CString, ScopedDocumentError> {
        CString::new(value).map_err(|_| ScopedDocumentError::new("EINVAL"))
    }

    fn open_absolute_directory(path: &Path) -> Result<File, ScopedDocumentError> {
        let mut current = File::open("/").map_err(map_io)?;
        for component in path.components().skip(1) {
            let name = c_string_bytes(component.as_os_str().as_bytes())?;
            let fd = openat(
                current.as_raw_fd(),
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0,
            )?;
            // SAFETY: openat returned a fresh owned descriptor.
            current = unsafe { File::from_raw_fd(fd) };
        }
        Ok(current)
    }

    fn openat(
        parent_fd: libc::c_int,
        name: &CString,
        flags: libc::c_int,
        mode: libc::mode_t,
    ) -> Result<libc::c_int, ScopedDocumentError> {
        let fd = unsafe { libc::openat(parent_fd, name.as_ptr(), flags, mode as libc::c_uint) };
        if fd < 0 {
            Err(last_error())
        } else {
            Ok(fd)
        }
    }

    fn reject_nonregular_existing(
        parent_fd: libc::c_int,
        leaf: &CString,
    ) -> Result<(), ScopedDocumentError> {
        let stat = match stat_at(parent_fd, leaf) {
            Ok(stat) => stat,
            Err(error) if error.code() == "ENOENT" => return Ok(()),
            Err(error) => return Err(error),
        };
        let file_type = stat.st_mode & libc::S_IFMT;
        if file_type == libc::S_IFLNK {
            return Err(ScopedDocumentError::new("EACCES"));
        }
        if file_type == libc::S_IFDIR {
            return Err(ScopedDocumentError::new("EISDIR"));
        }
        if file_type != libc::S_IFREG {
            return Err(ScopedDocumentError::new("EINVAL"));
        }
        Ok(())
    }

    fn stat_at(parent_fd: libc::c_int, leaf: &CString) -> Result<libc::stat, ScopedDocumentError> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                parent_fd,
                leaf.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return Err(last_error());
        }
        Ok(unsafe { stat.assume_init() })
    }

    fn create_temp(parent_fd: libc::c_int) -> Result<(CString, File), ScopedDocumentError> {
        for _ in 0..8 {
            let name = c_string(&format!(".atools-{}.tmp", uuid::Uuid::new_v4()))?;
            let fd = unsafe {
                libc::openat(
                    parent_fd,
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_CLOEXEC
                        | libc::O_NOFOLLOW,
                    0o600,
                )
            };
            if fd >= 0 {
                // SAFETY: openat returned a fresh owned descriptor.
                return Ok((name, unsafe { File::from_raw_fd(fd) }));
            }
            let error = last_error();
            if error.code() != "EEXIST" {
                return Err(error);
            }
        }
        Err(ScopedDocumentError::new("EEXIST"))
    }

    struct PendingEntry {
        parent_fd: libc::c_int,
        name: CString,
        armed: bool,
    }

    impl Drop for PendingEntry {
        fn drop(&mut self) {
            if self.armed {
                unsafe { libc::unlinkat(self.parent_fd, self.name.as_ptr(), 0) };
            }
        }
    }

    fn metadata_from_stat(stat: &libc::stat) -> DocumentMetadata {
        let modified_ms =
            i128::from(stat.st_mtime) * 1_000 + i128::from(stat.st_mtime_nsec) / 1_000_000;
        let file_type = stat.st_mode & libc::S_IFMT;
        DocumentMetadata {
            is_file: file_type == libc::S_IFREG,
            is_directory: file_type == libc::S_IFDIR,
            len: stat.st_size.max(0) as u64,
            modified_ms,
        }
    }

    fn map_io(error: io::Error) -> ScopedDocumentError {
        ScopedDocumentError::new(io_code(&error))
    }

    fn last_error() -> ScopedDocumentError {
        map_io(io::Error::last_os_error())
    }
}

#[cfg(unix)]
pub(crate) use platform::ScopedDocumentRoot;

#[cfg(not(unix))]
pub(crate) struct ScopedDocumentRoot;

#[cfg(not(unix))]
impl ScopedDocumentRoot {
    pub(crate) fn open(
        _root: impl AsRef<std::path::Path>,
        _access: DocumentAccess,
    ) -> Result<Self, ScopedDocumentError> {
        Err(ScopedDocumentError::new("ENOTSUP"))
    }

    pub(crate) fn read_text(&self, _relative: &str) -> Result<String, ScopedDocumentError> {
        Err(ScopedDocumentError::new("ENOTSUP"))
    }

    pub(crate) fn read_bytes(&self, _relative: &str) -> Result<Vec<u8>, DocumentBytesFailure> {
        Err(DocumentBytesFailure::Unsupported(ScopedDocumentError::new(
            "ENOTSUP",
        )))
    }

    pub(crate) fn write_text_atomic(
        &self,
        _relative: &str,
        _text: &str,
    ) -> Result<(), ScopedDocumentError> {
        Err(ScopedDocumentError::new("ENOTSUP"))
    }

    pub(crate) fn metadata(
        &self,
        _relative: &str,
    ) -> Result<DocumentMetadata, ScopedDocumentError> {
        Err(ScopedDocumentError::new("ENOTSUP"))
    }

    pub(crate) fn exists(&self, _relative: &str) -> Result<bool, ScopedDocumentError> {
        Err(ScopedDocumentError::new("ENOTSUP"))
    }
}
