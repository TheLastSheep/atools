use super::*;

fn temp() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

#[test]
fn snapshot_skips_build_dependencies_but_copies_only_owned_regular_source() {
    let source = temp();
    for excluded in ["node_modules", ".npm-cache", ".git", "dist"] {
        fs::create_dir(source.path().join(excluded)).unwrap();
        fs::write(source.path().join(excluded).join("large"), b"ignored").unwrap();
    }
    fs::write(source.path().join("index.html"), b"source").unwrap();
    for secret in [".env", ".env.local", ".npmrc", ".yarnrc.yml"] {
        fs::write(source.path().join(secret), b"private config").unwrap();
    }
    let workspace = Workspace::create().unwrap();
    let stats = snapshot(
        source.path(),
        &workspace.root.join("work"),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(stats.entries, 1);
    assert_eq!(stats.bytes, 6);
    assert_eq!(
        read_regular(&workspace.root.join("work/index.html"), 6).unwrap(),
        b"source"
    );
    assert!(!workspace.root.join("work/node_modules").exists());
}

#[cfg(unix)]
#[test]
fn source_symlink_hardlink_native_and_output_symlink_are_rejected() {
    let temp = temp();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    let outside = temp.path().join("outside");
    fs::write(&outside, b"private").unwrap();
    std::os::unix::fs::symlink(&outside, source.join("alias")).unwrap();
    let workspace = Workspace::create().unwrap();
    assert!(
        snapshot(&source, &workspace.root.join("a"), &AtomicBool::new(false))
            .unwrap_err()
            .contains("Symlink")
    );
    fs::remove_file(source.join("alias")).unwrap();
    fs::hard_link(&outside, source.join("alias")).unwrap();
    assert!(
        snapshot(&source, &workspace.root.join("b"), &AtomicBool::new(false))
            .unwrap_err()
            .contains("Hardlink")
    );
    fs::remove_file(source.join("alias")).unwrap();
    fs::write(source.join("addon.node"), b"native").unwrap();
    assert!(
        snapshot(&source, &workspace.root.join("c"), &AtomicBool::new(false))
            .unwrap_err()
            .contains("NativeAddon")
    );
    fs::remove_file(source.join("addon.node")).unwrap();
    std::os::unix::fs::symlink(&outside, source.join("alias")).unwrap();
    assert!(verify_output(&source, &AtomicBool::new(false))
        .unwrap_err()
        .contains("Symlink"));
}

#[test]
fn file_bounds_and_cancel_are_not_metadata_only() {
    let temp = temp();
    fs::write(temp.path().join("file"), b"abcdef").unwrap();
    assert!(read_regular(&temp.path().join("file"), 5)
        .unwrap_err()
        .contains("LimitExceeded"));
    let workspace = Workspace::create().unwrap();
    assert_eq!(
        snapshot(
            temp.path(),
            &workspace.root.join("work"),
            &AtomicBool::new(true)
        )
        .unwrap_err(),
        "SOURCE_BUILD_CANCELLED"
    );
}

#[test]
fn workspace_drop_removes_only_owned_tree_and_quarantine_preserves_uncertain_writer() {
    let source = temp();
    fs::write(source.path().join("keep"), b"source").unwrap();
    let owned = Workspace::create().unwrap();
    let root = owned.root.clone();
    drop(owned);
    assert!(!root.exists());
    assert!(source.path().join("keep").exists());
    let mut owned = Workspace::create().unwrap();
    let root = owned.root.clone();
    owned.mark_running();
    drop(owned);
    assert!(root.exists());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn digest_uses_copied_bytes_and_shared_exclusions_and_filename_boundaries() {
    let source = temp();
    fs::write(source.path().join("a"), b"bc").unwrap();
    fs::write(source.path().join("d"), b"e").unwrap();
    let cancel = AtomicBool::new(false);
    let (before, _) = source_digest(source.path(), &cancel).unwrap();
    let workspace = Workspace::create().unwrap();
    let copy = workspace.root.join("work");
    snapshot(source.path(), &copy, &cancel).unwrap();
    assert_eq!(source_digest(&copy, &cancel).unwrap().0, before);
    fs::create_dir(copy.join("node_modules")).unwrap();
    fs::write(copy.join("node_modules/ignored"), b"ignored").unwrap();
    fs::create_dir(copy.join(".npm-cache")).unwrap();
    fs::write(copy.join(".npm-cache/ignored"), b"ignored").unwrap();
    assert_eq!(source_digest(&copy, &cancel).unwrap().0, before);
    fs::rename(copy.join("a"), copy.join("ab")).unwrap();
    fs::write(copy.join("ab"), b"c").unwrap();
    assert_ne!(source_digest(&copy, &cancel).unwrap().0, before);
}
