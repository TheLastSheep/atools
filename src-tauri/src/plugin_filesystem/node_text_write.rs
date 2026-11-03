//! Bounded Node `writeFileSync(path, text, 'utf8')` compatibility adapter.
//!
//! Cancellation/deadline checks prevent queued work from beginning a write
//! after its caller is gone. Once create/truncate enters the OS call, the write
//! cannot be rolled back and an already-running syscall may finish later.
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_TEXT_BYTES: usize = 512 * 1024;

#[cfg(all(test, unix))]
#[path = "node_text_write_tests.rs"]
mod tests;

enum WritePlan {
    Unsupported,
    Path {
        parent: PathBuf,
        leaf: String,
        text: String,
    },
}

/// Handles only the exact bridge envelope. Unsupported paths return false before
/// creating or changing a file; once a write begins, every failure is an error.
pub(crate) async fn handle(request: &Value) -> Result<Value, String> {
    handle_authorized(request, || Ok(())).await
}

pub(crate) async fn handle_authorized<F>(request: &Value, authorize: F) -> Result<Value, String>
where
    F: Fn() -> Result<(), String> + Send + 'static,
{
    handle_authorized_with_deadline(request, authorize, Duration::from_secs(5)).await
}

async fn handle_authorized_with_deadline<F>(
    request: &Value,
    authorize: F,
    deadline: Duration,
) -> Result<Value, String>
where
    F: Fn() -> Result<(), String> + Send + 'static,
{
    let plan = parse_request(request).map_err(|()| native_error("EINVAL"))?;
    let WritePlan::Path { parent, leaf, text } = plan else {
        return Ok(json!({"handled":false}));
    };
    #[cfg(not(unix))]
    {
        let _ = (parent, leaf, text);
        return Ok(json!({"handled":false}));
    }
    #[cfg(unix)]
    {
        let handled = super::node_text_io::run_with_deadline(
            move |guard| write_utf8_path(&parent, &leaf, &text, &guard, &authorize),
            deadline,
        )
        .await?;
        Ok(json!({"handled":handled}))
    }
}

fn parse_request(request: &Value) -> Result<WritePlan, ()> {
    let object = request.as_object().ok_or(())?;
    if object.len() != 2
        || object.get("method").and_then(Value::as_str) != Some("writeTextPath")
        || !object.contains_key("params")
    {
        return Err(());
    }
    let params = object.get("params").and_then(Value::as_object).ok_or(())?;
    if params.len() != 2 {
        return Err(());
    }
    let path = params.get("path").and_then(Value::as_str).ok_or(())?;
    let text = params.get("text").and_then(Value::as_str).ok_or(())?;
    let Some((parent, leaf)) = super::node_text_read::parse_absolute_path(path) else {
        return Ok(WritePlan::Unsupported);
    };
    if text.len() > MAX_TEXT_BYTES {
        return Ok(WritePlan::Unsupported);
    }
    Ok(WritePlan::Path {
        parent,
        leaf,
        text: text.to_owned(),
    })
}

#[cfg(unix)]
fn write_utf8_path<F>(
    parent: &Path,
    leaf: &str,
    text: &str,
    guard: &super::node_text_io::IoGuard,
    authorize: &F,
) -> Result<bool, String>
where
    F: Fn() -> Result<(), String>,
{
    use std::{
        ffi::CString,
        fs::{self, File},
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
    };

    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| native_error(io_code(&error)))?;
    let parent_fd = open_absolute_directory(&canonical_parent)?;
    let leaf_c = CString::new(leaf.as_bytes()).map_err(|_| native_error("EINVAL"))?;
    let mut expected: libc::stat = unsafe { std::mem::zeroed() };
    let stat_result = unsafe {
        libc::fstatat(
            parent_fd.as_raw_fd(),
            leaf_c.as_ptr(),
            &mut expected,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if stat_result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            return create_new_file(parent_fd.as_raw_fd(), &leaf_c, text, guard, authorize);
        }
        return Err(native_error(io_code(&error)));
    }
    match expected.st_mode & libc::S_IFMT {
        libc::S_IFLNK => return Ok(false),
        libc::S_IFREG => {}
        _ => return Ok(false),
    }

    let fd = unsafe {
        libc::openat(
            parent_fd.as_raw_fd(),
            leaf_c.as_ptr(),
            libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        return Err(native_error(io_code(&error)));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let opened = file
        .metadata()
        .map_err(|error| native_error(io_code(&error)))?;
    if !opened.is_file()
        || opened.dev() != expected.st_dev as u64
        || opened.ino() != expected.st_ino as u64
    {
        return Err(native_error("EIO"));
    }
    guard.ensure_current()?;
    authorize()?;
    guard.ensure_current()?;
    file.set_len(0)
        .map_err(|error| native_error(io_code(&error)))?;
    (&file)
        .write_all(text.as_bytes())
        .map_err(|error| native_error(io_code(&error)))?;
    Ok(true)
}

#[cfg(unix)]
fn create_new_file(
    parent_fd: libc::c_int,
    leaf: &std::ffi::CString,
    text: &str,
    guard: &super::node_text_io::IoGuard,
    authorize: &impl Fn() -> Result<(), String>,
) -> Result<bool, String> {
    use std::{fs::File, io::Write, os::fd::FromRawFd};
    guard.ensure_current()?;
    authorize()?;
    guard.ensure_current()?;
    let fd = unsafe {
        libc::openat(
            parent_fd,
            leaf.as_ptr(),
            libc::O_WRONLY
                | libc::O_CREAT
                | libc::O_EXCL
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK,
            0o666 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(native_error(io_code(&std::io::Error::last_os_error())));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(text.as_bytes())
        .map_err(|error| native_error(io_code(&error)))?;
    Ok(true)
}

#[cfg(unix)]
fn open_absolute_directory(path: &Path) -> Result<std::fs::File, String> {
    use std::{
        ffi::CString,
        fs::File,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    let root = CString::new(b"/").expect("static root path");
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            directory_search_flag() | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(native_error(io_code(&std::io::Error::last_os_error())));
    }
    let mut current = unsafe { File::from_raw_fd(fd) };
    for component in path.components().skip(1) {
        let std::path::Component::Normal(name) = component else {
            return Err(native_error("EINVAL"));
        };
        let name = CString::new(name.as_bytes()).map_err(|_| native_error("EINVAL"))?;
        let next = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                directory_search_flag() | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if next < 0 {
            return Err(native_error(io_code(&std::io::Error::last_os_error())));
        }
        current = unsafe { File::from_raw_fd(next) };
    }
    Ok(current)
}

#[cfg(target_os = "macos")]
fn directory_search_flag() -> libc::c_int {
    libc::O_SEARCH
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn directory_search_flag() -> libc::c_int {
    libc::O_PATH
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
fn directory_search_flag() -> libc::c_int {
    // Conservative fallback for other Unix targets; permission behavior is unverified.
    libc::O_RDONLY
}

#[cfg(unix)]
fn io_code(error: &std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EACCES) | Some(libc::EPERM) => "EACCES",
        Some(libc::ELOOP) => "ELOOP",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::ENOSPC) => "ENOSPC",
        Some(libc::EROFS) => "EROFS",
        Some(libc::EEXIST) => "EEXIST",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::EFBIG) => "EFBIG",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::ENOTSUP) => "ENOTSUP",
        _ => match error.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            std::io::ErrorKind::InvalidInput => "EINVAL",
            _ => "EIO",
        },
    }
}

fn native_error(code: &str) -> String {
    format!("ERR_ATOOLS_NATIVE_FS:{code}")
}
