//! Bounded copy support for staging local plugin directories.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 4096;
const MAX_DEPTH: usize = 32;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Copy)]
struct Limits {
    entries: usize,
    depth: usize,
    file_bytes: u64,
    total_bytes: u64,
}

impl Limits {
    const PRODUCTION: Self = Self {
        entries: MAX_ENTRIES,
        depth: MAX_DEPTH,
        file_bytes: MAX_FILE_BYTES,
        total_bytes: MAX_TOTAL_BYTES,
    };
}

/// Copy a package tree into a newly-created staging directory under fixed resource limits.
/// The destination is removed if any part of the copy fails.
pub(crate) fn copy_directory_into(source: &Path, destination: &Path) -> io::Result<()> {
    copy_with_limits(source, destination, Limits::PRODUCTION)
}

fn copy_with_limits(source: &Path, destination: &Path, limits: Limits) -> io::Result<()> {
    let result = copy_inner(source, destination, limits);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(destination);
    }
    result
}

fn copy_inner(source: &Path, destination: &Path, limits: Limits) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid("plugin source root must be a real directory"));
    }
    #[cfg(unix)]
    {
        let source = open_root(source)?;
        use std::os::unix::fs::MetadataExt;
        if source.metadata()?.dev() != metadata.dev() || source.metadata()?.ino() != metadata.ino()
        {
            return Err(invalid("plugin source root changed while staging"));
        }
        let mut budget = Budget {
            limits,
            entries: 0,
            bytes: 0,
        };
        copy_directory_unix(&source, destination, Path::new(""), 0, &mut budget)
    }
    #[cfg(not(unix))]
    {
        let mut budget = Budget {
            limits,
            entries: 0,
            bytes: 0,
        };
        copy_directory_portable(source, destination, Path::new(""), 0, &mut budget)
    }
}

struct Budget {
    limits: Limits,
    entries: usize,
    bytes: u64,
}

impl Budget {
    fn entry(&mut self, depth: usize, path: &Path) -> io::Result<()> {
        if depth > self.limits.depth {
            return Err(invalid(format!(
                "plugin directory exceeds maximum depth of {} at {}",
                self.limits.depth,
                path.display()
            )));
        }
        self.entries += 1;
        if self.entries > self.limits.entries {
            return Err(invalid(format!(
                "plugin directory exceeds maximum of {} filesystem entries at {}",
                self.limits.entries,
                path.display()
            )));
        }
        Ok(())
    }

    fn file_chunk(&self, file_bytes: u64, chunk: usize, path: &Path) -> io::Result<()> {
        let next_file = file_bytes.saturating_add(chunk as u64);
        if next_file > self.limits.file_bytes {
            return Err(invalid(format!(
                "plugin file exceeds maximum size of {} bytes: {}",
                self.limits.file_bytes,
                path.display()
            )));
        }
        if self.bytes.saturating_add(chunk as u64) > self.limits.total_bytes {
            return Err(invalid(format!(
                "plugin directory exceeds maximum copied size of {} bytes at {}",
                self.limits.total_bytes,
                path.display()
            )));
        }
        Ok(())
    }

