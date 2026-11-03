use super::scoped_documents::{DocumentAccess, ScopedDocumentRoot};
use std::{
    ffi::CString,
    fs::{self, hard_link},
    os::unix::{
        ffi::OsStrExt,
        fs::{symlink, MetadataExt},
    },
    path::Path,
    time::UNIX_EPOCH,
};

fn root(path: &Path, access: DocumentAccess) -> ScopedDocumentRoot {
    ScopedDocumentRoot::open(path, access).expect("open fixed test root")
}

#[test]
fn requires_an_absolute_root() {
    assert_eq!(
        ScopedDocumentRoot::open("relative-root", DocumentAccess::ReadOnly)
            .err()
            .unwrap()
            .code(),
        "EINVAL"
    );
}

#[test]
fn reads_writes_metadata_and_missing_entries() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("nested")).unwrap();
    fs::write(temp.path().join("nested/doc.txt"), "before").unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    assert_eq!(docs.read_text("nested/doc.txt").unwrap(), "before");
    let observed = docs.metadata("nested/doc.txt").unwrap();
    assert_eq!(observed.len, 6);
    assert!(docs.metadata("nested").unwrap().is_directory);
    let modified = fs::metadata(temp.path().join("nested/doc.txt"))
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i128;
    assert_eq!(observed.modified_ms, modified);
    assert!(docs.exists("nested/doc.txt").unwrap());
    assert!(!docs.exists("nested/missing").unwrap());
    docs.write_text_atomic("nested/doc.txt", "after").unwrap();
    assert_eq!(docs.read_text("nested/doc.txt").unwrap(), "after");
    assert!(fs::read_dir(temp.path().join("nested"))
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
}

#[test]
fn rejects_oversize_without_truncating_and_rejects_invalid_utf8() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("large"), vec![b'x'; 512 * 1024 + 1]).unwrap();
    fs::write(temp.path().join("invalid"), [0xff]).unwrap();
    fs::write(temp.path().join("small"), "keep").unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    assert_eq!(docs.read_text("large").unwrap_err().code(), "EFBIG");
    assert_eq!(docs.read_text("invalid").unwrap_err().code(), "EINVAL");
    assert_eq!(
        docs.write_text_atomic("small", &"x".repeat(512 * 1024 + 1))
            .unwrap_err()
            .code(),
        "EFBIG"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("small")).unwrap(),
        "keep"
    );
}

#[test]
fn unicode_names_and_exact_byte_limit_roundtrip() {
    const LIMIT: usize = 512 * 1024;
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("资料")).unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    let exact = format!("{}é", "中".repeat((LIMIT - 2) / 3));
    assert_eq!(exact.len(), LIMIT);
    docs.write_text_atomic("资料/文本.md", &exact).unwrap();
    assert_eq!(docs.read_text("资料/文本.md").unwrap(), exact);

    let oversized = "中".repeat(LIMIT / 3 + 1);
    assert_eq!(oversized.len(), LIMIT + 1);
    assert_eq!(
        docs.write_text_atomic("资料/文本.md", &oversized)
            .unwrap_err()
            .code(),
        "EFBIG"
    );
    assert_eq!(docs.read_text("资料/文本.md").unwrap().len(), LIMIT);
}

#[test]
fn directories_and_fifos_are_rejected_without_blocking() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("directory")).unwrap();
    let fifo_path = temp.path().join("pipe");
    let fifo_c = CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    assert_eq!(docs.read_text("directory").unwrap_err().code(), "EISDIR");
    assert_eq!(docs.read_text("pipe").unwrap_err().code(), "EINVAL");
    let fifo_metadata = docs.metadata("pipe").unwrap();
    assert!(!fifo_metadata.is_file && !fifo_metadata.is_directory);
}

#[test]
fn readonly_never_writes() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("doc"), "original").unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadOnly);
    assert_eq!(
        docs.write_text_atomic("doc", "changed").unwrap_err().code(),
        "EACCES"
    );
    assert_eq!(
        docs.write_text_atomic("new", "changed").unwrap_err().code(),
        "EACCES"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("doc")).unwrap(),
        "original"
    );
    assert!(!temp.path().join("new").exists());
}

#[test]
fn rejects_non_normal_relative_paths() {
    let temp = tempfile::tempdir().unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    for path in [
        "",
        "/etc/passwd",
        "../outside",
        "a/../outside",
        "./doc",
        "a//b",
        "a/",
    ] {
        assert_eq!(docs.exists(path).unwrap_err().code(), "EINVAL", "{path:?}");
    }
}

#[test]
fn enforces_relative_path_budget_before_io() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("preserve"), "unchanged").unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    let too_long = "x".repeat(16 * 1024 + 1);
    let too_deep = vec!["missing"; 129].join("/");
    for path in [&too_long, &too_deep] {
        assert_eq!(docs.exists(path).unwrap_err().code(), "ENAMETOOLONG");
    }
    assert_eq!(
        fs::read_to_string(temp.path().join("preserve")).unwrap(),
        "unchanged"
    );
}

#[test]
fn refuses_symlink_leaf_and_parent() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "untouched").unwrap();
    symlink(outside.path().join("secret"), temp.path().join("leaf")).unwrap();
    symlink(outside.path(), temp.path().join("parent")).unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    assert_eq!(docs.read_text("leaf").unwrap_err().code(), "EACCES");
    assert_eq!(docs.metadata("leaf").unwrap_err().code(), "EACCES");
    assert_eq!(docs.exists("leaf").unwrap_err().code(), "EACCES");
    assert_eq!(
        docs.write_text_atomic("leaf", "changed")
            .unwrap_err()
            .code(),
        "EACCES"
    );
    assert!(docs.read_text("parent/secret").is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("secret")).unwrap(),
        "untouched"
    );
}

#[test]
fn atomic_replacement_does_not_mutate_hardlink_alias() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("doc"), "old").unwrap();
    hard_link(temp.path().join("doc"), temp.path().join("alias")).unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    docs.write_text_atomic("doc", "new").unwrap();
    assert_eq!(fs::read_to_string(temp.path().join("doc")).unwrap(), "new");
    assert_eq!(
        fs::read_to_string(temp.path().join("alias")).unwrap(),
        "old"
    );
    assert_eq!(
        fs::metadata(temp.path().join("doc")).unwrap().mode() & 0o777,
        0o600
    );
}

#[test]
fn early_failures_do_not_create_temporary_files() {
    let temp = tempfile::tempdir().unwrap();
    let docs = root(temp.path(), DocumentAccess::ReadWrite);
    assert_eq!(
        docs.write_text_atomic("missing/doc", "text")
            .unwrap_err()
            .code(),
        "ENOENT"
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}
