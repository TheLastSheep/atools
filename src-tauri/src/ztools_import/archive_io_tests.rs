use super::*;

#[test]
fn archive_reader_rejects_oversized_or_nonregular_sources_before_reading() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source.asar");
    fs::write(&source, b"regular").unwrap();
    assert_eq!(read_archive_bytes(&source).unwrap(), b"regular");
    fs::File::create(&source)
        .unwrap()
        .set_len(MAX_ARCHIVE_BYTES + 1)
        .unwrap();
    assert!(read_archive_bytes(&source)
        .unwrap_err()
        .contains("regular file within"));
    assert!(read_archive_bytes(scratch.path()).is_err());
}

#[cfg(unix)]
#[test]
fn archive_reader_does_not_follow_links_or_wait_on_fifos() {
    use std::os::unix::fs::symlink;
    let scratch = tempfile::tempdir().unwrap();
    let original = scratch.path().join("original.asar");
    let link = scratch.path().join("link.asar");
    fs::write(&original, b"regular").unwrap();
    symlink(&original, &link).unwrap();
    assert!(read_archive_bytes(&link).is_err());
    let fifo = scratch.path().join("fifo.asar");
    make_fifo(&fifo);
    assert!(read_archive_bytes(&fifo).is_err());
}

#[test]
fn unpacked_reader_is_bounded_and_retains_archive_path_and_format_guards() {
    let scratch = tempfile::tempdir().unwrap();
    let archive = scratch.path().join("fixture.asar");
    let root = archive.with_extension("asar.unpacked");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("asset.bin"), b"original").unwrap();
    let read = |source: &Path, path: &str| {
        super::archive::read_unpacked_archive_entry(source, Path::new(path))
    };
    assert_eq!(read(&archive, "asset.bin").unwrap(), b"original");
    assert!(read(&archive, "../asset.bin").is_err());
    assert!(read(&archive.with_extension("zpx"), "asset.bin").is_err());
    let oversized = root.join("oversized.bin");
    fs::File::create(oversized)
        .unwrap()
        .set_len(MAX_ENTRY_BYTES as u64 + 1)
        .unwrap();
    assert!(read(&archive, "oversized.bin")
        .unwrap_err()
        .contains("budget"));
}

#[cfg(unix)]
#[test]
fn unpacked_reader_rejects_root_nested_and_leaf_links_and_fifo() {
    use std::os::unix::fs::symlink;
    let scratch = tempfile::tempdir().unwrap();
    let archive = scratch.path().join("fixture.asar");
    let root = archive.with_extension("asar.unpacked");
    fs::create_dir(&root).unwrap();
    let outside = scratch.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("asset.bin"), b"external").unwrap();
    symlink(outside.join("asset.bin"), root.join("leaf.bin")).unwrap();
    symlink(&outside, root.join("nested")).unwrap();
    let fifo = root.join("fifo.bin");
    make_fifo(&fifo);
    for relative in ["leaf.bin", "nested/asset.bin", "fifo.bin"] {
        assert!(
            super::archive::read_unpacked_archive_entry(&archive, Path::new(relative)).is_err()
        );
    }
    fs::remove_dir_all(&root).unwrap();
    symlink(&outside, &root).unwrap();
    assert!(super::archive::read_unpacked_archive_entry(&archive, Path::new("asset.bin")).is_err());
}

#[cfg(unix)]
fn make_fifo(path: &Path) {
    let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: the fixture-owned path is NUL terminated; mode is a valid FIFO permission mask.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
}