    fn add_bytes(&mut self, chunk: usize) {
        self.bytes += chunk as u64;
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(unix)]
fn open_root(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(unix)]
fn copy_directory_unix(
    source: &std::fs::File,
    destination: &Path,
    relative: &Path,
    depth: usize,
    budget: &mut Budget,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    let remaining_entries = budget.limits.entries.saturating_sub(budget.entries);
    for name in directory_names(source.as_raw_fd(), remaining_entries, budget.limits.entries)? {
        let relative_path = relative.join(&name);
        let source_path = PathBuf::from("<plugin source>").join(&relative_path);
        let child_depth = depth + 1;
        budget.entry(child_depth, &source_path)?;
        let c_name = c_name(&name)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: c_name is NUL terminated and stat points to writable storage.
        let rc = unsafe {
            libc::fstatat(
                source.as_raw_fd(),
                c_name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fstatat succeeded and initialized stat.
        let stat = unsafe { stat.assume_init() };
        let kind = stat.st_mode & libc::S_IFMT;
        if kind == libc::S_IFLNK {
            if is_node_modules_bin_entry(&relative_path) {
                continue;
            }
            return Err(invalid(format!(
                "plugin source contains a symlink at {}",
                source_path.display()
            )));
        }
        if kind == libc::S_IFDIR {
            // SAFETY: openat receives a valid parent FD and NUL-terminated name.
            let fd = unsafe {
                libc::openat(
                    source.as_raw_fd(),
                    c_name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: fd was returned by openat and ownership transfers to File.
            let child = unsafe { std::fs::File::from_raw_fd(fd) };
            verify_identity(&child, &stat, &source_path)?;
            let child_destination = destination.join(&name);
            std::fs::create_dir(&child_destination)?;
            copy_directory_unix(
                &child,
                &child_destination,
                &relative_path,
                child_depth,
                budget,
            )?;
        } else if kind == libc::S_IFREG {
            let fd = unsafe {
                libc::openat(
                    source.as_raw_fd(),
                    c_name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let mut input = unsafe { std::fs::File::from_raw_fd(fd) };
            verify_identity(&input, &stat, &source_path)?;
            let output_path = destination.join(&name);
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output_path)?;
            let mut file_bytes = 0;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = std::io::Read::read(&mut input, &mut buffer)?;
                if read == 0 {
                    break;
                }
                budget.file_chunk(file_bytes, read, &source_path)?;
                std::io::Write::write_all(&mut output, &buffer[..read])?;
                file_bytes += read as u64;
                budget.add_bytes(read);
            }
            use std::os::unix::fs::PermissionsExt;
            output.set_permissions(std::fs::Permissions::from_mode(stat.st_mode as u32 & 0o777))?;
        } else {
            return Err(invalid(format!(
                "plugin source contains an unsupported filesystem entry at {}",
                source_path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn verify_identity(file: &std::fs::File, expected: &libc::stat, path: &Path) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let mut actual = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: actual points to writable stat storage and file is a valid descriptor.
    if unsafe { libc::fstat(file.as_raw_fd(), actual.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded.
    let actual = unsafe { actual.assume_init() };
    if actual.st_dev != expected.st_dev
        || actual.st_ino != expected.st_ino
        || (actual.st_mode & libc::S_IFMT) != (expected.st_mode & libc::S_IFMT)
    {
        return Err(invalid(format!(
            "plugin source entry changed while staging: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn directory_names(
    fd: std::os::fd::RawFd,
    max_entries: usize,
    total_limit: usize,
) -> io::Result<Vec<std::ffi::OsString>> {
    // SAFETY: dup creates an independently-owned descriptor suitable for fdopendir.
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fdopendir takes ownership of duplicate on success.
    let dir = unsafe { libc::fdopendir(duplicate) };
    if dir.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(duplicate);
        }
        return Err(error);
    }
    let mut names = Vec::new();
    let mut read_error = 0;
    loop {
        let errno = errno_pointer();
        if !errno.is_null() {
            // SAFETY: errno_pointer returns this thread's writable errno storage.
            unsafe { *errno = 0 };
        }
        // SAFETY: dir remains live until closed below; readdir returns an internal entry pointer.
        let entry = unsafe { libc::readdir(dir) };
        if entry.is_null() {
            if !errno.is_null() {
                // Capture before closedir can overwrite errno.
                read_error = unsafe { *errno };
            }
            break;
        }
        // SAFETY: d_name is NUL terminated as specified by readdir.
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        let bytes = name.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            names.push(std::ffi::OsString::from_vec(bytes.to_vec()));
            if names.len() > max_entries {
                // Stop before retaining an attacker-controlled directory listing in memory.
                unsafe {
                    libc::closedir(dir);
                }
                return Err(invalid(format!(
                    "plugin directory exceeds maximum of {total_limit} filesystem entries"
                )));
            }
        }
    }
    // SAFETY: dir was returned by fdopendir and has not been closed yet.
    let close_rc = unsafe { libc::closedir(dir) };
    if close_rc != 0 {
        return Err(io::Error::last_os_error());
    }
    if read_error != 0 {
        return Err(io::Error::from_raw_os_error(read_error));
    }
    names.sort();
    Ok(names)
}

#[cfg(all(unix, target_os = "macos"))]
fn errno_pointer() -> *mut libc::c_int {
    // SAFETY: this returns the calling thread's errno slot.
    unsafe { libc::__error() }
}

#[cfg(all(unix, any(target_os = "linux", target_os = "android")))]
fn errno_pointer() -> *mut libc::c_int {
    // SAFETY: this returns the calling thread's errno slot.
    unsafe { libc::__errno_location() }
}

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "linux", target_os = "android"))
))]
fn errno_pointer() -> *mut libc::c_int {
    std::ptr::null_mut()
}

#[cfg(unix)]
fn c_name(name: &OsStr) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(name.as_bytes())
        .map_err(|_| invalid("plugin source entry has an invalid name"))
}

#[cfg(unix)]
fn is_node_modules_bin_entry(path: &Path) -> bool {
    // The source root is the boundary. A symlink under node_modules/.bin is skipped,
    // matching the prior staging policy; all other links are rejected.
    let parts = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    parts
        .windows(2)
        .any(|pair| pair == ["node_modules", ".bin"])
}

#[cfg(not(unix))]
fn copy_directory_portable(
    source: &Path,
    destination: &Path,
    relative: &Path,
    depth: usize,
    budget: &mut Budget,
) -> io::Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let relative_path = relative.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&source_path)?;
        let child_depth = depth + 1;
        budget.entry(child_depth, &source_path)?;
        if metadata.file_type().is_symlink() {
            if relative_path
                .components()
                .collect::<Vec<_>>()
                .windows(2)
                .any(|parts| {
                    parts[0].as_os_str() == "node_modules" && parts[1].as_os_str() == ".bin"
                })
            {
                continue;
            }
            return Err(invalid(format!(
                "plugin source contains a symlink at {}",
                source_path.display()
            )));
        }
        if metadata.is_dir() {
            let target = destination.join(entry.file_name());
            std::fs::create_dir(&target)?;
            copy_directory_portable(&source_path, &target, &relative_path, child_depth, budget)?;
        } else if metadata.is_file() {
            let target = destination.join(entry.file_name());
            let mut input = std::fs::File::open(&source_path)?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            let mut file_bytes = 0;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = std::io::Read::read(&mut input, &mut buffer)?;
                if read == 0 {
                    break;
                }
                budget.file_chunk(file_bytes, read, &source_path)?;
                std::io::Write::write_all(&mut output, &buffer[..read])?;
                file_bytes += read as u64;
                budget.add_bytes(read);
            }
        } else {
            return Err(invalid(format!(
                "plugin source contains an unsupported filesystem entry at {}",
                source_path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "plugin_directory_copy_tests.rs"]
mod tests;
