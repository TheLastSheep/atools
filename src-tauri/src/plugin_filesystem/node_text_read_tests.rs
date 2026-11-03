use super::{parse_absolute_path, parse_request, read_utf8_path, ReadPlan};
use serde_json::json;
use std::{fs, path::Path};
use tempfile::tempdir;

#[cfg(unix)]
#[test]
fn exact_envelope_and_absolute_utf8_path_are_required() {
    let valid = json!({"method":"readTextPath","params":{"path":"/tmp/文档.md"}});
    assert!(matches!(parse_request(&valid), Ok(ReadPlan::Path(_, leaf)) if leaf == "文档.md"));
    for unsupported_path in [
        json!({"method":"readTextPath","params":{"path":"relative.md"}}),
        json!({"method":"readTextPath","params":{"path":"/tmp/../secret"}}),
        json!({"method":"readTextPath","params":{"path":"/tmp//secret"}}),
        json!({"method":"readTextPath","params":{"path":"/tmp/./secret"}}),
        json!({"method":"readTextPath","params":{"path":"/tmp/secret/"}}),
        json!({"method":"readTextPath","params":{"path":format!("/tmp/a{}b", '\0')}}),
    ] {
        assert_eq!(parse_request(&unsupported_path), Ok(ReadPlan::Unsupported));
    }
    assert!(parse_request(
        &json!({"method":"readTextPath","params":{"path":"/tmp/file","extra":true}})
    )
    .is_err());
    assert!(
        parse_request(&json!({"method":"readFilePath","params":{"path":"/tmp/file"}})).is_err()
    );
    assert!(parse_request(&json!({"method":"readTextPath","params":{"path":7}})).is_err());
    assert!(matches!(
        parse_absolute_path(&format!("/{}", "a".repeat(8191))),
        Some((_, leaf)) if leaf.len() == 8191
    ));
    assert_eq!(parse_absolute_path(&format!("/{}", "a".repeat(8192))), None);
}

#[cfg(unix)]
#[test]
fn bounded_read_matches_utf8_lossy_and_preserves_bom() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("内容.md");
    fs::write(&file, b"\xef\xbb\xbfhello \xff world").unwrap();
    let (parent, leaf) = parse_absolute_path(file.to_str().unwrap()).unwrap();
    assert_eq!(
        read_utf8_path(&parent, &leaf).unwrap().as_deref(),
        Some("\u{feff}hello \u{fffd} world")
    );
}

#[cfg(unix)]
#[test]
fn exact_byte_limit_is_supported_and_oversize_falls_back() {
    let dir = tempdir().unwrap();
    let exact = dir.path().join("exact.txt");
    fs::write(&exact, vec![b'x'; 512 * 1024]).unwrap();
    let (parent, leaf) = parse_absolute_path(exact.to_str().unwrap()).unwrap();
    assert_eq!(
        read_utf8_path(&parent, &leaf).unwrap().unwrap().len(),
        512 * 1024
    );

    let large = dir.path().join("large.txt");
    fs::write(&large, vec![b'x'; 512 * 1024 + 1]).unwrap();
    let (parent, leaf) = parse_absolute_path(large.to_str().unwrap()).unwrap();
    assert_eq!(read_utf8_path(&parent, &leaf).unwrap(), None);

    let invalid = dir.path().join("response-budget.txt");
    fs::write(&invalid, vec![0xff; 512 * 1024]).unwrap();
    let (parent, leaf) = parse_absolute_path(invalid.to_str().unwrap()).unwrap();
    assert_eq!(read_utf8_path(&parent, &leaf).unwrap(), None);
}

#[cfg(unix)]
#[test]
fn missing_errors_are_fixed_and_do_not_include_path() {
    let dir = tempdir().unwrap();
    let private_path = dir.path().join("private-document-secret.md");
    let (parent, leaf) = parse_absolute_path(private_path.to_str().unwrap()).unwrap();
    let error = read_utf8_path(&parent, &leaf).unwrap_err();
    assert_eq!(error, "ERR_ATOOLS_NATIVE_FS:ENOENT");
    assert!(!error.contains("private-document-secret"));
}

#[cfg(unix)]
#[test]
fn permission_errors_when_enforced_are_fixed_without_path_or_content() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let file = dir.path().join("secret-content.txt");
    fs::write(&file, "private body").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0)).unwrap();
    let (parent, leaf) = parse_absolute_path(file.to_str().unwrap()).unwrap();
    if let Err(error) = read_utf8_path(&parent, &leaf) {
        assert_eq!(error, "ERR_ATOOLS_NATIVE_FS:EACCES");
        assert!(!error.contains("secret-content"));
        assert!(!error.contains("private body"));
    }
}

#[cfg(unix)]
#[test]
fn leaf_symlink_directory_and_fifo_return_fallback_without_blocking() {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::symlink},
        time::Instant,
    };
    let dir = tempdir().unwrap();
    let target = dir.path().join("target.txt");
    fs::write(&target, "target").unwrap();
    let link = dir.path().join("link.txt");
    symlink(&target, &link).unwrap();
    let (parent, leaf) = parse_absolute_path(link.to_str().unwrap()).unwrap();
    assert_eq!(read_utf8_path(&parent, &leaf).unwrap(), None);

    let directory = dir.path().join("directory");
    fs::create_dir(&directory).unwrap();
    let (parent, leaf) = parse_absolute_path(directory.to_str().unwrap()).unwrap();
    assert_eq!(read_utf8_path(&parent, &leaf).unwrap(), None);

    let fifo = dir.path().join("pipe");
    let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let (parent, leaf) = parse_absolute_path(fifo.to_str().unwrap()).unwrap();
    let start = Instant::now();
    assert_eq!(read_utf8_path(&parent, &leaf).unwrap(), None);
    assert!(start.elapsed().as_secs() < 1);
}

#[cfg(unix)]
#[test]
fn symlink_parent_is_canonicalized_before_opening_root() {
    use std::os::unix::fs::symlink;
    let dir = tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("doc.txt"), "ok").unwrap();
    let alias = dir.path().join("alias");
    symlink(&real, &alias).unwrap();
    let (parent, leaf) = parse_absolute_path(alias.join("doc.txt").to_str().unwrap()).unwrap();
    assert_eq!(
        read_utf8_path(&parent, &leaf).unwrap().as_deref(),
        Some("ok")
    );
    assert!(Path::new(&parent).is_absolute());
}
