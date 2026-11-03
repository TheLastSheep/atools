use super::*;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn temp() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

#[test]
fn observed_child_swapped_for_outside_symlink_never_enumerates_outside_directories() {
    let temp = temp();
    let root = temp.path().join("source");
    let outside = temp.path().join("outside");
    fs::create_dir_all(root.join("queued")).unwrap();
    fs::create_dir_all(outside.join("external-empty")).unwrap();
    let workspace = Workspace::create().unwrap();
    let output = workspace.root.join("copy");
    fs::create_dir(&output).unwrap();
    let mut swapped = false;
    let result = walk::tree(
        &root,
        Some(&output),
        true,
        &AtomicBool::new(false),
        |event| {
            if let walk::Event::BeforeDirectoryOpen(path) = event {
                if path == Path::new("queued") && !swapped {
                    fs::rename(root.join("queued"), root.join("held")).unwrap();
                    symlink(&outside, root.join("queued")).unwrap();
                    swapped = true;
                }
            }
        },
    );
    assert!(swapped && result.is_err());
    assert!(!output.join("queued/external-empty").exists());
}

#[test]
fn ancestor_path_swap_after_root_open_stays_on_pinned_tree() {
    let temp = temp();
    let ancestor = temp.path().join("workspace");
    let root = ancestor.join("source");
    let outside = temp.path().join("outside");
    fs::create_dir_all(root.join("owned-empty")).unwrap();
    fs::create_dir_all(outside.join("source/external-empty")).unwrap();
    let workspace = Workspace::create().unwrap();
    let output = workspace.root.join("copy");
    fs::create_dir(&output).unwrap();
    let mut swapped = false;
    let result = walk::tree(
        &root,
        Some(&output),
        true,
        &AtomicBool::new(false),
        |event| {
            if matches!(event, walk::Event::RootOpened) && !swapped {
                fs::rename(&ancestor, temp.path().join("held")).unwrap();
                symlink(&outside, &ancestor).unwrap();
                swapped = true;
            }
        },
    );
    assert!(swapped && result.is_ok());
    assert!(output.join("owned-empty").is_dir());
    assert!(!output.join("external-empty").exists());
}

#[test]
fn restricted_root_is_restored_only_through_owned_anchor() {
    let signal = Arc::new(AtomicBool::new(false));
    let mut workspace = Workspace::with_signal(signal.clone()).unwrap();
    let root = workspace.root.clone();
    fs::write(root.join("owned"), "fixture").unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0)).unwrap();
    workspace.cleanup().unwrap();
    assert!(!root.exists());
    assert!(!signal.load(Ordering::Acquire));
}

#[test]
fn inaccessible_child_cleanup_fails_explicitly_records_and_preserves_external_hardlink_mode() {
    let outside = temp();
    let canary = outside.path().join("canary");
    fs::write(&canary, "outside").unwrap();
    fs::set_permissions(&canary, fs::Permissions::from_mode(0o444)).unwrap();
    let signal = Arc::new(AtomicBool::new(false));
    let mut workspace = Workspace::with_signal(signal.clone()).unwrap();
    let root = workspace.root.clone();
    fs::hard_link(&canary, root.join("alias")).unwrap();
    fs::create_dir(root.join("locked")).unwrap();
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0)).unwrap();
    assert_eq!(
        workspace.cleanup().unwrap_err(),
        "SOURCE_BUILD_CLEANUP_UNCONFIRMED"
    );
    assert!(signal.load(Ordering::Acquire));
    assert!(root.exists());
    let record = root.join(".atools-cleanup-recovery.json");
    assert!(record.is_file());
    assert_eq!(fs::metadata(&canary).unwrap().mode() & 0o777, 0o444);
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o700)).unwrap();
    workspace.cleanup().unwrap();
    assert_eq!(fs::read_to_string(canary).unwrap(), "outside");
}
