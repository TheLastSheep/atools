use std::{
    env, fs,
    path::{Path, PathBuf},
};

use super::Profile;

#[path = "profile_builtin_state_tests.rs"]
mod builtin_state;
#[path = "profile_main_panel_tests.rs"]
mod main_panel;

fn unique_root() -> PathBuf {
    env::temp_dir().join(format!(
        "atools-renderer-smoke-test-{}",
        uuid::Uuid::new_v4()
    ))
}

fn args(root: &Path, dist: &Path, output: &Path) -> Vec<String> {
    [
        "--fixture-root".to_string(),
        root.to_string_lossy().into_owned(),
        "--renderer-dist".to_string(),
        dist.to_string_lossy().into_owned(),
        "--output".to_string(),
        output.to_string_lossy().into_owned(),
        "--auto-clear".to_string(),
        "never".to_string(),
    ]
    .into_iter()
    .collect()
}

#[test]
fn parses_strict_flags_and_generates_isolated_identifier() {
    let temporary = tempfile::tempdir().unwrap();
    let root = unique_root();
    let output = temporary.path().join("report.json");
    let profile = Profile::from_args(&args(&root, temporary.path(), &output)).unwrap();

    assert_eq!(profile.root, root);
    assert_eq!(profile.dist, temporary.path());
    assert_eq!(profile.output, output);
    assert_eq!(profile.auto_clear, "never");
    assert!(!profile.settings_journey);
    assert!(!profile.settings_input_journey);
    assert!(!profile.launcher_journey);
    assert!(!profile.launch_return_journey);
    assert!(!profile.catalog_journey);
    assert!(!profile.window_drag);
    assert!(profile.identifier.starts_with("dev.atools.renderer-smoke."));
    let uuid = profile
        .identifier
        .strip_prefix("dev.atools.renderer-smoke.")
        .unwrap();
    assert!(uuid::Uuid::parse_str(uuid).is_ok());
}

#[test]
fn settings_input_is_an_independent_hidden_profile_with_strict_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let mut values = args(
        &unique_root(),
        temporary.path(),
        &temporary.path().join("report.json"),
    );
    values.extend(["--journey".into(), "settings-input".into()]);
    let result = Profile::from_args(&values);
    if cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        let profile = result.unwrap();
        assert!(profile.settings_input_journey);
        assert!(!profile.settings_journey && !profile.catalog_journey);
        assert!(
            !profile.launcher_journey && !profile.launch_return_journey && !profile.window_drag
        );
        assert_eq!(
            profile.identifier,
            format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        );
        assert_eq!(profile.auto_clear, "never");
    } else {
        assert!(result
            .unwrap_err()
            .contains("requires --features legacy-node-smoke,ztools-multiwebview"));
    }
    let mut wrong_clear = values.clone();
    let index = wrong_clear
        .iter()
        .position(|value| value == "--auto-clear")
        .unwrap();
    wrong_clear[index + 1] = "immediately".into();
    assert!(Profile::from_args(&wrong_clear)
        .unwrap_err()
        .contains("requires --auto-clear never"));
    values.extend(["--window-drag".into(), "false".into()]);
    assert!(Profile::from_args(&values)
        .unwrap_err()
        .contains("window-drag requires --journey catalog"));
}

#[test]
fn window_drag_flag_is_strict_and_catalog_only() {
    let temporary = tempfile::tempdir().unwrap();
    let root = unique_root();
    let output = temporary.path().join("report.json");
    let mut catalog = args(&root, temporary.path(), &output);
    catalog.extend(["--journey".into(), "catalog".into()]);

    let mut disabled = catalog.clone();
    disabled.extend(["--window-drag".into(), "false".into()]);
    if cfg!(feature = "ztools-multiwebview") {
        assert!(!Profile::from_args(&disabled).unwrap().window_drag);
    } else {
        assert!(Profile::from_args(&disabled)
            .unwrap_err()
            .contains("requires --features ztools-multiwebview"));
    }

    let mut enabled = catalog.clone();
    enabled.extend(["--window-drag".into(), "true".into()]);
    if cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        assert!(Profile::from_args(&enabled).unwrap().window_drag);
    } else {
        let required = if cfg!(feature = "legacy-node-smoke") {
            "requires --features ztools-multiwebview"
        } else {
            "requires --features legacy-node-smoke"
        };
        assert!(Profile::from_args(&enabled).unwrap_err().contains(required));
    }

    for invalid in ["yes", "1", "TRUE", ""] {
        let mut invalid_args = catalog.clone();
        invalid_args.extend(["--window-drag".into(), invalid.into()]);
        assert!(Profile::from_args(&invalid_args)
            .unwrap_err()
            .contains("window-drag must be true or false"));
    }

    let mut without_catalog = args(&root, temporary.path(), &output);
    without_catalog.extend(["--window-drag".into(), "false".into()]);
    assert!(Profile::from_args(&without_catalog)
        .unwrap_err()
        .contains("requires --journey catalog"));

    let mut duplicate = catalog;
    duplicate.extend([
        "--window-drag".into(),
        "false".into(),
        "--window-drag".into(),
        "true".into(),
    ]);
    assert!(Profile::from_args(&duplicate)
        .unwrap_err()
        .contains("duplicate"));
}

