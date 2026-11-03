//! Descriptor-anchored, bounded project-source metadata walk.
//!
//! Unix traversal holds directory descriptors and opens every child relative to
//! its already-open parent with `O_NOFOLLOW`. Non-Unix platforms fail closed
//! until an equivalent race-resistant implementation is available.

#[cfg(not(unix))]
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WalkError {
    UnsafePathOrSwap,
    ReadFailed,
    BoundsExceeded,
    #[allow(dead_code)]
    UnsupportedPlatform,
}

#[cfg(unix)]
mod unix {
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io;
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path};

    use super::WalkError;
    use crate::source_build::metadata::{MAX_SOURCE_DEPTH, MAX_SOURCE_ENTRIES};

    #[cfg(test)]
    enum Event<'a> {
        RootOpened,
        ChildObserved(&'a [u8]),
    }

    struct DirectoryStream(*mut libc::DIR);

    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: fdopendir created this stream and ownership is unique.
                unsafe { libc::closedir(self.0) };
            }
        }
    }

    fn open_directory_at(parent: i32, name: &CStr) -> io::Result<File> {
        // SAFETY: parent is a live directory descriptor and name is NUL terminated.
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
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful openat returned a new exclusively owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn open_absolute_directory(root: &Path) -> Result<File, WalkError> {
        if !root.is_absolute() {
            return Err(WalkError::UnsafePathOrSwap);
        }
        let mut current = File::open("/").map_err(|_| WalkError::UnsafePathOrSwap)?;
        for component in root.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(segment) => {
                    let name = CString::new(segment.as_bytes())
                        .map_err(|_| WalkError::UnsafePathOrSwap)?;
                    current = open_directory_at(current.as_raw_fd(), &name)
                        .map_err(|_| WalkError::UnsafePathOrSwap)?;
                }
                _ => return Err(WalkError::UnsafePathOrSwap),
            }
        }
        Ok(current)
    }

    fn duplicate_stream(directory: &File) -> Result<DirectoryStream, WalkError> {
        // SAFETY: directory owns a live descriptor; dup creates a separate fd.
        let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
        if duplicate < 0 {
            return Err(WalkError::UnsafePathOrSwap);
        }
        // SAFETY: duplicate is a fresh descriptor and fdopendir takes ownership.
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            // SAFETY: fdopendir failed and did not take ownership of duplicate.
            unsafe { libc::close(duplicate) };
            return Err(WalkError::UnsafePathOrSwap);
        }
        Ok(DirectoryStream(stream))
    }

    #[cfg(target_os = "linux")]
    fn errno_pointer() -> Option<*mut libc::c_int> {
        // SAFETY: the C runtime returns this thread's errno storage.
        Some(unsafe { libc::__errno_location() })
    }

    #[cfg(target_os = "macos")]
    fn errno_pointer() -> Option<*mut libc::c_int> {
        // SAFETY: the C runtime returns this thread's errno storage.
        Some(unsafe { libc::__error() })
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn errno_pointer() -> Option<*mut libc::c_int> {
        None
    }

    fn next_entry(
        stream: &DirectoryStream,
        #[cfg(test)] inject_io_error: bool,
    ) -> Result<Option<*mut libc::dirent>, WalkError> {
        let errno = errno_pointer().ok_or(WalkError::UnsupportedPlatform)?;
        // POSIX readdir distinguishes EOF from failure by leaving errno at zero.
        // Clear it before every call so a prior operation cannot be mistaken for
        // a readdir error, then inspect it whenever readdir returns null.
        unsafe { *errno = 0 };

        #[cfg(test)]
        let entry = if inject_io_error {
            unsafe { *errno = libc::EIO };
            std::ptr::null_mut()
        } else {
            // SAFETY: stream remains alive; the returned entry is valid until the
            // next call on this stream.
            unsafe { libc::readdir(stream.0) }
        };
        #[cfg(not(test))]
        let entry = {
            // SAFETY: stream remains alive; the returned entry is valid until the
            // next call on this stream.
            unsafe { libc::readdir(stream.0) }
        };

        if entry.is_null() {
            if unsafe { *errno } == 0 {
                Ok(None)
            } else {
                Err(WalkError::ReadFailed)
            }
        } else {
            Ok(Some(entry))
        }
    }

    fn same_directory_identity(parent: &File, name: &CStr, child: &File) -> Result<(), WalkError> {
        let mut observed = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: parent is a live dir, name is NUL terminated and observed is writable.
        let stat_result = unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                observed.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if stat_result != 0 {
            return Err(WalkError::UnsafePathOrSwap);
        }
        // SAFETY: fstatat succeeded and initialized the structure.
        let observed = unsafe { observed.assume_init() };
        let mut opened = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: child is a live descriptor and opened is writable.
        if unsafe { libc::fstat(child.as_raw_fd(), opened.as_mut_ptr()) } != 0 {
            return Err(WalkError::UnsafePathOrSwap);
        }
        // SAFETY: fstat succeeded and initialized the structure.
        let opened = unsafe { opened.assume_init() };
        if observed.st_dev != opened.st_dev || observed.st_ino != opened.st_ino {
            return Err(WalkError::UnsafePathOrSwap);
        }
        Ok(())
    }

    fn visit(
        root: &Path,
        #[cfg(test)] hook: &mut impl FnMut(Event<'_>),
        #[cfg(test)] inject_error_after_entries: Option<usize>,
    ) -> Result<bool, WalkError> {
        let root_directory = open_absolute_directory(root)?;
        #[cfg(test)]
        hook(Event::RootOpened);
        let mut stack = vec![(root_directory, 0usize)];
        let mut seen = 0usize;
        while let Some((directory, depth)) = stack.pop() {
            if depth > MAX_SOURCE_DEPTH {
                return Err(WalkError::BoundsExceeded);
            }
            let stream = duplicate_stream(&directory)?;
            loop {
                #[cfg(test)]
                let next = next_entry(&stream, inject_error_after_entries == Some(seen));
                #[cfg(not(test))]
                let next = next_entry(&stream);
                let Some(entry) = next? else { break };
                // SAFETY: POSIX dirent names are NUL terminated.
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                let bytes = name.to_bytes();
                if bytes == b"." || bytes == b".." {
                    continue;
                }
                seen += 1;
                if seen > MAX_SOURCE_ENTRIES {
                    return Err(WalkError::BoundsExceeded);
                }
                let mut observed = MaybeUninit::<libc::stat>::uninit();
                // SAFETY: the stream's directory descriptor remains valid and
                // `name` is a NUL-terminated entry from that directory.
                if unsafe {
                    libc::fstatat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        observed.as_mut_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                } != 0
                {
                    return Err(WalkError::UnsafePathOrSwap);
                }
                // SAFETY: fstatat succeeded and initialized the structure.
                let observed = unsafe { observed.assume_init() };
                #[cfg(test)]
                hook(Event::ChildObserved(bytes));
                let file_type = observed.st_mode & libc::S_IFMT;
                if file_type == libc::S_IFLNK {
                    return Err(WalkError::UnsafePathOrSwap);
                }
                if file_type == libc::S_IFDIR {
                    if bytes == b"node_modules"
                        || bytes == b".npm-cache"
                        || bytes == b"dist"
                        || bytes == b".git"
                        || bytes == b"target"
                    {
                        continue;
                    }
                    let child = open_directory_at(directory.as_raw_fd(), name)
                        .map_err(|_| WalkError::UnsafePathOrSwap)?;
                    same_directory_identity(&directory, name, &child)?;
                    stack.push((child, depth + 1));
                } else if file_type == libc::S_IFREG
                    && (bytes.ends_with(b".node") || bytes.ends_with(b".native"))
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub(in crate::source_build) fn find_native_sources(root: &Path) -> Result<bool, WalkError> {
        #[cfg(test)]
        return visit(root, &mut |_| {}, None);
        #[cfg(not(test))]
        visit(root)
    }

    #[cfg(test)]
    pub(in crate::source_build::walk) fn test_walk(
        root: &Path,
        hook: &mut impl FnMut(&'static str, &[u8]),
    ) -> Result<bool, WalkError> {
        visit(
            root,
            &mut |event| match event {
                Event::RootOpened => hook("root-opened", b""),
                Event::ChildObserved(name) => hook("child-observed", name),
            },
            None,
        )
    }

    #[cfg(test)]
    pub(in crate::source_build::walk) fn test_walk_with_readdir_error(
        root: &Path,
        after_entries: usize,
    ) -> Result<bool, WalkError> {
        visit(root, &mut |_| {}, Some(after_entries))
    }
}

#[cfg(unix)]
pub(super) use unix::find_native_sources;

#[cfg(not(unix))]
pub(super) fn find_native_sources(_: &Path) -> Result<bool, WalkError> {
    Err(WalkError::UnsupportedPlatform)
}

#[cfg(test)]
#[cfg(unix)]
use unix::{test_walk, test_walk_with_readdir_error};

#[cfg(all(test, unix))]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{find_native_sources, test_walk, test_walk_with_readdir_error, WalkError};

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[test]
    fn queued_child_replacement_with_outside_symlink_is_rejected() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let queued = root.join("queued");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&queued).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("outside.native"), "outside").unwrap();

        let mut replaced = false;
        let canonical_root = root.canonicalize().unwrap();
        let result = test_walk(&canonical_root, &mut |event, name| {
            if event == "child-observed" && name == b"queued" && !replaced {
                fs::rename(&queued, root.join("parked")).unwrap();
                symlink(&outside, &queued).unwrap();
                replaced = true;
            }
        });
        assert!(replaced);
        assert_eq!(result, Err(WalkError::UnsafePathOrSwap));
    }

    #[test]
    fn root_replacement_after_open_keeps_walk_on_the_open_directory() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("outside.node"), "outside").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let mut replaced = false;

        let result = test_walk(&canonical_root, &mut |event, _| {
            if event == "root-opened" && !replaced {
                fs::rename(&root, temp.path().join("project-held")).unwrap();
                symlink(&outside, &root).unwrap();
                replaced = true;
            }
        });
        assert!(replaced);
        assert_eq!(result, Ok(false));
    }

    #[test]
    fn ancestor_replacement_after_open_keeps_walk_on_the_open_tree() {
        let temp = tempdir().unwrap();
        let ancestor = temp.path().join("workspace");
        let root = ancestor.join("project");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(outside.join("project")).unwrap();
        fs::write(outside.join("project/outside.native"), "outside").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let mut replaced = false;

        let result = test_walk(&canonical_root, &mut |event, _| {
            if event == "root-opened" && !replaced {
                fs::rename(&ancestor, temp.path().join("workspace-held")).unwrap();
                symlink(&outside, &ancestor).unwrap();
                replaced = true;
            }
        });
        assert!(replaced);
        assert_eq!(result, Ok(false));
    }

    #[test]
    fn entry_and_depth_budgets_are_enforced_at_the_boundary() {
        let entry_boundary = tempdir().unwrap();
        for index in 0..crate::source_build::metadata::MAX_SOURCE_ENTRIES {
            fs::write(entry_boundary.path().join(format!("file-{index:04}")), "x").unwrap();
        }
        assert_eq!(
            find_native_sources(&entry_boundary.path().canonicalize().unwrap()),
            Ok(false)
        );

        let entry_root = tempdir().unwrap();
        for index in 0..=crate::source_build::metadata::MAX_SOURCE_ENTRIES {
            fs::write(entry_root.path().join(format!("file-{index:04}")), "x").unwrap();
        }
        assert_eq!(
            find_native_sources(&entry_root.path().canonicalize().unwrap()),
            Err(WalkError::BoundsExceeded)
        );

        let depth_boundary = tempdir().unwrap();
        let mut current = depth_boundary.path().to_path_buf();
        for _ in 0..crate::source_build::metadata::MAX_SOURCE_DEPTH {
            current.push("d");
            fs::create_dir(&current).unwrap();
        }
        assert_eq!(
            find_native_sources(&depth_boundary.path().canonicalize().unwrap()),
            Ok(false)
        );

        let depth_root = tempdir().unwrap();
        let mut current = depth_root.path().to_path_buf();
        for _ in 0..=crate::source_build::metadata::MAX_SOURCE_DEPTH {
            current.push("d");
            fs::create_dir(&current).unwrap();
        }
        assert_eq!(
            find_native_sources(&depth_root.path().canonicalize().unwrap()),
            Err(WalkError::BoundsExceeded)
        );
    }

    #[test]
    fn readdir_io_error_after_a_valid_entry_fails_closed() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("ordinary.txt"), "x").unwrap();

        assert_eq!(
            test_walk_with_readdir_error(&temp.path().canonicalize().unwrap(), 1),
            Err(WalkError::ReadFailed)
        );
    }
}
