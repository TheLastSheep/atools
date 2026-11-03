use crate::renderer_desktop_smoke::profile::Profile;
use crate::renderer_desktop_smoke::settings_input_journey::main_hotkey_startup_schema as schema;
use serde_json::json;

const RUN_ID: &str = "0123456789abcdef0123456789abcdef";
const RESUME_PID: &str = "4294967295";

fn profile(journey: &str, suffix: &str) -> Profile {
    let root = format!("/private/tmp/atools-renderer-settings-input-{RUN_ID}");
    let output = format!("/private/tmp/{suffix}/native-report.json");
    let mut args = vec![
        "--fixture-root".into(),
        root,
        "--renderer-dist".into(),
        "/private/tmp/renderer-dist".into(),
        "--output".into(),
        output,
        "--auto-clear".into(),
        "never".into(),
        "--run-id".into(),
        RUN_ID.into(),
        "--journey".into(),
        journey.into(),
    ];
    if journey == "main-hotkey-recovery-second" {
        args.extend(["--resume-hotkey-owner-pid".into(), RESUME_PID.into()]);
    }
    Profile::from_args(&args).expect("valid settings-input profile")
}

#[test]
fn recovery_reports_accept_partial_failure_facts_but_never_call_them_success() {
    if !cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        return;
    }
    let first = profile("main-hotkey-recovery-first", "first");
    let first_report = schema::first_report(&first, schema::empty_first(), &[]);
    assert!(schema::valid_first(&first, &first_report));
    assert!(!schema::observations_passed(
        &first_report["observations"],
        true
    ));

    let second = profile("main-hotkey-recovery-second", "second");
    let second_report = schema::second_report(&second, u32::MAX, schema::empty_second(), &[]);
    assert!(schema::valid_second(&second, &second_report, u32::MAX));
    assert!(!schema::observations_passed(
        &second_report["observations"],
        false
    ));
    assert!(!schema::valid_second(&second, &second_report, u32::MAX - 1));

    let mut forged = first_report;
    forged["unexpected"] = json!(true);
    assert!(!schema::valid_first(&first, &forged));
}

#[test]
fn startup_recovery_probe_is_limited_to_its_two_profiles_and_exact_facts() {
    if !cfg!(all(
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        return;
    }
    let first = profile("main-hotkey-recovery-first", "first-probe");
    let ordinary = profile("settings-input", "ordinary-probe");
    assert!(schema::allowed_for_profile(
        &first,
        "childHotkeyStartupInspect",
        "ztools-settings-0123456789abcdef0123456789abcdef"
    ));
    assert!(!schema::allowed_for_profile(
        &ordinary,
        "childHotkeyStartupInspect",
        "ztools-settings-0123456789abcdef0123456789abcdef"
    ));
    assert!(!schema::allowed_for_profile(
        &first,
        "childHotkeyStartupInspect",
        "main"
    ));

    let valid = json!({
        "routeGeneral": true,
        "hotkeyControlUnique": true,
        "hotkeyControlEmpty": true,
        "projectedHotkeyEmpty": true,
        "currentShortcutEmpty": true,
        "documentHidden": true,
        "documentHasFocus": false
    });
    assert_eq!(
        schema::validate_probe_evidence("childHotkeyStartupInspect", &valid),
        Some(Ok(()))
    );
    let mut extra = valid;
    extra["displayValue"] = json!("Command+Command");
    assert!(
        schema::validate_probe_evidence("childHotkeyStartupInspect", &extra)
            .is_some_and(|result| result.is_err())
    );

    let edit = json!({
        "routeGeneral": true,
        "hotkeyControlUnique": true,
        "placeholderControlUnique": true,
        "placeholderClickDispatched": true,
        "inputDispatched": true,
        "changeDispatched": true,
        "placeholderStored": true,
        "projectedHotkeyEmpty": true,
        "currentShortcutEmpty": true,
        "documentHidden": true,
        "documentHasFocus": false
    });
    assert_eq!(
        schema::validate_probe_evidence("childHotkeyStartupPlaceholder", &edit),
        Some(Ok(()))
    );
    let mut obsolete = edit;
    obsolete
        .as_object_mut()
        .unwrap()
        .remove("projectedHotkeyEmpty");
    obsolete["invalidHotkeyPreserved"] = json!(true);
    assert!(
        schema::validate_probe_evidence("childHotkeyStartupPlaceholder", &obsolete)
            .is_some_and(|result| result.is_err())
    );
}
