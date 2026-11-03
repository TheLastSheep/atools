use super::local_app_search_schema as schema;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const REPORT_NAME: &str = "native-local-app-search-report.json";
const OBSERVATIONS_NAME: &str = "native-local-app-search-observations.json";
const PLUGIN_INVENTORY_NAME: &str = "native-plugin-inventory-observations.json";

#[cfg(test)]
#[path = "local_app_search_report_hotkey_tests.rs"]
mod hotkey_recovery_writer_tests;

pub(super) fn write(
    profile: &super::super::profile::Profile,
    report: &Value,
) -> Result<(), &'static str> {
    if !schema::valid_report(report) {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    write_owned_artifact(profile, REPORT_NAME, report)
}

pub(super) fn write_owned_artifact(
    profile: &super::super::profile::Profile,
    name: &str,
    report: &Value,
) -> Result<(), &'static str> {
    if name != REPORT_NAME
        && name != OBSERVATIONS_NAME
        && name != PLUGIN_INVENTORY_NAME
        && name != super::command_aliases_schema::REPORT_NAME
        && name != super::command_aliases_open_add_diagnostic::REPORT_NAME
        && name != super::window_opacity_schema::REPORT_NAME
        && name != super::tray_visibility_schema::REPORT_NAME
        && name != super::main_hotkey_schema::REPORT_NAME
        && name != super::general_policies_schema::REPORT_NAME
        && name != super::auto_back_journey::REPORT_NAME
        && name != super::launch_at_login_schema::REPORT_NAME
        && name != super::main_hotkey_startup_schema::FIRST_REPORT
        && name != super::main_hotkey_startup_schema::SECOND_REPORT
        && name != super::login_cross_entry_schema::REPORT_NAME
    {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    let path = report_path(profile, name)?;
    let bytes = serde_json::to_vec(report).map_err(|_| schema::REPORT_WRITE_FAILED)?;
    write_private_file(&path, &bytes)
}

fn report_path(
    profile: &super::super::profile::Profile,
    name: &str,
) -> Result<PathBuf, &'static str> {
    if profile.output.file_name().and_then(|name| name.to_str()) != Some("native-report.json")
        || profile.run_id.len() != 32
        || !profile
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || profile.identifier != format!("dev.atools.renderer-settings-input.{}", profile.run_id)
    {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    let parent = profile.output.parent().ok_or(schema::REPORT_WRITE_FAILED)?;
    let expected_name = format!("run-{}", profile.run_id);
    if !parent.is_absolute() {
        return Err(schema::REPORT_WRITE_FAILED);
    }

    let recovery_phase = match name {
        super::main_hotkey_startup_schema::FIRST_REPORT if profile.main_hotkey_recovery_first => {
            Some("first")
        }
        super::main_hotkey_startup_schema::SECOND_REPORT if profile.main_hotkey_recovery_second => {
            Some("second")
        }
        super::main_hotkey_startup_schema::FIRST_REPORT
        | super::main_hotkey_startup_schema::SECOND_REPORT => {
            return Err(schema::REPORT_WRITE_FAILED);
        }
        _ => None,
    };

    if parent.file_name().and_then(|name| name.to_str()) == Some(expected_name.as_str()) {
        validate_private_directory(parent)?;
        return Ok(parent.to_path_buf().join(name));
    }

    let Some(phase) = recovery_phase else {
        return Err(schema::REPORT_WRITE_FAILED);
    };
    if parent.file_name().and_then(|name| name.to_str()) != Some(phase) {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    let run_directory = parent.parent().ok_or(schema::REPORT_WRITE_FAILED)?;
    if run_directory.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    validate_private_directory(parent)?;
    validate_private_directory(run_directory)?;
    Ok(parent.to_path_buf().join(name))
}

fn validate_private_directory(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| schema::REPORT_WRITE_FAILED)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return Err(schema::REPORT_WRITE_FAILED);
        }
    }
    if fs::canonicalize(path).map_err(|_| schema::REPORT_WRITE_FAILED)? != path {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| schema::REPORT_WRITE_FAILED)?;
    if !file
        .metadata()
        .map_err(|_| schema::REPORT_WRITE_FAILED)?
        .is_file()
    {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| schema::REPORT_WRITE_FAILED)?;
    }
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| schema::REPORT_WRITE_FAILED)
}

#[cfg(test)]
mod tests {
    use super::{write_owned_artifact, REPORT_NAME};
    use serde_json::{json, Value};
    use std::{fs, path::PathBuf};
    use tempfile::TempDir;

    const TRAY_REPORT_NAME: &str = "native-tray-visibility-report.json";
    const MAIN_HOTKEY_REPORT_NAME: &str = "native-main-hotkey-report.json";
    const GENERAL_POLICIES_REPORT_NAME: &str = "native-general-policies-report.json";
    const LAUNCH_AT_LOGIN_REPORT_NAME: &str = "native-launch-at-login-report.json";
    const LOGIN_CROSS_ENTRY_REPORT_NAME: &str = "native-login-cross-entry-report.json";
    const RUN_ID: &str = "0123456789abcdef0123456789abcdef";

