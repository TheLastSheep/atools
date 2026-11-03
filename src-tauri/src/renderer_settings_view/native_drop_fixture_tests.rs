use super::*;

fn owned_paths() -> (tempfile::TempDir, PathBuf, Vec<PathBuf>) {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let paths = OWNED_ROLES
        .iter()
        .map(|(role, directory)| {
            let path = root.join(role);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            if *directory {
                fs::create_dir(&path).unwrap();
            } else {
                fs::write(&path, "owned registration fixture").unwrap();
            }
            path
        })
        .collect();
    (temporary, root, paths)
}

#[test]
fn registry_preserves_the_registered_arc_and_cannot_resurrect_replaced_or_expired_children() {
    let registry = LatestBinding::default();
    assert!(registry.current().is_err());
    let first = Arc::new("first");
    registry.replace(&first).unwrap();
    assert!(Arc::ptr_eq(&first, &registry.current().unwrap()));
    assert_eq!(Arc::strong_count(&first), 1);

    let second = Arc::new("second");
    registry.replace(&second).unwrap();
    assert!(Arc::ptr_eq(&second, &registry.current().unwrap()));
    assert_eq!(Arc::strong_count(&first), 1);
    drop(second);
    assert!(registry.current().is_err());
    assert_eq!(*first, "first");
}

#[cfg(unix)]
#[test]
fn fixture_paths_accept_only_the_four_exact_owned_roles_and_keep_existing_batch_limits() {
    let (_temporary, root, paths) = owned_paths();
    assert!(validate_owned_paths(&root, &paths).is_ok());
    assert!(validate_owned_paths(&root, &[paths[0].clone(), paths[0].clone()]).is_ok());
    assert!(validate_owned_paths(&root, &[]).is_err());
    assert!(validate_owned_paths(&root, &vec![paths[0].clone(); MAX_DROP_PATHS + 1]).is_err());
    let extra = paths[3].join("extra.txt");
    fs::write(&extra, "extra").unwrap();
    assert!(validate_owned_paths(&root, &[extra]).is_err());
    assert!(validate_owned_paths(&root, &[root.join("another.txt")]).is_err());
    assert!(validate_owned_paths(
        &root,
        &[root.join("settings-registration/./owned-file.txt")]
    )
    .is_err());
    assert!(validate_owned_paths(&root.join("."), &paths).is_err());
}

#[cfg(unix)]
#[test]
fn fixture_paths_reject_external_symlinks_and_symlinked_ancestors() {
    use std::os::unix::fs::symlink;
    let (_temporary, root, paths) = owned_paths();
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("external.txt");
    fs::write(&outside_file, "external").unwrap();
    fs::remove_file(&paths[2]).unwrap();
    symlink(&outside_file, &paths[2]).unwrap();
    assert!(validate_owned_paths(&root, &[paths[2].clone()]).is_err());

    fs::remove_file(&paths[2]).unwrap();
    fs::write(&paths[2], "owned").unwrap();
    let registration = root.join("settings-registration");
    let relocated = root.join("relocated-registration");
    fs::rename(&registration, &relocated).unwrap();
    symlink(&relocated, &registration).unwrap();
    assert!(validate_owned_paths(&root, &[paths[2].clone(), paths[3].clone()]).is_err());
}

#[cfg(unix)]
#[test]
fn fixture_paths_reject_nonprivate_root_wrong_role_type_and_hardlinked_file() {
    use std::os::unix::fs::PermissionsExt;
    let (_temporary, root, paths) = owned_paths();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(validate_owned_paths(&root, &paths).is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir(&paths[3]).unwrap();
    fs::write(&paths[3], "wrong type").unwrap();
    assert!(validate_owned_paths(&root, &[paths[3].clone()]).is_err());
    fs::hard_link(&paths[2], root.join("linked-file.txt")).unwrap();
    assert!(validate_owned_paths(&root, &[paths[2].clone()]).is_err());
}

fn receipt(completed: oneshot::Receiver<DropCompletion>) -> FixtureDropReceipt {
    FixtureDropReceipt {
        session_id: "00000000000040008000000000000001".into(),
        child_label: "ztools-settings-00000000000040008000000000000001".into(),
        bundle_revision: "bundle-r1".into(),
        binding_nonce: "00000000000040008000000000000002".into(),
        batch_nonce: "00000000000040008000000000000003".into(),
        completed,
    }
}

#[tokio::test]
async fn completion_retains_batch_counts_and_reports_queue_acceptance_without_delivery_claim() {
    let (sender, receiver) = oneshot::channel();
    sender
        .send(DropCompletion {
            counts: DropCounts {
                added: 2,
                failed: 1,
            },
            result_notice_enqueued: false,
        })
        .unwrap_or_else(|_| panic!("completion receiver disappeared"));
    let completion = receipt(receiver).completion().await.unwrap();
    assert_eq!(completion.added, 2);
    assert_eq!(completion.failed, 1);
    assert!(!completion.result_notice_enqueued);
    assert_eq!(
        serde_json::to_value(&completion).unwrap(),
        json!({"added":2,"failed":1,"resultNoticeEnqueued":false})
    );

    let (sender, receiver) = oneshot::channel::<DropCompletion>();
    drop(sender);
    assert!(receipt(receiver).completion().await.is_err());
}
