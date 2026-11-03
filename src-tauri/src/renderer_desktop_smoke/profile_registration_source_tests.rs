use super::{LaunchTargetKind, Profile, RegistrationSource};

#[test]
fn source_defaults_to_core_seed_and_requires_an_explicit_valid_combination() {
    assert_eq!(
        RegistrationSource::parse(None, false, LaunchTargetKind::App).unwrap(),
        RegistrationSource::CoreSeed
    );
    assert_eq!(
        RegistrationSource::parse(Some("core-seed"), true, LaunchTargetKind::App).unwrap(),
        RegistrationSource::CoreSeed
    );
    assert_eq!(
        RegistrationSource::parse(
            Some("settings-child"),
            true,
            LaunchTargetKind::LocalShortcut
        )
        .unwrap(),
        RegistrationSource::SettingsChild
    );
    assert!(
        RegistrationSource::parse(Some("settings-child"), true, LaunchTargetKind::App).is_err()
    );
    assert!(RegistrationSource::parse(
        Some("settings-child"),
        false,
        LaunchTargetKind::LocalShortcut
    )
    .is_err());
    assert!(RegistrationSource::parse(Some("core-seed"), false, LaunchTargetKind::App).is_err());
    assert!(
        RegistrationSource::parse(Some("other"), true, LaunchTargetKind::LocalShortcut).is_err()
    );
}

#[test]
fn profile_rejects_duplicate_unknown_and_wrong_target_before_initializing_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let args = || {
        vec![
            "--fixture-root".into(),
            "/private/tmp/atools-renderer-smoke-test".into(),
            "--renderer-dist".into(),
            temp.path().to_string_lossy().into_owned(),
            "--output".into(),
            temp.path()
                .join("report.json")
                .to_string_lossy()
                .into_owned(),
            "--auto-clear".into(),
            "never".into(),
            "--journey".into(),
            "launch-return".into(),
        ]
    };
    let mut duplicate = args();
    duplicate.extend([
        "--registration-source".into(),
        "core-seed".into(),
        "--registration-source".into(),
        "settings-child".into(),
    ]);
    assert!(Profile::from_args(&duplicate)
        .unwrap_err()
        .contains("duplicate renderer smoke flag"));
    let mut unknown = args();
    unknown.extend(["--registration-source".into(), "other".into()]);
    assert!(Profile::from_args(&unknown)
        .unwrap_err()
        .contains("registration-source must"));
    let mut wrong_target = args();
    wrong_target.extend(["--registration-source".into(), "settings-child".into()]);
    assert!(Profile::from_args(&wrong_target)
        .unwrap_err()
        .contains("requires local-shortcut"));
}

#[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview", unix))]
#[test]
fn owned_fixture_requires_the_existing_launch_return_root_and_current_owner() {
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    let temporary = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let root = PathBuf::from(format!("/private/tmp/atools-renderer-launch-return-{id}"));
    let args = vec![
        "--fixture-root".into(),
        root.to_string_lossy().into_owned(),
        "--renderer-dist".into(),
        temporary.path().to_string_lossy().into_owned(),
        "--output".into(),
        temporary
            .path()
            .join("report.json")
            .to_string_lossy()
            .into_owned(),
        "--auto-clear".into(),
        "never".into(),
        "--journey".into(),
        "launch-return".into(),
        "--target-kind".into(),
        "local-shortcut".into(),
        "--registration-source".into(),
        "settings-child".into(),
        "--run-id".into(),
        id.clone(),
    ];
    let mut profile = Profile::from_args(&args).unwrap();
    profile.prepare().unwrap();
    let _cleanup = Cleanup(root.clone());
    assert!(profile.validate_settings_child_fixture().is_ok());
    assert_eq!(
        profile.expected_identifier(),
        format!("dev.atools.renderer-smoke.{id}")
    );

    profile.root = PathBuf::from(format!("/private/tmp/atools-renderer-smoke-{id}"));
    assert!(profile.validate_settings_child_fixture().is_err());
    profile.root = PathBuf::from(format!("{}/.", root.display()));
    assert!(profile.validate_settings_child_fixture().is_err());
    profile.root = root.clone();
    profile.registration_source = RegistrationSource::CoreSeed;
    assert!(profile.validate_settings_child_fixture().is_err());
    profile.registration_source = RegistrationSource::SettingsChild;
    profile.launch_target_kind = LaunchTargetKind::App;
    assert!(profile.validate_settings_child_fixture().is_err());
    profile.launch_target_kind = LaunchTargetKind::LocalShortcut;

    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(profile.validate_settings_child_fixture().is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let marker = root.join(".atools-renderer-smoke-owner.json");
    let original = fs::read(&marker).unwrap();
    fs::write(&marker, b"{}").unwrap();
    assert!(profile.validate_settings_child_fixture().is_err());
    fs::write(&marker, original).unwrap();
    assert!(profile.validate_settings_child_fixture().is_ok());
}
