//! Confined, bounded reads shared by manifest, HTML and preload resolution.

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

pub(super) fn normalized_relative(base: &Path, value: &str, allow_parent: bool) -> Result<PathBuf> {
    if value.is_empty() || value.contains(['\\', '\0']) || value.contains(':') {
        bail!("Invalid package-relative path: {value:?}");
    }
    let reference = Path::new(value);
    if reference.is_absolute() {
        bail!("Absolute package path is not allowed: {value:?}");
    }
    let mut path = base.to_path_buf();
    for component in reference.components() {
        match component {
            Component::Normal(segment) => path.push(segment),
            Component::CurDir => {}
            Component::ParentDir if allow_parent && path.pop() => {}
            _ => bail!("Package path escapes its package root: {value:?}"),
        }
    }
    if path.as_os_str().is_empty() {
        bail!("Package asset must name a file: {value:?}");
    }
    Ok(path)
}

/// HTML '/assets/app.js' means this selected package's URL root, never an OS root.
/// Input has already been percent-decoded exactly once by the HTML URL helper.
pub(super) fn html_relative(base: &Path, decoded: &str) -> Result<PathBuf> {
    if decoded.starts_with("//") {
        bail!("Encoded network-root HTML asset is not allowed");
    }
    let (base, value) = if let Some(value) = decoded.strip_prefix('/') {
        (Path::new(""), value)
    } else {
        (base, decoded)
    };
    normalized_relative(base, value, true)
}

/// Opens every component without following symlinks on Unix. No source can be borrowed
/// from another package, including when a parent directory is replaced concurrently.
#[cfg(unix)]
fn open_confined(root: &Path, relative: &Path) -> Result<Option<File>> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    // The selected root is already canonical. Open its complete absolute chain
    // without following links, so swapping the root or an ancestor cannot borrow
    // bytes from another directory between authorization and this read.
    if !root.is_absolute() {
        bail!("Package root must be canonical and absolute");
    }
    let mut directory = File::open("/")?;
    for component in root.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(segment) => {
                let name = CString::new(segment.as_bytes())?;
                // SAFETY: directory owns a live fd and name is NUL terminated.
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY
                            | libc::O_CLOEXEC
                            | libc::O_NOFOLLOW
                            | libc::O_DIRECTORY
                            | libc::O_NONBLOCK,
                    )
                };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error())
                        .context("Unsafe package root directory");
                }
                // SAFETY: successful openat returned a fresh exclusively owned fd.
                directory = unsafe { File::from_raw_fd(fd) };
            }
            _ => bail!("Package root must be normalized and absolute"),
        }
    }
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(segment) = component else {
            bail!("Invalid normalized package path")
        };
        let name = CString::new(segment.as_bytes())?;
        let final_component = index + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if final_component {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: name is NUL terminated; directory is owned and remains open for this call.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(error)
                .with_context(|| format!("Unsafe or unreadable package asset {relative:?}"));
        }
        // SAFETY: successful openat returned a fresh fd exclusively owned here.
        let file = unsafe { File::from_raw_fd(fd) };
        if final_component {
            if !file.metadata()?.is_file() {
                bail!("Package asset is not a regular file: {relative:?}");
            }
            return Ok(Some(file));
        }
        directory = file;
    }
    bail!("Empty package asset path")
}

#[cfg(not(unix))]
fn open_confined(root: &Path, relative: &Path) -> Result<Option<File>> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            bail!("Symlink package asset is not allowed: {relative:?}");
        }
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(root) {
        bail!("Package asset escapes package root: {relative:?}");
    }
    let file = File::open(canonical)?;
    if !file.metadata()?.is_file() {
        bail!("Package asset is not a regular file: {relative:?}");
    }
    Ok(Some(file))
}

pub(super) fn asset_exists(root: &Path, relative: &Path) -> Result<bool> {
    Ok(open_confined(root, relative)?.is_some())
}

pub(super) fn read_bytes(
    root: &Path,
    relative: &Path,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        bail!("Package asset path must be a normalized relative file");
    }
    let Some(file) = open_confined(root, relative)? else {
        return Ok(None);
    };
    if file.metadata()?.len() > max_bytes as u64 {
        bail!("Package file exceeds {max_bytes} byte budget: {relative:?}");
    }
    let mut bytes = Vec::new();
    file.take(max_bytes as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        bail!("Package file exceeds {max_bytes} byte budget: {relative:?}");
    }
    Ok(Some(bytes))
}

pub(super) fn read_text(root: &Path, relative: &Path, max_bytes: usize) -> Result<Option<String>> {
    let Some(bytes) = read_bytes(root, relative, max_bytes)? else {
        return Ok(None);
    };
    String::from_utf8(bytes)
        .map(Some)
        .with_context(|| format!("Package file is not UTF-8: {relative:?}"))
}

pub(super) fn canonical_root(root: &Path) -> Result<PathBuf> {
    let root = root
        .canonicalize()
        .with_context(|| format!("Invalid plugin directory {root:?}"))?;
    if !root.is_dir() {
        bail!("Plugin source root is not a directory: {root:?}");
    }
    Ok(root)
}

#[cfg(test)]
mod byte_reader_tests {
    use super::*;

    #[test]
    fn package_asset_byte_reader_is_binary_bounded_and_requires_normalized_relative_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::write(root.join("binary.png"), [0, 255, 42]).unwrap();
        assert_eq!(
            read_bytes(&root, Path::new("binary.png"), 3)
                .unwrap()
                .unwrap(),
            [0, 255, 42]
        );
        assert!(read_bytes(&root, Path::new("binary.png"), 2).is_err());
        for relative in ["../binary.png", "/binary.png", ""] {
            assert!(read_bytes(&root, Path::new(relative), 3).is_err());
        }
        assert!(read_bytes(&root, Path::new("missing.js"), 3)
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn package_asset_byte_reader_rejects_a_selected_root_or_ancestor_replaced_with_a_symlink() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("package");
        let outside = base.join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("entry.js"), b"selected").unwrap();
        std::fs::write(outside.join("entry.js"), b"outside").unwrap();
        assert_eq!(
            read_bytes(&root, Path::new("entry.js"), 20)
                .unwrap()
                .unwrap(),
            b"selected"
        );
        std::fs::rename(&root, base.join("retained")).unwrap();
        symlink(&outside, &root).unwrap();
        assert!(read_bytes(&root, Path::new("entry.js"), 20).is_err());
        let parent = base.join("parent");
        std::fs::create_dir(&parent).unwrap();
        let nested = parent.join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("entry.js"), b"selected").unwrap();
        let other_parent = base.join("other-parent");
        std::fs::create_dir(&other_parent).unwrap();
        std::fs::create_dir(other_parent.join("nested")).unwrap();
        std::fs::write(other_parent.join("nested/entry.js"), b"outside").unwrap();
        std::fs::rename(&parent, base.join("parent-retained")).unwrap();
        symlink(&other_parent, &parent).unwrap();
        assert!(read_bytes(&nested, Path::new("entry.js"), 20).is_err());
    }
}
