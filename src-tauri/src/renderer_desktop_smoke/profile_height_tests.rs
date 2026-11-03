use super::*;
use std::path::PathBuf;

fn args(run: &str, case: &str) -> Vec<String> {
    let root = format!("/private/tmp/atools-renderer-smoke-{run}");
    [
        "--fixture-root",
        &root,
        "--renderer-dist",
        "/private/tmp/height-dist",
        "--output",
        &format!("{root}/report.json"),
        "--auto-clear",
        "never",
        "--run-id",
        run,
        "--journey",
        "settings-height",
        "--height-case",
        case,
    ]
    .map(str::to_owned)
    .to_vec()
}
#[test]
fn height_cases_are_closed_and_do_not_turn_on_old_side_effectful_journeys() {
    let run = uuid::Uuid::new_v4().simple().to_string();
    for name in ["a", "b", "c", "d"] {
        let result = Profile::from_args(&args(&run, name));
        if cfg!(all(
            feature = "legacy-node-smoke",
            feature = "ztools-multiwebview"
        )) {
            let profile = result.unwrap();
            assert_eq!(profile.settings_height_case.unwrap().as_str(), name);
            assert!(
                !profile.settings_journey
                    && !profile.settings_input_journey
                    && !profile.manual_ui
                    && !profile.launch_return_journey
            );
            assert_eq!(
                profile.identifier,
                format!("dev.atools.renderer-smoke.{run}")
            );
        } else {
            assert!(result.is_err());
        }
    }
    for case in ["A", "e", "a;b", ""] {
        assert!(Profile::from_args(&args(&run, case)).is_err());
    }
    let mut values = args(&run, "a");
    values.extend(["--seed-db".into(), "/Users/someone/private.sqlite".into()]);
    assert!(Profile::from_args(&values).is_err());
    assert!(HeightCase::parse(Some("a"), Some("manual-ui")).is_err());
}
#[test]
fn height_profile_rejects_wrong_paths_other_profiles_and_bad_owner_before_installation() {
    let run = uuid::Uuid::new_v4().simple().to_string();
    let Ok(mut profile) = Profile::from_args(&args(&run, "a")) else {
        return;
    };
    assert!(profile.validate_settings_height_fixture().is_err());
    profile.prepare().unwrap();
    let root = profile.root.clone();
    let check = (|| {
        profile.validate_settings_height_fixture().unwrap();
        profile.settings_height_case = None;
        assert!(profile.validate_settings_height_fixture().is_err());
        profile.settings_height_case = Some(HeightCase::A);
        let output = profile.output.clone();
        profile.output = PathBuf::from("/private/tmp/foreign-report.json");
        assert!(profile.validate_settings_height_fixture().is_err());
        profile.output = output;
        profile.manual_ui = true;
        assert!(profile.validate_settings_height_fixture().is_err());
        profile.manual_ui = false;
        std::fs::write(root.join(".atools-renderer-smoke-owner.json"), "{}").unwrap();
        assert!(profile.validate_settings_height_fixture().is_err());
    })();
    std::fs::remove_dir_all(root).unwrap();
    check
}
#[test]
fn height_case_chain_retains_absence_fractional_reset_and_large_requested_intent() {
    assert_eq!(
        (HeightCase::A.desired(), HeightCase::A.target()),
        (542.0, Some(200.5))
    );
    assert_eq!(
        (HeightCase::B.desired(), HeightCase::B.target()),
        (200.5, Some(541.0))
    );
    assert_eq!(
        (HeightCase::C.desired(), HeightCase::C.target()),
        (541.0, Some(2001.0))
    );
    assert_eq!(
        (HeightCase::D.desired(), HeightCase::D.target()),
        (2001.0, None)
    );
    assert_eq!(HeightCase::A.stages().len(), 6);
    assert_eq!(HeightCase::D.stages().len(), 2);
}
