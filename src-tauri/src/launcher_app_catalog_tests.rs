use super::*;

fn create_app(root: &Path, relative: &str) -> PathBuf {
    let path = root.join(relative);
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn scan_sorts_deduplicates_and_returns_only_the_fixed_row_shape() {
    let temporary = tempfile::tempdir().unwrap();
    create_app(temporary.path(), "Tools/Zeta.app");
    create_app(temporary.path(), "Alpha.app");

    let apps = scan_roots_with_limits(
        &[
            temporary.path().to_path_buf(),
            temporary.path().to_path_buf(),
        ],
        MAX_DEPTH,
        MAX_ENTRIES,
        MAX_APPS,
    )
    .unwrap();

    assert_eq!(
        apps.iter().map(|app| app.name.as_str()).collect::<Vec<_>>(),
        ["Alpha", "Zeta"]
    );
    let expected_icon =
        crate::launcher_app_icons::icon_url(&temporary.path().join("Alpha.app").to_string_lossy());
    assert_eq!(apps[0].icon.as_deref(), Some(expected_icon.as_str()));
    let serialized = serde_json::to_value(&apps[0]).unwrap();
    assert_eq!(
        serialized,
        serde_json::json!({
            "name": "Alpha",
            "path": temporary.path().join("Alpha.app").to_string_lossy(),
            "icon": expected_icon
        })
    );
}

#[cfg(unix)]
#[test]
fn scan_respects_depth_and_does_not_follow_symlinked_directories() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("root");
    let outside = temporary.path().join("outside");
    fs::create_dir_all(&root).unwrap();
    create_app(&root, "Direct.app");
    create_app(&root, "Nested/TooDeep.app");
    create_app(&outside, "Escaped.app");
    symlink(&outside, root.join("escape")).unwrap();

    let apps = scan_roots_with_limits(&[root], 0, MAX_ENTRIES, MAX_APPS).unwrap();
    assert_eq!(
        apps.iter().map(|app| app.name.as_str()).collect::<Vec<_>>(),
        ["Direct"]
    );
}

#[test]
fn scan_stops_at_the_global_entry_budget() {
    let temporary = tempfile::tempdir().unwrap();
    for index in 0..12 {
        create_app(temporary.path(), &format!("App{index:02}.app"));
    }

    let (apps, visited_entries) =
        scan_roots_with_stats(&[temporary.path().to_path_buf()], MAX_DEPTH, 3, MAX_APPS).unwrap();

    assert_eq!(visited_entries, 3);
    assert!(apps.len() <= 3);
}

#[test]
fn cache_reuses_a_snapshot_until_ttl_then_refreshes() {
    let temporary = tempfile::tempdir().unwrap();
    create_app(temporary.path(), "First.app");
    let roots = [temporary.path().to_path_buf()];
    let started_at = Instant::now();
    let mut cache = CatalogCache::default();

    assert_eq!(cache.snapshot(&roots, started_at).unwrap().len(), 1);
    create_app(temporary.path(), "Second.app");
    assert_eq!(
        cache
            .snapshot(&roots, started_at + Duration::from_secs(5))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        cache
            .snapshot(&roots, started_at + CACHE_TTL + Duration::from_secs(1))
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn catalog_command_guard_is_main_window_only() {
    assert!(ensure_main_webview("main").is_ok());
    assert_eq!(
        ensure_main_webview("plugin-window-1").unwrap_err(),
        "Launcher app catalog is available only to the main window"
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_is_an_explicit_error() {
    assert_eq!(
        default_roots().unwrap_err(),
        "Launcher app catalog is unsupported on this platform"
    );
}
