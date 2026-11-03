use super::*;
use std::io::Write;

const MANIFEST: &[u8] = br#"{"name":"fixture","version":"1","main":"index.html"}"#;

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn fixture() -> (tempfile::TempDir, PathBuf, Vec<u8>) {
    let scratch = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(scratch.path()).unwrap().join("plugin");
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("assets")).unwrap();
    let entries = [
        ("plugin.json", MANIFEST),
        (
            "index.html",
            b"<script src='assets/app.js'></script>".as_slice(),
        ),
        ("assets/app.js", b"window.fixture='original'".as_slice()),
    ];
    for (name, bytes) in entries {
        fs::write(root.join(name), bytes).unwrap();
    }
    (scratch, root, zip_bytes(&entries))
}

#[test]
fn published_package_verification_accepts_exact_zip_bytes_and_file_tree_without_execution() {
    let (_scratch, root, bytes) = fixture();
    let report = verify_archive_tree(&bytes, &root, 3).unwrap();
    assert_eq!(report["sourceBytesUnchanged"], true);
    assert_eq!(report["unchangedFileCount"], 3);
    assert_eq!(report["pluginCodeExecutedByVerification"], false);
    assert_eq!(report["extractedToDisk"], false);
}

#[test]
fn published_package_verification_fixed_zip_rejects_changed_actual_javascript() {
    let (_scratch, root, bytes) = fixture();
    fs::write(root.join("assets/app.js"), b"window.fixture='modified'").unwrap();
    assert!(verify_archive_tree(&bytes, &root, 3)
        .unwrap_err()
        .contains("source bytes differ"));
}

#[test]
fn published_package_verification_rejects_extra_and_missing_files_and_directories() {
    let (_scratch, root, bytes) = fixture();
    fs::write(root.join("extra.js"), b"unreviewed").unwrap();
    assert!(verify_archive_tree(&bytes, &root, 3)
        .unwrap_err()
        .contains("extra"));
    fs::remove_file(root.join("extra.js")).unwrap();
    fs::create_dir(root.join("extra-dir")).unwrap();
    assert!(verify_archive_tree(&bytes, &root, 3)
        .unwrap_err()
        .contains("extra"));
    fs::remove_dir(root.join("extra-dir")).unwrap();
    fs::remove_file(root.join("assets/app.js")).unwrap();
    assert!(verify_archive_tree(&bytes, &root, 3)
        .unwrap_err()
        .contains("missing"));
}

#[cfg(unix)]
#[test]
fn published_package_verification_rejects_source_links_root_links_and_special_inputs() {
    use std::os::unix::fs::symlink;
    let (scratch, root, bytes) = fixture();
    let original = root.join("assets/app.js");
    let outside = scratch.path().join("outside.js");
    fs::rename(&original, &outside).unwrap();
    symlink(&outside, &original).unwrap();
    assert!(verify_archive_tree(&bytes, &root, 3)
        .unwrap_err()
        .contains("symlink"));
    assert!(read_bounded_regular(&original, MAX_ENTRY_BYTES).is_err());
    let alias = fs::canonicalize(scratch.path()).unwrap().join("alias");
    symlink(&root, &alias).unwrap();
    assert!(verify_archive_tree(&bytes, &alias, 3).is_err());
    let fifo = scratch.path().join("input.fifo");
    let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(read_bounded_regular(&fifo, MAX_ENTRY_BYTES).is_err());
}

#[test]
fn published_package_verification_bounds_regular_input_allocation_and_actual_source_size() {
    let (scratch, root, bytes) = fixture();
    let oversized = scratch.path().join("oversized.zip");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(MAX_ARCHIVE_BYTES as u64 + 1)
        .unwrap();
    assert!(read_bounded_regular(&oversized, MAX_ARCHIVE_BYTES)
        .unwrap_err()
        .contains("within"));
    let small = scratch.path().join("small");
    fs::write(&small, b"1234").unwrap();
    assert_eq!(read_bounded_regular(&small, 4).unwrap(), b"1234");
    assert!(read_bounded_regular(&small, 3).is_err());
    fs::File::create(root.join("assets/app.js"))
        .unwrap()
        .set_len(MAX_ENTRY_BYTES as u64 + 1)
        .unwrap();
    assert!(verify_archive_tree(&bytes, &root, 3)
        .unwrap_err()
        .contains("per-file budget"));
}

#[test]
fn published_package_verification_rejects_unsafe_archive_paths_and_wrong_counts() {
    let (_scratch, root, bytes) = fixture();
    assert!(verify_archive_tree(&bytes, &root, 2)
        .unwrap_err()
        .contains("pinned file count"));
    for path in [
        "../escape",
        "/escape",
        "a\\escape",
        "a:stream",
        "x/./bad",
        "x//bad",
    ] {
        let bytes = zip_bytes(&[("plugin.json", MANIFEST), (path, b"bad")]);
        assert!(verify_archive_tree(&bytes, &root, 2).is_err(), "{path}");
    }
}

#[test]
fn published_package_verification_rejects_oversized_archive_entries_and_native_content() {
    let (_scratch, root, _) = fixture();
    let oversized = vec![0u8; MAX_ENTRY_BYTES + 1];
    let bytes = zip_bytes(&[("plugin.json", MANIFEST), ("large.bin", &oversized)]);
    assert!(verify_archive_tree(&bytes, &root, 2)
        .unwrap_err()
        .contains("expanded size"));
    assert!(native_content("preload.node", b"not-even-loaded"));
    assert!(native_content("opaque", b"\x7fELFdata"));
}

#[test]
fn published_package_verification_rejects_unregistered_profile_before_opening_caller_paths() {
    let (_scratch, root, _) = fixture();
    assert!(verify_reviewed_package(
        &json!({}),
        &json!({"caseId":"unknown"}),
        &root,
        &"0".repeat(64)
    )
    .unwrap_err()
    .contains("Unknown"));
}
