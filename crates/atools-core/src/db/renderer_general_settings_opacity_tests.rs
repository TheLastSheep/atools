use super::{
    validate_renderer_general_settings_patch, Database, RENDERER_GENERAL_SETTINGS_FIELDS,
    SETTINGS_KEY,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn patch(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

fn opacity_patch(value: Value) -> BTreeMap<String, Value> {
    [("opacity".to_owned(), value)].into_iter().collect()
}

#[test]
fn opacity_remains_the_fifteenth_field_and_accepts_only_finite_numbers_in_range() {
    assert_eq!(RENDERER_GENERAL_SETTINGS_FIELDS.len(), 24);
    assert_eq!(RENDERER_GENERAL_SETTINGS_FIELDS[14], "opacity");
    let too_many = (0..=RENDERER_GENERAL_SETTINGS_FIELDS.len())
        .map(|index| (format!("field{index}"), json!(true)))
        .collect::<BTreeMap<_, _>>();
    assert!(validate_renderer_general_settings_patch(&too_many)
        .unwrap_err()
        .to_string()
        .contains("supported field count"));
    for value in [json!(0.3), json!(0.65), json!(1.0)] {
        assert!(validate_renderer_general_settings_patch(&opacity_patch(value)).is_ok());
    }
    for value in [
        Value::Null,
        json!("0.65"),
        json!(true),
        json!([]),
        json!({}),
        json!(0.299999),
        json!(1.000001),
        json!(0.0),
        json!(-1.0),
    ] {
        assert!(validate_renderer_general_settings_patch(&opacity_patch(value)).is_err());
    }
    assert!(serde_json::Number::from_f64(f64::NAN).is_none());
    assert!(serde_json::Number::from_f64(f64::INFINITY).is_none());
}

#[test]
fn prepare_is_side_effect_free_and_commit_preserves_secrets_and_unknown_values_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("renderer-opacity.sqlite");
    let db = Database::open(&path).unwrap();
    let initial = json!({
        "opacity": 1.0,
        "theme": "dark",
        "apiCredential": "fixture-secret-retained",
        "unknownField": {"nested": ["kept", 7, true]}
    })
    .to_string();
    db.set_setting(SETTINGS_KEY, &initial).unwrap();
    let expected = db.read_renderer_general_settings().unwrap().unwrap();

    let plan = db
        .prepare_renderer_general_settings_write(Some(&expected), &opacity_patch(json!(0.65)))
        .unwrap();
    assert_eq!(plan.before(), Some(expected.as_str()));
    let prepared: Value = serde_json::from_str(plan.after()).unwrap();
    assert_eq!(prepared["opacity"], 0.65);
    assert_eq!(prepared["apiCredential"], "fixture-secret-retained");
    assert_eq!(prepared["unknownField"]["nested"], json!(["kept", 7, true]));
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(initial.as_str()),
        "preparing a write must not commit it"
    );

    let committed = db.commit_general_settings_write(plan).unwrap();
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(committed.as_str())
    );
    drop(db);

    let reopened = Database::open(&path).unwrap();
    let reopened_raw = reopened.read_renderer_general_settings().unwrap().unwrap();
    let reopened_value: Value = serde_json::from_str(&reopened_raw).unwrap();
    assert_eq!(reopened_value["opacity"], 0.65);
    assert_eq!(reopened_value["apiCredential"], "fixture-secret-retained");
    assert_eq!(
        reopened_value["unknownField"]["nested"],
        json!(["kept", 7, true])
    );
}

#[test]
fn renderer_opacity_prepare_supports_missing_row_and_mutate_obeys_cas() {
    let db = Database::in_memory().unwrap();
    let plan = db
        .prepare_renderer_general_settings_write(None, &opacity_patch(json!(0.3)))
        .unwrap();
    assert_eq!(plan.before(), None);
    assert_eq!(db.read_renderer_general_settings().unwrap(), None);
    let initial = db.commit_general_settings_write(plan).unwrap();
    let stored: Value = serde_json::from_str(&initial).unwrap();
    assert_eq!(stored["opacity"], 0.3);
    for invalid in [
        Value::Null,
        json!("0.65"),
        json!(true),
        json!([]),
        json!({}),
        json!(0.299),
        json!(1.001),
    ] {
        assert!(db
            .mutate_renderer_general_settings(Some(&initial), &opacity_patch(invalid))
            .is_err());
        assert_eq!(
            db.read_renderer_general_settings().unwrap().as_deref(),
            Some(initial.as_str())
        );
    }

    let enabled = db
        .mutate_renderer_general_settings(Some(&initial), &opacity_patch(json!(1.0)))
        .unwrap();
    let enabled_value: Value = serde_json::from_str(&enabled).unwrap();
    assert_eq!(enabled_value["opacity"], 1.0);
    assert!(db
        .mutate_renderer_general_settings(Some(&initial), &opacity_patch(json!(0.65)))
        .unwrap_err()
        .to_string()
        .contains("General settings changed"));
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(enabled.as_str())
    );
}

#[test]
fn opacity_plan_conflicts_after_a_second_sqlite_connection_commits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("renderer-opacity-conflict.sqlite");
    let planner = Database::open(&path).unwrap();
    let initial = json!({
        "opacity": 0.8,
        "theme": "dark",
        "apiKey": "fixture-token-retained",
        "unknown": {"keep": true}
    })
    .to_string();
    planner.set_setting(SETTINGS_KEY, &initial).unwrap();
    let competitor = Database::open(&path).unwrap();
    let expected = planner.read_renderer_general_settings().unwrap().unwrap();
    let plan = planner
        .prepare_renderer_general_settings_write(Some(&expected), &opacity_patch(json!(0.65)))
        .unwrap();

    competitor
        .mutate_renderer_general_settings(Some(&expected), &patch(&[("theme", json!("light"))]))
        .unwrap();
    assert!(planner
        .commit_general_settings_write(plan)
        .unwrap_err()
        .to_string()
        .contains("General settings changed"));

    let reopened = Database::open(&path).unwrap();
    let final_value: Value = serde_json::from_str(
        reopened
            .read_renderer_general_settings()
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(final_value["opacity"], 0.8);
    assert_eq!(final_value["theme"], "light");
    assert_eq!(final_value["apiKey"], "fixture-token-retained");
    assert_eq!(final_value["unknown"]["keep"], true);
}