#[test]
fn derives_bundle_identity_from_optional_run_id_as_simple_uuid() {
    let temporary = tempfile::tempdir().unwrap();
    let root = unique_root();
    let output = temporary.path().join("report.json");
    let mut with_run_id = args(&root, temporary.path(), &output);
    with_run_id.extend([
        "--run-id".to_string(),
        "8f14e45f-ea3e-4d3a-9b7d-1c4e5f607182".to_string(),
    ]);

    let profile = Profile::from_args(&with_run_id).unwrap();
    assert_eq!(
        profile.identifier,
        "dev.atools.renderer-smoke.8f14e45fea3e4d3a9b7d1c4e5f607182"
    );
}

#[test]
fn rejects_unknown_duplicate_missing_and_invalid_auto_clear_flags() {
    let temporary = tempfile::tempdir().unwrap();
    let root = unique_root();
    let output = temporary.path().join("report.json");
    let valid = args(&root, temporary.path(), &output);

    let mut unknown = valid.clone();
    unknown.push("--extra".to_string());
    assert!(Profile::from_args(&unknown)
        .unwrap_err()
        .contains("unknown"));

    let mut duplicate = valid.clone();
    duplicate.extend([
        "--output".to_string(),
        output.to_string_lossy().into_owned(),
    ]);
    assert!(Profile::from_args(&duplicate)
        .unwrap_err()
        .contains("duplicate"));

    let mut duplicate_run_id = valid.clone();
    duplicate_run_id.extend([
        "--run-id".to_string(),
        "8f14e45f-ea3e-4d3a-9b7d-1c4e5f607182".to_string(),
        "--run-id".to_string(),
        "8f14e45f-ea3e-4d3a-9b7d-1c4e5f607182".to_string(),
    ]);
    assert!(Profile::from_args(&duplicate_run_id)
        .unwrap_err()
        .contains("duplicate"));

    let mut invalid_run_id = valid.clone();
    invalid_run_id.extend(["--run-id".to_string(), "not-a-uuid".to_string()]);
    assert!(Profile::from_args(&invalid_run_id)
        .unwrap_err()
        .contains("valid UUID"));

    assert!(Profile::from_args(&valid[..valid.len() - 2])
        .unwrap_err()
        .contains("missing"));

    let mut invalid_journey = valid.clone();
    invalid_journey.extend(["--journey".to_string(), "desktop".to_string()]);
    assert!(Profile::from_args(&invalid_journey)
        .unwrap_err()
        .contains("journey must be manual-ui, launcher, launch-return, settings, settings-input, builtin-state-seed, builtin-state, main-hotkey-recovery-first, main-hotkey-recovery-second, catalog, updater, main-panel, or clipboard-context"));

    let mut duplicate_journey = valid.clone();
    duplicate_journey.extend([
        "--journey".to_string(),
        "launcher".to_string(),
        "--journey".to_string(),
        "settings".to_string(),
    ]);
    assert!(Profile::from_args(&duplicate_journey)
        .unwrap_err()
        .contains("duplicate"));

    let mut launcher_journey = valid.clone();
    launcher_journey.extend(["--journey".to_string(), "launcher".to_string()]);
    if cfg!(feature = "legacy-node-smoke") {
        let launcher_profile = Profile::from_args(&launcher_journey).unwrap();
        assert!(!launcher_profile.settings_journey);
        assert!(launcher_profile.launcher_journey);
        assert!(!launcher_profile.catalog_journey);
    } else {
        assert!(Profile::from_args(&launcher_journey)
            .unwrap_err()
            .contains("requires --features legacy-node-smoke"));
    }

    let mut launch_return = valid.clone();
    launch_return.extend(["--journey".to_string(), "launch-return".to_string()]);
    if cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        let profile = Profile::from_args(&launch_return).unwrap();
        assert!(profile.launch_return_journey);
        assert!(!profile.launcher_journey);
        assert!(!profile.catalog_journey);
    } else {
        assert!(Profile::from_args(&launch_return)
            .unwrap_err()
            .contains("launch-return journey requires --features legacy-node-smoke"));
    }

    let mut launch_return_with_clear = launch_return;
    let clear_index = launch_return_with_clear
        .iter()
        .position(|argument| argument == "--auto-clear")
        .unwrap();
    launch_return_with_clear[clear_index + 1] = "immediately".to_string();
    assert!(Profile::from_args(&launch_return_with_clear)
        .unwrap_err()
        .contains("launch-return requires --auto-clear never"));

    let mut settings_journey = valid.clone();
    settings_journey.extend(["--journey".to_string(), "settings".to_string()]);
    if cfg!(feature = "ztools-multiwebview") {
        assert!(
            Profile::from_args(&settings_journey)
                .unwrap()
                .settings_journey
        );
        assert!(
            !Profile::from_args(&settings_journey)
                .unwrap()
                .launcher_journey
        );
        assert!(
            !Profile::from_args(&settings_journey)
                .unwrap()
                .catalog_journey
        );
    } else {
        assert!(Profile::from_args(&settings_journey)
            .unwrap_err()
            .contains("requires --features ztools-multiwebview"));
    }

    let mut catalog_journey = valid.clone();
    catalog_journey.extend(["--journey".to_string(), "catalog".to_string()]);
    if cfg!(feature = "ztools-multiwebview") {
        let catalog_profile = Profile::from_args(&catalog_journey).unwrap();
        assert!(catalog_profile.catalog_journey);
        assert!(!catalog_profile.settings_journey);
        assert!(!catalog_profile.launcher_journey);
    } else {
        assert!(Profile::from_args(&catalog_journey)
            .unwrap_err()
            .contains("catalog journey requires --features ztools-multiwebview"));
    }

    let mut invalid_clear = valid;
    *invalid_clear.last_mut().unwrap() = "sometimes".to_string();
    assert!(Profile::from_args(&invalid_clear)
        .unwrap_err()
        .contains("auto-clear"));
}

