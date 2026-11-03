use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::{json, Value};

use super::{
    resume_seed_profile, verify, NOT_VERIFIED, OWNER_MARKER_LIMIT, OWNER_MARKER_NAME,
    RESUME_CLAIM_NAME, RESUME_PERMIT_NAME,
};
use crate::renderer_desktop_smoke::profile::{PaintPresentation, Profile};

struct OwnedProfile {
    _directory: tempfile::TempDir,
    profile: Profile,
}

impl OwnedProfile {
    fn new() -> Self {
        let temp = fs::canonicalize(env::temp_dir()).unwrap();
        let directory = tempfile::Builder::new()
            .prefix("atools-renderer-owner-test-")
            .tempdir_in(temp)
            .unwrap();
        let root = directory.path().to_path_buf();
        #[cfg(unix)]
        set_private_directory(&root);
        let profile = profile_at(&root);
        let result = Self {
            _directory: directory,
            profile,
        };
        write_marker(&result.profile, marker(&result.profile));
        result
    }

    fn marker_path(&self) -> PathBuf {
        self.profile.root.join(OWNER_MARKER_NAME)
    }
}

fn profile_at(root: &Path) -> Profile {
    let name = root.file_name().unwrap().to_string_lossy();
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    Profile {
        root: root.to_path_buf(),
        dist: root.with_file_name(format!("{name}-dist")),
        output: root.with_file_name(format!("{name}-report.json")),
        auto_clear: "never".to_string(),
        identifier: format!("dev.atools.renderer-smoke.{run_id}"),
        run_id,
        settings_journey: false,
        settings_height_case: None,
        manual_ui: false,
        settings_input_journey: false,
        builtin_state_seed: false,
        builtin_state_journey: false,
        resume_seed_pid: None,
        main_hotkey_recovery_first: false,
        main_hotkey_recovery_second: false,
        resume_hotkey_owner_pid: None,
        paint_presentation: PaintPresentation::Hidden,
        launcher_journey: false,
        launch_return_journey: false,
        launch_target_kind: crate::renderer_desktop_smoke::profile::LaunchTargetKind::App,
        registration_source: crate::renderer_desktop_smoke::profile::RegistrationSource::CoreSeed,
        catalog_journey: false,
        updater_journey: false,
        updater_about: false,
        window_drag: false,
        main_panel_journey: false,
        clipboard_context_journey: false,
    }
}

