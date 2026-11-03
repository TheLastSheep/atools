use super::*;
use crate::renderer_desktop_smoke::profile::PaintPresentation;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
};
#[test]
fn probe_flag_and_profile_are_closed() {
    assert!(valid_flag(None, false, false));
    assert!(valid_flag(Some("1"), true, false));
    for (flag, catalog, drag) in [
        (Some("0"), true, false),
        (Some("1"), false, false),
        (Some("1"), true, true),
    ] {
        assert!(!valid_flag(flag, catalog, drag));
    }
}
#[test]
fn owned_report_rejects_bad_owner_and_never_overwrites_existing_report() {
    let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
    let directory = tempfile::Builder::new()
        .prefix("atools-main-drop-probe-")
        .tempdir_in(temp)
        .unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let profile = profile_at(directory.path());
    let marker = profile.root.join(".atools-renderer-smoke-owner.json");
    let value = json!({"schemaVersion":1,"pid":std::process::id(),"identifier":profile.identifier,"root":profile.root});
    fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(private_owner(&profile));
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(write_report(&profile, b"bad").is_err());
    let report = profile.root.join("main-drop-report.json");
    assert!(!report.exists());
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
    let link = profile.root.join("owner-hardlink");
    fs::hard_link(&marker, &link).unwrap();
    assert!(write_report(&profile, b"bad").is_err());
    assert!(!report.exists());
    fs::remove_file(link).unwrap();
    write_report(&profile, b"first").unwrap();
    assert_eq!(fs::metadata(&report).unwrap().mode() & 0o777, 0o600);
    assert!(write_report(&profile, b"second").is_err());
    assert_eq!(fs::read(report).unwrap(), b"first");
}
pub(super) fn profile_at(root: &Path) -> Profile {
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
        catalog_journey: true,
        updater_journey: false,
        updater_about: false,
        window_drag: false,
        main_panel_journey: false,
        clipboard_context_journey: false,
    }
}

#[test]
fn actual_embedded_js_installer_and_callback_contract() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/renderer_desktop_smoke/main_drop_probe_script_tests.mjs"
        ))
        .output()
        .expect("Node is required for the actual embedded QA script regression");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn action_receipts_reject_unknown_or_ambiguous_results() {
    assert!(action_ack(&json!({"ok":true,"error":null})).is_ok());
    for code in ["reader-missing", "prime-false", "prime-exception"] {
        let result = action_ack(&json!({"ok":false,"error":code}));
        assert!(result.unwrap_err().ends_with(code));
    }
    for value in [
        json!(false),
        json!({"ok":false,"error":"private error"}),
        json!({"ok":true,"error":null,"extra":1}),
    ] {
        assert_eq!(
            action_ack(&value),
            Err("main-drop-probe-action-receipt-invalid")
        );
    }
}
