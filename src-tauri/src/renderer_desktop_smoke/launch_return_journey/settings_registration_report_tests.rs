use super::JourneyReport;
use crate::renderer_desktop_smoke::profile::Profile;

fn profile(temp: &tempfile::TempDir, source: &str) -> Profile {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let args = vec![
        "--fixture-root".into(),
        format!("/private/tmp/atools-renderer-launch-return-{id}"),
        "--renderer-dist".into(),
        temp.path().to_string_lossy().into_owned(),
        "--output".into(),
        temp.path()
            .join(format!("{id}.json"))
            .to_string_lossy()
            .into_owned(),
        "--auto-clear".into(),
        "never".into(),
        "--journey".into(),
        "launch-return".into(),
        "--target-kind".into(),
        "local-shortcut".into(),
        "--registration-source".into(),
        source.into(),
        "--run-id".into(),
        id,
    ];
    Profile::from_args(&args).unwrap()
}

#[test]
fn core_seed_remains_v2_and_settings_child_cannot_pass_without_its_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let core = JourneyReport::new(&profile(&temp, "core-seed"), true, 2).finish();
    assert_eq!(core["schemaVersion"], 2);
    assert!(core.get("registration").is_none());
    assert!(core["metadata"].get("registrationSource").is_none());
    let mut child_report = JourneyReport::new(&profile(&temp, "settings-child"), true, 0);
    for index in 0..7 {
        child_report.set_stage(
            index,
            serde_json::json!({}),
            serde_json::json!({}),
            true,
            None,
        );
    }
    let child = child_report.finish();
    assert_eq!(child["schemaVersion"], 3);
    assert_eq!(child["metadata"]["registrationSource"], "settings-child");
    assert_eq!(child["registration"]["status"], "not_run");
    assert_eq!(child["passed"], false);
}
