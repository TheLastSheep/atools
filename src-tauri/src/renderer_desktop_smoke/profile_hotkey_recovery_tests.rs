use super::Profile;

fn args(root: &str, output: &str, journey: &str) -> Vec<String> {
    vec![
        "--fixture-root".into(),
        root.into(),
        "--renderer-dist".into(),
        "/private/tmp/renderer-dist".into(),
        "--output".into(),
        output.into(),
        "--auto-clear".into(),
        "never".into(),
        "--run-id".into(),
        "0123456789abcdef0123456789abcdef".into(),
        "--journey".into(),
        journey.into(),
    ]
}

#[test]
fn hotkey_recovery_profiles_have_separate_strict_stages_and_same_owner() {
    let root = "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef";
    let first_args = args(
        root,
        "/private/tmp/run/native-report.json",
        "main-hotkey-recovery-first",
    );
    let second_args = args(
        root,
        "/private/tmp/run-second/native-report.json",
        "main-hotkey-recovery-second",
    );
    if !cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        assert!(Profile::from_args(&first_args)
            .unwrap_err()
            .contains("requires --features"));
        return;
    }
    let first = Profile::from_args(&first_args).unwrap();
    assert!(first.main_hotkey_recovery_first && !first.main_hotkey_recovery_second);
    assert!(first.settings_input_journey);
    assert_eq!(
        first.identifier,
        "dev.atools.renderer-settings-input.0123456789abcdef0123456789abcdef"
    );

    let mut second_args = second_args;
    second_args.extend(["--resume-hotkey-owner-pid".into(), "42001".into()]);
    let second = Profile::from_args(&second_args).unwrap();
    assert!(second.main_hotkey_recovery_second && !second.main_hotkey_recovery_first);
    assert_eq!(second.resume_hotkey_owner_pid, Some(42001));
    assert_eq!(second.identifier, first.identifier);
}

#[test]
fn hotkey_resume_pid_is_required_canonical_and_second_stage_only() {
    let root = "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef";
    let mut first = args(
        root,
        "/private/tmp/run/native-report.json",
        "main-hotkey-recovery-first",
    );
    first.extend(["--resume-hotkey-owner-pid".into(), "42001".into()]);
    assert!(Profile::from_args(&first)
        .unwrap_err()
        .contains("resume-hotkey-owner-pid is required only"));

    let second = args(
        root,
        "/private/tmp/run-second/native-report.json",
        "main-hotkey-recovery-second",
    );
    assert!(Profile::from_args(&second)
        .unwrap_err()
        .contains("resume-hotkey-owner-pid is required only"));

    for pid in ["0", "0042001", "not-a-pid"] {
        let mut invalid = second.clone();
        invalid.extend(["--resume-hotkey-owner-pid".into(), pid.into()]);
        assert!(Profile::from_args(&invalid)
            .unwrap_err()
            .contains("canonical positive PID"));
    }
}
