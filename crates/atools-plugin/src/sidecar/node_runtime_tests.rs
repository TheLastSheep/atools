use super::*;
use std::ffi::OsStr;

fn search() -> Search {
    Search {
        explicit: None,
        path: None,
        executable: None,
        home: None,
        system: vec![],
    }
}
fn binary(root: &Path, relative: &str) -> PathBuf {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "fixture, never executed").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path.canonicalize().unwrap()
}
fn alias(root: &Path, value: &str) {
    std::fs::create_dir_all(root.join(".nvm/alias")).unwrap();
    std::fs::write(root.join(".nvm/alias/default"), value).unwrap();
}

#[test]
fn explicit_selection_is_exact_and_invalid_selection_never_falls_back() {
    let root = tempfile::tempdir().unwrap();
    let chosen = binary(root.path(), "custom/node");
    let fallback = binary(root.path(), "system/node");
    let mut config = search();
    config.system = vec![fallback];
    config.explicit = Some(chosen.clone().into_os_string());
    assert_eq!(resolve(&config).unwrap(), chosen);
    config.explicit = Some(root.path().join("missing").into_os_string());
    assert!(resolve(&config)
        .unwrap_err()
        .to_string()
        .contains("no fallback"));
    config.explicit = Some("./node".into());
    assert!(resolve(&config).is_err());
}

#[test]
fn packaged_runtime_wins_over_path_and_path_never_searches_plugin_cwd() {
    let root = tempfile::tempdir().unwrap();
    let packaged = binary(
        root.path(),
        &format!("ATools.app/Contents/Resources/runtime/{}", node_name()),
    );
    let inherited = binary(root.path(), &format!("path/{}", node_name()));
    let mut config = search();
    config.executable = Some(binary(root.path(), "ATools.app/Contents/MacOS/atools"));
    config.path =
        Some(std::env::join_paths([Path::new("."), inherited.parent().unwrap()]).unwrap());
    assert_eq!(resolve(&config).unwrap(), packaged);
    config.executable = None;
    assert_eq!(resolve(&config).unwrap(), inherited);
    assert!(from_path(Some(OsStr::new(".")), OsStr::new(node_name())).is_none());
}

#[test]
fn gui_path_finds_configured_nvm_default_without_guessing_another_major() {
    let root = tempfile::tempdir().unwrap();
    let chosen = binary(
        root.path(),
        &format!(".nvm/versions/node/v24.15.0/bin/{}", node_name()),
    );
    binary(
        root.path(),
        &format!(".nvm/versions/node/v26.0.0/bin/{}", node_name()),
    );
    binary(
        root.path(),
        &format!(".nvm/versions/node/v24.14.0/bin/{}", node_name()),
    );
    alias(root.path(), "24.15.0\n");
    let mut config = search();
    config.home = Some(root.path().into());
    assert_eq!(resolve(&config).unwrap(), chosen);
    alias(root.path(), "24");
    assert_eq!(resolve(&config).unwrap(), chosen);
    alias(root.path(), "20");
    assert!(resolve(&config).is_err());
}

#[test]
fn tauri_packaged_sidecar_next_to_the_app_wins_over_resources_and_user_node() {
    let root = tempfile::tempdir().unwrap();
    let sibling = binary(
        root.path(),
        &format!("ATools.app/Contents/MacOS/{}", node_name()),
    );
    binary(
        root.path(),
        &format!("ATools.app/Contents/Resources/runtime/{}", node_name()),
    );
    let inherited = binary(root.path(), &format!("path/{}", node_name()));
    let mut config = search();
    config.executable = Some(binary(root.path(), "ATools.app/Contents/MacOS/atools"));
    config.path = Some(std::env::join_paths([inherited.parent().unwrap()]).unwrap());
    assert_eq!(resolve(&config).unwrap(), sibling);
}

#[test]
fn aliases_are_bounded_and_do_not_execute_shell_or_read_directories() {
    let root = tempfile::tempdir().unwrap();
    binary(
        root.path(),
        &format!(".nvm/versions/node/v24.15.0/bin/{}", node_name()),
    );
    alias(root.path(), "lts/current");
    std::fs::create_dir_all(root.path().join(".nvm/alias/lts")).unwrap();
    std::fs::write(root.path().join(".nvm/alias/lts/current"), "v24.15.0").unwrap();
    let mut config = search();
    config.home = Some(root.path().into());
    assert!(resolve(&config).is_ok());
    for value in ["../../outside", "$(touch should-never-run)", "default"] {
        alias(root.path(), value);
        assert!(resolve(&config).is_err());
    }
    alias(root.path(), &"2".repeat(129));
    assert!(resolve(&config).is_err());
    assert!(read_alias(root.path()).is_none());
}

#[test]
fn rejects_non_executable_candidates_and_reports_missing_node_without_spawning() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("node");
    std::fs::write(&file, "text").unwrap();
    #[cfg(unix)]
    assert!(usable(&file).is_none());
    assert!(usable(root.path()).is_none());
    let error = resolve(&search()).unwrap_err().to_string();
    assert!(error.contains("ATOOLS_NODE_BINARY"));
    assert!(error.contains("core tools remain available"));
}

#[cfg(unix)]
#[test]
fn executable_symlinks_are_resolved_but_fifo_aliases_never_block() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let real = binary(root.path(), "real/node");
    symlink(&real, root.path().join("linked-node")).unwrap();
    assert_eq!(usable(&root.path().join("linked-node")), Some(real));
    let fifo = root.path().join("fifo");
    let raw = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
    let start = std::time::Instant::now();
    assert!(read_alias(&fifo).is_none());
    assert!(start.elapsed() < std::time::Duration::from_millis(100));
}
