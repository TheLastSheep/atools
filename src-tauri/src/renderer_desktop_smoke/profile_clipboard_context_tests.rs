use super::Profile;
use std::path::{Path, PathBuf};

const RUN_ID: &str = "0123456789abcdef0123456789abcdef";

fn args(root: &Path, dist: &Path, output: &Path) -> Vec<String> {
    vec![
        "--fixture-root".into(),
        root.to_string_lossy().into_owned(),
        "--renderer-dist".into(),
        dist.to_string_lossy().into_owned(),
        "--output".into(),
        output.to_string_lossy().into_owned(),
        "--auto-clear".into(),
        "never".into(),
        "--run-id".into(),
        RUN_ID.into(),
        "--journey".into(),
        "clipboard-context".into(),
    ]
}

fn fixed_root() -> PathBuf {
    PathBuf::from(format!("/private/tmp/atools-renderer-clipboard-{RUN_ID}"))
}

#[test]
fn clipboard_context_profile_uses_its_fixed_private_identity_and_existing_profile_flow() {
    let temporary = tempfile::tempdir().unwrap();
    let root = fixed_root();
    let output = temporary.path().join("clipboard-report.json");
    let profile_args = args(&root, temporary.path(), &output);

    if !cfg!(all(target_os = "macos", feature = "legacy-node-smoke")) {
        assert!(Profile::from_args(&profile_args)
            .unwrap_err()
            .contains("requires macOS and --features legacy-node-smoke"));
        return;
    }

    let profile = Profile::from_args(&profile_args).unwrap();
    assert!(profile.clipboard_context_journey);
    assert_eq!(profile.root, root);
    assert_eq!(profile.run_id, RUN_ID);
    assert_eq!(
        profile.identifier,
        format!("dev.atools.renderer-clipboard.{RUN_ID}")
    );
    assert_eq!(profile.auto_clear, "never");
    assert!(!profile.settings_input_journey && !profile.settings_journey);
    assert!(!profile.launcher_journey && !profile.main_panel_journey);
}

#[test]
fn clipboard_context_rejects_wrong_root_clear_policy_and_other_journey_options() {
    if !cfg!(all(target_os = "macos", feature = "legacy-node-smoke")) {
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let root = fixed_root();
    let output = temporary.path().join("clipboard-report.json");
    let valid = args(&root, temporary.path(), &output);

    let mut wrong_root = valid.clone();
    wrong_root[1] = "/private/tmp/atools-renderer-clipboard-other".into();
    assert!(Profile::from_args(&wrong_root)
        .unwrap_err()
        .contains("fixed private run path"));

    let mut wrong_clear = valid.clone();
    let clear = wrong_clear
        .iter()
        .position(|argument| argument == "--auto-clear")
        .unwrap();
    wrong_clear[clear + 1] = "immediately".into();
    assert!(Profile::from_args(&wrong_clear)
        .unwrap_err()
        .contains("clipboard-context requires --auto-clear never"));

    for incompatible in [
        vec!["--resume-seed-pid", "42001"],
        vec!["--resume-hotkey-owner-pid", "42001"],
        vec!["--window-drag", "false"],
        vec!["--paint-presentation", "hidden"],
    ] {
        let mut invalid = valid.clone();
        invalid.extend(incompatible.into_iter().map(str::to_owned));
        assert!(Profile::from_args(&invalid).is_err());
    }
}
