use super::{copy_with_limits, Limits};
use std::fs;
use std::path::Path;

fn limits(entries: usize, depth: usize, file_bytes: u64, total_bytes: u64) -> Limits {
    Limits {
        entries,
        depth,
        file_bytes,
        total_bytes,
    }
}

fn staged_pair(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    fs::create_dir_all(root).unwrap();
    let source = root.join("source");
    let destination = root.join("stage");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&destination).unwrap();
    (source, destination)
}

#[test]
fn rejects_entry_count_and_removes_partial_stage() {
    let root = tempfile::tempdir().unwrap();
    let (source, destination) = staged_pair(root.path());
    fs::write(source.join("a"), b"one").unwrap();
    fs::write(source.join("b"), b"two").unwrap();
    let error = copy_with_limits(&source, &destination, limits(1, 8, 16, 32)).unwrap_err();
    assert!(error
        .to_string()
        .contains("maximum of 1 filesystem entries"));
    assert!(
        !destination.exists(),
        "failed staging must remove every partial byte"
    );
}

#[test]
fn rejects_depth_and_file_and_total_byte_overflow() {
    let root = tempfile::tempdir().unwrap();
    let (source, destination) = staged_pair(root.path());
    fs::create_dir(source.join("one")).unwrap();
    fs::create_dir(source.join("one/two")).unwrap();
    fs::write(source.join("one/two/file"), b"12345").unwrap();
    let error = copy_with_limits(&source, &destination, limits(20, 2, 16, 32)).unwrap_err();
    assert!(error.to_string().contains("maximum depth of 2"));
    assert!(!destination.exists());

    fs::remove_dir_all(&destination).unwrap_or(());
    fs::create_dir(&destination).unwrap();
    fs::remove_dir_all(source.join("one")).unwrap();
    fs::write(source.join("file"), b"12345").unwrap();
    let error = copy_with_limits(&source, &destination, limits(20, 8, 4, 32)).unwrap_err();
    assert!(error.to_string().contains("maximum size of 4 bytes"));
    assert!(!destination.exists());

    fs::create_dir(&destination).unwrap();
    fs::write(source.join("file"), b"1234").unwrap();
    fs::write(source.join("second"), b"5678").unwrap();
    let error = copy_with_limits(&source, &destination, limits(20, 8, 8, 7)).unwrap_err();
    assert!(error.to_string().contains("maximum copied size of 7 bytes"));
    assert!(!destination.exists());
}

#[cfg(unix)]
#[test]
fn skips_only_node_modules_bin_symlinks_and_rejects_other_links() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let (source, destination) = staged_pair(root.path());
    fs::create_dir_all(source.join("node_modules/.bin")).unwrap();
    symlink("/missing/target", source.join("node_modules/.bin/tool")).unwrap();
    fs::write(source.join("node_modules/.bin/keep-file"), b"ok").unwrap();
    super::copy_with_limits(&source, &destination, Limits::PRODUCTION).unwrap();
    assert!(!destination.join("node_modules/.bin/tool").exists());
    assert_eq!(
        fs::read(destination.join("node_modules/.bin/keep-file")).unwrap(),
        b"ok"
    );

    let (source, destination) = staged_pair(root.path().join("second").as_path());
    symlink("/missing/target", source.join("ordinary-link")).unwrap();
    let error = super::copy_with_limits(&source, &destination, Limits::PRODUCTION).unwrap_err();
    assert!(error.to_string().contains("contains a symlink"));
    assert!(!destination.exists());
}

#[cfg(unix)]
#[test]
fn rejects_special_files_and_preserves_executable_mode() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let (source, destination) = staged_pair(root.path());
    let executable = source.join("run.sh");
    fs::write(&executable, b"#!/bin/sh\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o751)).unwrap();
    super::copy_with_limits(&source, &destination, Limits::PRODUCTION).unwrap();
    assert_eq!(
        fs::metadata(destination.join("run.sh")).unwrap().mode() & 0o777,
        0o751
    );

    let (source, destination) = staged_pair(root.path().join("fifo").as_path());
    use std::os::unix::ffi::OsStrExt;
    let fifo = std::ffi::CString::new(source.join("pipe").as_os_str().as_bytes()).unwrap();
    // SAFETY: the path is NUL terminated and mkfifo only creates a filesystem node.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let error = super::copy_with_limits(&source, &destination, Limits::PRODUCTION).unwrap_err();
    assert!(error.to_string().contains("unsupported filesystem entry"));
    assert!(!destination.exists());
}
