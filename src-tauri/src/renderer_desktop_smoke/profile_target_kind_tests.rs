use std::env;

use super::{LaunchTargetKind, Profile};

fn arguments(temp: &tempfile::TempDir, journey: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--fixture-root".into(),
        env::temp_dir()
            .join(format!(
                "atools-renderer-target-kind-{}",
                uuid::Uuid::new_v4()
            ))
            .to_string_lossy()
            .into_owned(),
        "--renderer-dist".into(),
        temp.path().to_string_lossy().into_owned(),
        "--output".into(),
        temp.path()
            .join(format!("report-{}.json", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned(),
        "--auto-clear".into(),
        "never".into(),
    ];
    if let Some(journey) = journey {
        args.extend(["--journey".into(), journey.into()]);
    }
    args
}

#[test]
fn target_kind_defaults_to_app_without_changing_other_profiles() {
    let temp = tempfile::tempdir().unwrap();
    let profile = Profile::from_args(&arguments(&temp, None)).unwrap();
    assert_eq!(profile.launch_target_kind, LaunchTargetKind::App);
}

#[test]
fn target_kind_is_launch_return_only_and_strictly_parsed() {
    let temp = tempfile::tempdir().unwrap();
    let mut unrelated = arguments(&temp, Some("catalog"));
    unrelated.extend(["--target-kind".into(), "app".into()]);
    assert!(Profile::from_args(&unrelated)
        .unwrap_err()
        .contains("target-kind requires --journey launch-return"));

    let mut invalid = arguments(&temp, Some("launch-return"));
    invalid.extend(["--target-kind".into(), "file".into()]);
    assert!(Profile::from_args(&invalid)
        .unwrap_err()
        .contains("target-kind must be app or local-shortcut"));

    let mut duplicate = arguments(&temp, Some("launch-return"));
    duplicate.extend([
        "--target-kind".into(),
        "app".into(),
        "--target-kind".into(),
        "local-shortcut".into(),
    ]);
    assert!(Profile::from_args(&duplicate)
        .unwrap_err()
        .contains("duplicate renderer smoke flag: --target-kind"));
}

#[test]
fn local_shortcut_target_kind_is_accepted_only_by_launch_return_profile() {
    let temp = tempfile::tempdir().unwrap();
    let mut args = arguments(&temp, Some("launch-return"));
    args.extend(["--target-kind".into(), "local-shortcut".into()]);
    match Profile::from_args(&args) {
        Ok(profile) => assert_eq!(profile.launch_target_kind, LaunchTargetKind::LocalShortcut),
        Err(error)
            if !cfg!(all(
                feature = "legacy-node-smoke",
                feature = "ztools-multiwebview"
            )) =>
        {
            assert!(error.contains("requires --features legacy-node-smoke,ztools-multiwebview"));
        }
        Err(error) => panic!("valid local-shortcut launch-return profile rejected: {error}"),
    }
}
