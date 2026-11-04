use std::ffi::{CStr, CString, OsString};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use super::{metadata::STREAM_BYTES, NodeRuntimeCacheError as Error};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    nlink: u64,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

impl Identity {
    pub(super) fn from(metadata: &std::fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            uid: metadata.uid(),
            mode: metadata.mode(),
            nlink: metadata.nlink(),
            size: metadata.size(),
            mtime: metadata.mtime(),
            mtime_nsec: metadata.mtime_nsec(),
            ctime: metadata.ctime(),
            ctime_nsec: metadata.ctime_nsec(),
        }
    }
    pub(super) fn size_bytes(&self) -> u64 {
        self.size
    }
    pub(super) fn same_inode(&self, other: &Self) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
}

pub(super) struct OpenedFile {
    pub file: File,
    pub identity: Identity,
}

pub(super) struct Directory {
    file: File,
    path: PathBuf,
}

impl Directory {
    pub fn open_absolute(path: &Path) -> Result<Self, Error> {
        if !path.is_absolute() {
            return Err(Error::InvalidPayload);
        }
        let mut current = File::open("/")?;
        let mut checked = PathBuf::from("/");
        for component in path.components() {
            match component {
                Component::RootDir => continue,
                Component::Normal(segment) => {
                    let name =
                        CString::new(segment.as_bytes()).map_err(|_| Error::InvalidPayload)?;
                    current = open_dir_at(current.as_raw_fd(), &name)?;
                    checked.push(segment);
                }
                _ => return Err(Error::InvalidPayload),
            }
        }
        let directory = Self {
            file: current,
            path: checked,
        };
        if !directory.file.metadata()?.is_dir() {
            return Err(Error::InvalidPayload);
        }
        Ok(directory)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn private_child(&self, name: &str, create: bool) -> Result<Self, Error> {
        let name = safe_name(name)?;
        let mut created = false;
        if create {
            // SAFETY: self.file is a live directory descriptor and name is a single component.
            let result = unsafe { libc::mkdirat(self.file.as_raw_fd(), name.as_ptr(), 0o700) };
            if result != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EEXIST) {
                    return Err(error.into());
                }
            } else {
                created = true;
            }
        }
        let child_file = open_dir_at(self.file.as_raw_fd(), &name)?;
        if created && unsafe { libc::fchmod(child_file.as_raw_fd(), 0o700) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        let metadata = child_file.metadata()?;
        let identity = Identity::from(&metadata);
        if !metadata.is_dir()
            || identity.uid != unsafe { libc::geteuid() }
            || identity.mode & 0o777 != 0o700
            || identity.mode & 0o7000 != 0
        {
            return Err(Error::InvalidCacheEntry);
        }
        Ok(Self {
            file: child_file,
            path: self.path.join(name.to_string_lossy().as_ref()),
        })
    }