#[test]
fn rejects_relative_traversal_and_non_temp_fixture_roots() {
    let temporary = tempfile::tempdir().unwrap();
    let output = temporary.path().join("report.json");
    let dist = temporary.path().join("dist");

    for invalid_root in [
        PathBuf::from("relative/root"),
        env::temp_dir().join("parent/../escape"),
        temporary.path().join("nested/root"),
    ] {
        assert!(Profile::from_args(&args(&invalid_root, &dist, &output)).is_err());
    }

    if let Some(home) = env::var_os("HOME") {
        let home_root = PathBuf::from(home).join(".atools/renderer-smoke");
        assert!(Profile::from_args(&args(&home_root, &dist, &output)).is_err());
    }
}

#[test]
fn prepare_creates_only_private_isolated_directories_and_preserves_existing_root() {
    let temporary = tempfile::tempdir().unwrap();
    let output = temporary.path().join("report.json");
    let dist = temporary.path().join("dist");
    let root = unique_root();
    let profile = Profile::from_args(&args(&root, &dist, &output)).unwrap();
    profile.prepare().unwrap();

    assert!(root.join("app-data").is_dir());
    assert!(root.join("webview").is_dir());
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(".atools-renderer-smoke-owner.json")).unwrap())
            .unwrap();
    assert_eq!(marker["schemaVersion"], 1);
    assert_eq!(marker["pid"], std::process::id());
    assert_eq!(marker["identifier"], profile.identifier);
    assert_eq!(marker["root"], root.to_string_lossy().as_ref());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join("app-data"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join("webview"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join(".atools-renderer-smoke-owner.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    assert!(profile.prepare().is_err());
    assert!(root.join("app-data").is_dir());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn prepare_rejects_existing_root_symlinks_without_touching_the_target() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), b"preserve").unwrap();
    let root = unique_root();
    symlink(&target, &root).unwrap();
    let output = temporary.path().join("report.json");
    let profile = Profile::from_args(&args(&root, temporary.path(), &output)).unwrap();

    assert!(profile.prepare().is_err());
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"preserve");
    assert!(fs::symlink_metadata(&root)
        .unwrap()
        .file_type()
        .is_symlink());
    fs::remove_file(root).unwrap();
}

#[test]
fn report_is_private_create_new_and_limited_to_one_mib() {
    let temporary = tempfile::tempdir().unwrap();
    let root = unique_root();
    let output = temporary.path().join("report.json");
    let profile = Profile::from_args(&args(&root, temporary.path(), &output)).unwrap();
    let value = serde_json::json!({"ok": true, "count": 3});
    profile.write_report(&value).unwrap();
    let original = fs::read(&output).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&original).unwrap(),
        value
    );
    assert!(profile
        .write_report(&serde_json::json!({"ok": false}))
        .is_err());
    assert_eq!(fs::read(&output).unwrap(), original);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let oversized = serde_json::Value::String("x".repeat(1024 * 1024));
    let oversized_output = temporary.path().join("oversized.json");
    let oversized_profile = Profile {
        output: oversized_output.clone(),
        ..profile
    };
    assert!(oversized_profile.write_report(&oversized).is_err());
    assert!(!oversized_output.exists());
}

#[cfg(unix)]
#[test]
fn report_creation_does_not_follow_a_symlink_appearing_after_argument_parse() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let root = unique_root();
    let output = temporary.path().join("report.json");
    let target = temporary.path().join("target.json");
    fs::write(&target, b"preserve").unwrap();
    let profile = Profile::from_args(&args(&root, temporary.path(), &output)).unwrap();
    symlink(&target, &output).unwrap();

    assert!(profile
        .write_report(&serde_json::json!({"unsafe": true}))
        .is_err());
    assert_eq!(fs::read(&target).unwrap(), b"preserve");
}
