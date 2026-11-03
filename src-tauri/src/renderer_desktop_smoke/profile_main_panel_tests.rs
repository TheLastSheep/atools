use super::{args, Profile};
use std::path::Path;

#[test]
fn main_panel_profile_requires_private_identity_and_never_clears_search() {
    let temporary = tempfile::tempdir().unwrap();
    let run_id = "0123456789abcdef0123456789abcdef";
    let root = Path::new("/private/tmp").join(format!("atools-renderer-smoke-{run_id}"));
    let mut values = args(
        &root,
        temporary.path(),
        &temporary.path().join("main-panel-report.json"),
    );
    values.extend([
        "--run-id".into(),
        run_id.into(),
        "--journey".into(),
        "main-panel".into(),
    ]);

    if cfg!(all(
        target_os = "macos",
        feature = "macos-main-panel-prototype"
    )) {
        let profile = Profile::from_args(&values).unwrap();
        assert!(profile.main_panel_journey);
        assert!(!profile.settings_input_journey && !profile.catalog_journey);
        assert_eq!(profile.auto_clear, "never");
        assert_eq!(
            profile.identifier,
            format!("dev.atools.renderer-smoke.{run_id}")
        );

        let mut wrong_root = values.clone();
        let root_argument = wrong_root
            .iter()
            .position(|argument| argument == "--fixture-root")
            .unwrap();
        wrong_root[root_argument + 1] = "/private/tmp/other-renderer-smoke".into();
        assert!(Profile::from_args(&wrong_root)
            .unwrap_err()
            .contains("fixed private run path"));
    } else {
        assert!(Profile::from_args(&values)
            .unwrap_err()
            .contains("requires macOS and --features macos-main-panel-prototype"));
    }

    let mut clears_search = values;
    let clear_argument = clears_search
        .iter()
        .position(|argument| argument == "--auto-clear")
        .unwrap();
    clears_search[clear_argument + 1] = "immediately".into();
    assert!(Profile::from_args(&clears_search)
        .unwrap_err()
        .contains("main-panel requires --auto-clear never"));
}