    pub fn list_names(&self) -> Result<Vec<OsString>, Error> {
        // fdopendir takes ownership of a duplicate; the directory File remains live.
        let duplicate = unsafe { libc::dup(self.file.as_raw_fd()) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            unsafe { libc::close(duplicate) };
            return Err(io::Error::last_os_error().into());
        }
        let mut names = Vec::new();
        loop {
            clear_errno();
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                let errno = current_errno();
                unsafe { libc::closedir(stream) };
                if errno != 0 {
                    return Err(io::Error::from_raw_os_error(errno).into());
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name != b"." && name != b".." {
                names.push(OsString::from_vec(name.to_vec()));
            }
        }
        names.sort();
        Ok(names)
    }

    pub fn read_regular(
        &self,
        name: &str,
        limit: u64,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<(Vec<u8>, Identity), Error> {
        let opened = self.open_regular(name, None, None)?;
        if opened.identity.size > limit {
            return Err(Error::LimitExceeded);
        }
        let mut file = opened.file;
        let before = opened.identity;
        let mut bytes = Vec::with_capacity(before.size as usize);
        let mut chunk = vec![0u8; STREAM_BYTES];
        loop {
            check_cancel(cancelled)?;
            let read = file.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            if bytes.len().saturating_add(read) as u64 > limit {
                return Err(Error::LimitExceeded);
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        let after = Identity::from(&file.metadata()?);
        self.verify_named_identity(name, &before)?;
        if !same_contents(&before, &after) || bytes.len() as u64 != after.size {
            return Err(Error::InvalidPayload);
        }
        Ok((bytes, before))
    }

    pub fn open_regular(
        &self,
        name: &str,
        owner: Option<u32>,
        mode: Option<u32>,
    ) -> Result<OpenedFile, Error> {
        let name = safe_name(name)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        let identity = Identity::from(&metadata);
        if !metadata.is_file()
            || identity.nlink != 1
            || identity.mode & 0o7000 != 0
            || owner.is_some_and(|expected| identity.uid != expected)
            || mode.is_some_and(|expected| identity.mode & 0o777 != expected)
        {
            return Err(Error::InvalidCacheEntry);
        }
        self.verify_named_identity(name.to_str().map_err(|_| Error::InvalidPayload)?, &identity)?;
        Ok(OpenedFile { file, identity })
    }

    pub fn create_private_file(&self, name: &str) -> Result<OpenedFile, Error> {
        let name = safe_name(name)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
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
            return Err(io::Error::last_os_error().into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let identity = Identity::from(&file.metadata()?);
        self.verify_named_identity(name.to_str().map_err(|_| Error::InvalidPayload)?, &identity)?;
        Ok(OpenedFile { file, identity })
    }

    pub fn identity(&self, file: &File) -> Result<Identity, Error> {
        Ok(Identity::from(&file.metadata()?))
    }

    pub fn create_lock_file(&self, name: &str) -> Result<File, Error> {
        let name = safe_name(name)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata()?;
        let id = Identity::from(&meta);
        if !meta.is_file()
            || id.uid != unsafe { libc::geteuid() }
            || id.nlink != 1
            || id.mode & 0o777 != 0o600
            || id.mode & 0o7000 != 0
        {
            return Err(Error::InvalidCacheEntry);
        }
        self.verify_named_identity(name.to_str().map_err(|_| Error::InvalidPayload)?, &id)?;
        Ok(file)
    }

    pub fn verify_named_identity(&self, name: &str, expected: &Identity) -> Result<(), Error> {
        let name = safe_name(name)?;
        let mut observed = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                observed.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error().into());
        }
        let observed = unsafe { observed.assume_init() };
        if observed.st_dev as u64 != expected.dev
            || observed.st_ino as u64 != expected.ino
            || observed.st_uid != expected.uid
            || (observed.st_mode as u32 & libc::S_IFMT as u32) != libc::S_IFREG as u32
        {
            return Err(Error::InvalidCacheEntry);
        }
        Ok(())
    }

    pub fn remove_owned(&self, name: &str, expected: &Identity) -> Result<bool, Error> {
        if self.verify_named_identity(name, expected).is_err() {
            return Ok(false);
        }
        let name = safe_name(name)?;
        let result = unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) };
        if result == 0 {
            Ok(true)
        } else if io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(false)
        } else {
            Err(io::Error::last_os_error().into())
        }
    }

    pub fn rename_noreplace(&self, from: &str, to: &str) -> Result<(), Error> {
        let from = safe_name(from)?;
        let to = safe_name(to)?;
        let result = unsafe {
            libc::renameatx_np(
                self.file.as_raw_fd(),
                from.as_ptr(),
                self.file.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error().into());
        }
        self.file.sync_all()?;
        Ok(())
    }

    pub fn chmod_file(file: &File, mode: u32) -> Result<(), Error> {
        if unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(())
    }
}

pub(super) fn private_cache_root(base: &Path) -> Result<Directory, Error> {
    let parent = Directory::open_absolute(base)?;
    let app = parent.private_child("dev.atools.desktop", true)?;
    app.private_child("node-runtime", true)
}

pub(super) fn hash_file(
    file: &mut File,
    expected: &Identity,
    limit: u64,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<String, Error> {
    use sha2::{Digest, Sha256};
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0; STREAM_BYTES];
    loop {
        check_cancel(cancelled)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total.checked_add(read as u64).ok_or(Error::LimitExceeded)?;
        if total > limit {
            return Err(Error::LimitExceeded);
        }
        hash.update(&buffer[..read]);
    }
    let after = Identity::from(&file.metadata()?);
    if !same_contents(expected, &after) || total != after.size {
        return Err(Error::InvalidCacheEntry);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn check_cancel(cancelled: &std::sync::atomic::AtomicBool) -> Result<(), Error> {
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

pub(super) fn same_contents(left: &Identity, right: &Identity) -> bool {
    left.dev == right.dev
        && left.ino == right.ino
        && left.uid == right.uid
        && left.mode == right.mode
        && left.nlink == right.nlink
        && left.size == right.size
        && left.mtime == right.mtime
        && left.mtime_nsec == right.mtime_nsec
        && left.ctime == right.ctime
        && left.ctime_nsec == right.ctime_nsec
}

fn safe_name(name: &str) -> Result<CString, Error> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(Error::InvalidPayload);
    }
    CString::new(name).map_err(|_| Error::InvalidPayload)
}

fn open_dir_at(parent: i32, name: &CStr) -> Result<File, Error> {
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_DIRECTORY
                | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "macos")]
fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__error() }
}
fn clear_errno() {
    unsafe {
        *errno_pointer() = 0;
    }
}
fn current_errno() -> i32 {
    unsafe { *errno_pointer() }
}