#[cfg(unix)]
fn set_private_directory(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn marker(profile: &Profile) -> Value {
    json!({
        "schemaVersion": 1,
        "pid": std::process::id(),
        "identifier": profile.identifier.clone(),
        "root": profile.root.to_string_lossy(),
    })
}

fn write_marker(profile: &Profile, value: Value) {
    fs::write(
        profile.root.join(OWNER_MARKER_NAME),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            profile.root.join(OWNER_MARKER_NAME),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
}

#[test]
fn verifies_private_canonical_direct_temp_root_and_exact_owner_marker() {
    let owned = OwnedProfile::new();
    assert!(verify(&owned.profile).is_ok());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&owned.profile.root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(owned.marker_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn verifies_canonical_private_tmp_direct_child() {
    let directory = tempfile::Builder::new()
        .prefix("atools-renderer-owner-test-")
        .tempdir_in("/private/tmp")
        .unwrap();
    set_private_directory(directory.path());
    let profile = profile_at(directory.path());
    write_marker(&profile, marker(&profile));
    assert!(verify(&profile).is_ok());
}

#[test]
fn rejects_missing_malformed_oversized_and_extra_marker_fields() {
    let owned = OwnedProfile::new();
    fs::remove_file(owned.marker_path()).unwrap();
    assert_eq!(verify(&owned.profile), Err(NOT_VERIFIED));

    write_marker(&owned.profile, json!({"schemaVersion": 1}));
    assert_eq!(verify(&owned.profile), Err(NOT_VERIFIED));

    let mut extra = marker(&owned.profile);
    extra["unexpected"] = json!(true);
    write_marker(&owned.profile, extra);
    assert_eq!(verify(&owned.profile), Err(NOT_VERIFIED));

    let duplicate_schema = format!(
        r#"{{"schemaVersion":1,"schemaVersion":1,"pid":{},"identifier":{},"root":{}}}"#,
        std::process::id(),
        serde_json::to_string(&owned.profile.identifier).unwrap(),
        serde_json::to_string(&owned.profile.root.to_string_lossy()).unwrap(),
    );
    fs::write(owned.marker_path(), duplicate_schema).unwrap();
    assert_eq!(verify(&owned.profile), Err(NOT_VERIFIED));

    fs::write(owned.marker_path(), vec![b'x'; OWNER_MARKER_LIMIT + 1]).unwrap();
    assert_eq!(verify(&owned.profile), Err(NOT_VERIFIED));
}

#[test]
fn rejects_wrong_schema_pid_identifier_and_root() {
    let owned = OwnedProfile::new();
    for (field, value) in [
        ("schemaVersion", json!(2)),
        ("pid", json!(u64::from(std::process::id()) + 1)),
        ("identifier", json!("dev.atools.other-profile")),
        ("root", json!("/private/tmp/another-profile")),
    ] {
        let mut invalid = marker(&owned.profile);
        invalid[field] = value;
        write_marker(&owned.profile, invalid);
        assert_eq!(verify(&owned.profile), Err(NOT_VERIFIED), "{field}");
    }
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_owner_marker_and_symlinked_root() {
    use std::os::unix::fs::symlink;

    let owned = OwnedProfile::new();
    let target = owned.profile.root.join("owner-target.json");
    fs::rename(owned.marker_path(), &target).unwrap();
    symlink(&target, owned.marker_path()).unwrap();
    assert_eq!(verify(&owned.profile), Err(NOT_VERIFIED));
    fs::remove_file(owned.marker_path()).unwrap();
    fs::rename(&target, owned.marker_path()).unwrap();

    let alias = owned.profile.root.with_file_name(format!(
        "{}-alias",
        owned.profile.root.file_name().unwrap().to_string_lossy()
    ));
    symlink(&owned.profile.root, &alias).unwrap();
    let alias_profile = profile_at(&alias);
    assert_eq!(verify(&alias_profile), Err(NOT_VERIFIED));
    fs::remove_file(alias).unwrap();
}

#[test]
fn rejects_existing_non_directory_root() {
    let owned = OwnedProfile::new();
    let file_root = owned.profile.root.with_file_name(format!(
        "{}-file",
        owned.profile.root.file_name().unwrap().to_string_lossy()
    ));
    fs::write(&file_root, b"not a directory").unwrap();
    let file_profile = profile_at(&file_root);
    assert_eq!(verify(&file_profile), Err(NOT_VERIFIED));
    fs::remove_file(file_root).unwrap();
}

#[test]
fn rejects_real_directory_that_is_not_a_direct_allowed_temp_child() {
    let owned = OwnedProfile::new();
    let nested = owned.profile.root.join("nested-profile");
    fs::create_dir(&nested).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let nested_profile = Profile {
        settings_height_case: owned.profile.settings_height_case,
        root: nested.clone(),
        dist: owned.profile.dist.clone(),
        output: owned.profile.output.clone(),
        auto_clear: owned.profile.auto_clear.clone(),
        identifier: owned.profile.identifier.clone(),
        run_id: owned.profile.run_id.clone(),
        settings_journey: owned.profile.settings_journey,
        manual_ui: false,
        settings_input_journey: owned.profile.settings_input_journey,
        builtin_state_seed: owned.profile.builtin_state_seed,
        builtin_state_journey: owned.profile.builtin_state_journey,
        resume_seed_pid: owned.profile.resume_seed_pid,
        main_hotkey_recovery_first: owned.profile.main_hotkey_recovery_first,
        main_hotkey_recovery_second: owned.profile.main_hotkey_recovery_second,
        resume_hotkey_owner_pid: owned.profile.resume_hotkey_owner_pid,
        paint_presentation: owned.profile.paint_presentation,
        launcher_journey: owned.profile.launcher_journey,
        launch_return_journey: owned.profile.launch_return_journey,
        launch_target_kind: owned.profile.launch_target_kind,
        registration_source: owned.profile.registration_source,
        catalog_journey: owned.profile.catalog_journey,
        updater_journey: false,
        updater_about: false,
        window_drag: owned.profile.window_drag,
        main_panel_journey: owned.profile.main_panel_journey,
        clipboard_context_journey: owned.profile.clipboard_context_journey,
    };
    write_marker(&nested_profile, marker(&nested_profile));
    assert_eq!(verify(&nested_profile), Err(NOT_VERIFIED));
}

#[cfg(target_os = "macos")]
struct BuiltinOwnedProfile {
    profile: Profile,
}

#[cfg(target_os = "macos")]
impl BuiltinOwnedProfile {
    fn new() -> Self {
        let run_id = uuid::Uuid::new_v4().simple().to_string();
        let root =
            PathBuf::from("/private/tmp").join(format!("atools-renderer-settings-input-{run_id}"));
        fs::create_dir(&root).unwrap();
        set_private_directory(&root);
        let profile = Profile {
            root: root.clone(),
            dist: root.with_file_name("builtin-state-dist"),
            output: root.with_file_name("native-builtin-state-report.json"),
            auto_clear: "never".to_owned(),
            identifier: format!("dev.atools.renderer-settings-input.{run_id}"),
            run_id,
            settings_journey: false,
            settings_height_case: None,
            manual_ui: false,
            settings_input_journey: true,
            builtin_state_seed: false,
            builtin_state_journey: true,
            resume_seed_pid: None,
            main_hotkey_recovery_first: false,
            main_hotkey_recovery_second: false,
            resume_hotkey_owner_pid: None,
            paint_presentation: PaintPresentation::Hidden,
            launcher_journey: false,
            launch_return_journey: false,
            launch_target_kind: crate::renderer_desktop_smoke::profile::LaunchTargetKind::App,
            registration_source:
                crate::renderer_desktop_smoke::profile::RegistrationSource::CoreSeed,
            catalog_journey: false,
            updater_journey: false,
            updater_about: false,
            window_drag: false,
            main_panel_journey: false,
            clipboard_context_journey: false,
        };
        let result = Self { profile };
        write_marker(&result.profile, marker(&result.profile));
        result
    }

    fn marker_path(&self) -> PathBuf {
        self.profile.root.join(OWNER_MARKER_NAME)
    }
}

#[cfg(target_os = "macos")]
impl Drop for BuiltinOwnedProfile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.profile.root);
    }
}

#[cfg(target_os = "macos")]
fn resume_artifacts(owned: &mut BuiltinOwnedProfile, seed_pid: u32) {
    owned.profile.resume_seed_pid = Some(seed_pid);
    fs::create_dir(owned.profile.root.join("app-data")).unwrap();
    fs::create_dir(owned.profile.root.join("webview")).unwrap();
    set_private_directory(&owned.profile.root.join("app-data"));
    set_private_directory(&owned.profile.root.join("webview"));
    let mut old_owner = marker(&owned.profile);
    old_owner["pid"] = json!(seed_pid);
    write_marker(&owned.profile, old_owner);
    let permit = json!({
        "schemaVersion": 1,
        "journey": "builtin-state-resume",
        "runId": owned.profile.run_id,
        "seedPid": seed_pid,
        "identifier": owned.profile.identifier,
        "root": owned.profile.root.to_string_lossy(),
    });
    let permit_path = owned.profile.root.join(RESUME_PERMIT_NAME);
    fs::write(&permit_path, serde_json::to_vec(&permit).unwrap()).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&permit_path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[cfg(target_os = "macos")]
fn exited_seed_pid() -> u32 {
    let mut seed = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = seed.id();
    seed.wait().unwrap();
    pid
}

#[cfg(target_os = "macos")]
#[test]
fn resumes_after_seed_exit_and_rejects_a_second_claim() {
    let mut owned = BuiltinOwnedProfile::new();
    let seed_pid = exited_seed_pid();
    resume_artifacts(&mut owned, seed_pid);

    assert!(resume_seed_profile(&owned.profile, seed_pid).is_ok());
    assert!(verify(&owned.profile).is_ok());
    assert!(owned.profile.root.join(RESUME_CLAIM_NAME).is_file());
    assert!(!owned.profile.root.join(RESUME_PERMIT_NAME).exists());
    let owner: Value = serde_json::from_slice(&fs::read(owned.marker_path()).unwrap()).unwrap();
    assert_eq!(owner["pid"], json!(std::process::id()));
    assert_eq!(
        resume_seed_profile(&owned.profile, seed_pid),
        Err(NOT_VERIFIED)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn refuses_resume_while_another_seed_process_is_live() {
    let mut owned = BuiltinOwnedProfile::new();
    let mut seed = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let seed_pid = seed.id();
    resume_artifacts(&mut owned, seed_pid);

    assert_eq!(
        resume_seed_profile(&owned.profile, seed_pid),
        Err(NOT_VERIFIED)
    );
    assert!(!owned.profile.root.join(RESUME_CLAIM_NAME).exists());
    let _ = seed.kill();
    seed.wait().unwrap();
}
