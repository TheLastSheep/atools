use super::report::{CatalogReport, Stage};
use crate::renderer_desktop_smoke::profile::{PaintPresentation, Profile};
use serde_json::Value;
use std::collections::BTreeSet;

#[test]
fn catalog_stages_are_fixed_and_ordered() {
    assert_eq!(
        Stage::ALL.map(Stage::as_str),
        ["initial", "added", "removed", "disposed", "post-dispose"]
    );
    assert!(Stage::parse("post-dispose").is_some());
    assert!(Stage::parse("post_dispose").is_none());
}

#[test]
fn report_starts_closed_and_cannot_pass_without_observations() {
    let profile = Profile {
        root: "/private/tmp/owned-root".into(),
        dist: "/private/tmp/dist".into(),
        output: "/private/tmp/report.json".into(),
        auto_clear: "never".into(),
        identifier: "dev.atools.renderer-smoke.fixture".into(),
        run_id: "fixture".into(),
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
    };
    let mut report = CatalogReport::new(&profile, 0, 0);
    let value = report.to_value();
    let keys = value
        .as_object()
        .expect("report object")
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected = [
        "schemaVersion",
        "journey",
        "scope",
        "identifier",
        "root",
        "pid",
        "autoClear",
        "passed",
        "metadata",
        "clipboard",
        "staleLaunch",
        "errors",
        "stages",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    assert_eq!(keys, expected);
    assert_eq!(value["schemaVersion"], Value::from(1));
    assert_eq!(value["journey"], "catalog");
    assert_eq!(value["autoClear"], "never");
    assert_eq!(value["passed"], false);
    assert_eq!(value["clipboard"]["reads"], Value::Null);
    assert_eq!(value["clipboard"]["writes"], Value::Null);
    assert_eq!(value["clipboard"]["pastes"], Value::Null);
    assert!(value["clipboard"].get("clears").is_none());
}