    fn private_run() -> (TempDir, super::super::super::profile::Profile, PathBuf) {
        private_run_for("settings-input")
    }

    fn private_run_for(journey: &str) -> (TempDir, super::super::super::profile::Profile, PathBuf) {
        let temporary = tempfile::tempdir().expect("private test parent");
        let base = fs::canonicalize(temporary.path()).expect("canonical temp parent");
        let run_directory = base.join(format!("run-{RUN_ID}"));
        fs::create_dir(&run_directory).expect("create isolated run directory");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&run_directory, fs::Permissions::from_mode(0o700))
                .expect("set private run directory mode");
        }
        let output = run_directory.join("native-report.json");
        let fixture_root = format!("/private/tmp/atools-renderer-settings-input-{RUN_ID}");
        let profile = super::super::super::profile::Profile::from_args(&[
            "--fixture-root".into(),
            fixture_root,
            "--renderer-dist".into(),
            "/tmp/dist".into(),
            "--output".into(),
            output.to_string_lossy().into_owned(),
            "--auto-clear".into(),
            "never".into(),
            "--run-id".into(),
            RUN_ID.into(),
            "--journey".into(),
            journey.into(),
        ])
        .expect("valid private settings-input profile");
        (temporary, profile, run_directory)
    }

    fn tray_report(profile: &super::super::super::profile::Profile) -> Value {
        let mut observations = super::super::tray_visibility_schema::empty_observations();
        for key in [
            "startupDefaultVisible",
            "initialUiEnabled",
            "disableDispatched",
            "disabledStored",
            "disabledNative",
            "freshChildOnReopen",
            "reopenUiDisabled",
            "reopenStoredDisabled",
            "reopenNativeDisabled",
            "enableDispatched",
            "enabledStored",
            "enabledNative",
            "unrelatedPreserved",
            "childClosed",
            "trayReleased",
        ] {
            observations[key] = json!(true);
        }
        observations["pluginUiOpened"] = json!(false);
        observations["preloadStarted"] = json!(false);
        assert!(super::super::tray_visibility_schema::observations_passed(
            &observations
        ));
        super::super::tray_visibility_schema::build(profile, observations, &[])
    }

    fn main_hotkey_report(profile: &super::super::super::profile::Profile) -> Value {
        let mut observations = super::super::main_hotkey_schema::empty_observations();
        for key in [
            "initialOwnedRegistered",
            "initialUiMatches",
            "recordDispatched",
            "changedStored",
            "changedOwnedRegistered",
            "previousUnregistered",
            "changedUiMatches",
            "freshChildOnReopen",
            "reopenUiMatches",
            "reopenStored",
            "reopenOwnedRegistered",
            "conflictDispatched",
            "conflictUiRestored",
            "conflictStoredUnchanged",
            "conflictPrimaryPreserved",
            "conflictOtherPreserved",
            "restoreDispatched",
            "restoredStored",
            "restoredOwnedRegistered",
            "alternateUnregistered",
            "unrelatedPreserved",
            "childClosed",
            "ownedPrimaryReleased",
            "otherShortcutReleased",
            "mainRawHotkeyMutationDenied",
            "childRawHotkeyMutationDenied",
        ] {
            observations[key] = json!(true);
        }
        observations["pluginUiOpened"] = json!(false);
        observations["preloadStarted"] = json!(false);
        assert!(super::super::main_hotkey_schema::observations_passed(
            &observations
        ));
        super::super::main_hotkey_schema::build(profile, observations, &[])
    }

    fn general_policies_report(profile: &super::super::super::profile::Profile) -> Value {
        super::super::general_policies_schema::build(
            profile,
            super::super::general_policies_schema::empty_observations(),
            &[super::super::general_policies_schema::BASELINE_INVALID],
        )
    }

    #[test]
    fn tray_sidecar_is_written_as_a_private_owner_bound_json_file() {
        let (_temporary, profile, run_directory) = private_run();
        let report = tray_report(&profile);
        assert!(super::super::tray_visibility_schema::valid_report(
            &profile, &report
        ));
        assert_eq!(
            write_owned_artifact(&profile, TRAY_REPORT_NAME, &report),
            Ok(()),
            "the actual tray visibility sidecar must be accepted by the owned writer"
        );

        let path = run_directory.join(TRAY_REPORT_NAME);
        let written: Value = serde_json::from_slice(&fs::read(&path).expect("read sidecar"))
            .expect("valid JSON sidecar");
        assert_eq!(written, report);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(path)
                .expect("sidecar metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert_eq!(
            write_owned_artifact(&profile, TRAY_REPORT_NAME, &report),
            Err(super::schema::REPORT_WRITE_FAILED),
            "a second write must not replace the first sidecar"
        );
    }

    #[test]
    fn main_hotkey_sidecar_roundtrips_through_the_private_owned_writer() {
        let (_temporary, profile, run_directory) = private_run();
        let report = main_hotkey_report(&profile);
        assert!(super::super::main_hotkey_schema::valid_report(
            &profile, &report
        ));
        assert_eq!(
            write_owned_artifact(&profile, MAIN_HOTKEY_REPORT_NAME, &report),
            Ok(())
        );
        let path = run_directory.join(MAIN_HOTKEY_REPORT_NAME);
        let written: Value = serde_json::from_slice(&fs::read(&path).expect("read sidecar"))
            .expect("valid JSON sidecar");
        assert_eq!(written, report);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path)
                    .expect("sidecar metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(
            write_owned_artifact(&profile, MAIN_HOTKEY_REPORT_NAME, &report),
            Err(super::schema::REPORT_WRITE_FAILED)
        );
    }

    #[test]
    fn general_policies_sidecar_roundtrips_through_the_private_owned_writer() {
        let (_temporary, profile, run_directory) = private_run();
        let report = general_policies_report(&profile);
        assert!(super::super::general_policies_schema::valid_report(
            &profile, &report
        ));
        assert_eq!(
            write_owned_artifact(&profile, GENERAL_POLICIES_REPORT_NAME, &report),
            Ok(())
        );
        let path = run_directory.join(GENERAL_POLICIES_REPORT_NAME);
        let written: Value = serde_json::from_slice(&fs::read(&path).expect("read report"))
            .expect("valid JSON report");
        assert_eq!(written, report);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path)
                    .expect("report metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(
            write_owned_artifact(&profile, GENERAL_POLICIES_REPORT_NAME, &report),
            Err(super::schema::REPORT_WRITE_FAILED)
        );
    }

    #[test]
    fn startup_recovery_sidecar_uses_the_private_owned_writer() {
        let (_temporary, profile, run_directory) = private_run_for("main-hotkey-recovery-first");
        let report = super::super::main_hotkey_startup_schema::first_report(
            &profile,
            super::super::main_hotkey_startup_schema::empty_first(),
            &[],
        );
        assert!(super::super::main_hotkey_startup_schema::valid_first(
            &profile, &report
        ));
        let name = super::super::main_hotkey_startup_schema::FIRST_REPORT;
        assert_eq!(write_owned_artifact(&profile, name, &report), Ok(()));
        let written: Value = serde_json::from_slice(
            &fs::read(run_directory.join(name)).expect("read recovery report"),
        )
        .expect("valid recovery JSON");
        assert_eq!(written, report);
    }

    #[test]
    fn launch_at_login_sidecar_uses_the_private_owned_writer() {
        let (_temporary, profile, run_directory) = private_run();
        let report = super::super::launch_at_login_schema::build(
            &profile,
            1,
            false,
            &super::super::launch_at_login_schema::empty_observations(),
            &[super::super::launch_at_login_schema::OWNER_INVALID],
        );
        assert!(super::super::launch_at_login_schema::valid_report(
            &profile, &report
        ));
        assert_eq!(
            write_owned_artifact(&profile, LAUNCH_AT_LOGIN_REPORT_NAME, &report),
            Ok(())
        );
        let written: Value = serde_json::from_slice(
            &fs::read(run_directory.join(LAUNCH_AT_LOGIN_REPORT_NAME)).expect("read login report"),
        )
        .expect("valid login JSON");
        assert_eq!(written, report);
    }

    #[test]
    fn login_cross_entry_sidecar_uses_the_private_owned_writer() {
        let (_temporary, profile, run_directory) = private_run();
        let report = super::super::login_cross_entry_schema::empty_report(&profile);
        assert!(super::super::login_cross_entry_schema::valid_report(
            &profile, &report
        ));
        assert_eq!(
            write_owned_artifact(&profile, LOGIN_CROSS_ENTRY_REPORT_NAME, &report),
            Ok(())
        );
        let written: Value = serde_json::from_slice(
            &fs::read(run_directory.join(LOGIN_CROSS_ENTRY_REPORT_NAME))
                .expect("read cross-entry report"),
        )
        .expect("valid cross-entry JSON");
        assert_eq!(written, report);
    }

    #[test]
    fn owned_writer_still_rejects_unknown_names_duplicate_writes_and_symlinks() {
        let (_temporary, profile, run_directory) = private_run();
        let report = tray_report(&profile);
        assert_eq!(
            write_owned_artifact(&profile, "arbitrary-report.json", &report),
            Err(super::schema::REPORT_WRITE_FAILED)
        );

        assert_eq!(write_owned_artifact(&profile, REPORT_NAME, &report), Ok(()));
        assert_eq!(
            write_owned_artifact(&profile, REPORT_NAME, &report),
            Err(super::schema::REPORT_WRITE_FAILED)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = run_directory.join("report-target.json");
            let link = run_directory.join("native-window-opacity-report.json");
            fs::write(&target, b"owned target").expect("create symlink target");
            symlink(&target, &link).expect("create report symlink");
            assert_eq!(
                write_owned_artifact(&profile, "native-window-opacity-report.json", &report),
                Err(super::schema::REPORT_WRITE_FAILED)
            );
            assert_eq!(
                fs::read(target).expect("target remains untouched"),
                b"owned target"
            );
        }
    }
}
