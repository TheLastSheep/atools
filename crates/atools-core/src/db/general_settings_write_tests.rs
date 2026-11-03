use super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn patch(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn prepared_dialog_write_conflicts_after_an_independent_renderer_theme_update() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-write-dialog.sqlite");
    let dialog = Database::open(&path).unwrap();
    let initial = r#"{"theme":"dark","apiCredential":"fixture-secret","unknown":{"keep":true}}"#;
    dialog.set_setting(SETTINGS_KEY, initial).unwrap();
    let renderer = Database::open(&path).unwrap();

    let dialog_snapshot = dialog.read_renderer_general_settings().unwrap().unwrap();
    let plan = dialog
        .prepare_general_settings_write(
            Some(&dialog_snapshot),
            &patch(&[("dialogPreference", json!("selected"))]),
        )
        .unwrap();
    assert_eq!(plan.before(), Some(dialog_snapshot.as_str()));
    assert_eq!(
        serde_json::from_str::<Value>(plan.after()).unwrap()["dialogPreference"],
        "selected"
    );
    assert_eq!(
        dialog.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(initial)
    );

    renderer
        .mutate_renderer_general_settings(
            Some(&dialog_snapshot),
            &patch(&[("theme", json!("light"))]),
        )
        .unwrap();
    let error = dialog.commit_general_settings_write(plan).unwrap_err();
    assert!(error.to_string().contains("General settings changed"));

    let reopened = Database::open(&path).unwrap();
    let final_raw = reopened.read_renderer_general_settings().unwrap().unwrap();
    let final_settings: Value = serde_json::from_str(&final_raw).unwrap();
    assert_eq!(final_settings["theme"], "light");
    assert_eq!(final_settings["apiCredential"], "fixture-secret");
    assert_eq!(final_settings["unknown"]["keep"], true);
    assert!(final_settings.get("dialogPreference").is_none());
}

#[test]
fn commit_rechecks_the_snapshot_after_an_independent_current_patch() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-write-recheck.sqlite");
    let dialog = Database::open(&path).unwrap();
    let initial = r#"{"theme":"dark","credential":"fixture-token"}"#;
    dialog.set_setting(SETTINGS_KEY, initial).unwrap();
    let native = Database::open(&path).unwrap();
    let expected = dialog.read_renderer_general_settings().unwrap().unwrap();
    let plan = dialog
        .prepare_general_settings_write(Some(&expected), &patch(&[("dialogValue", json!(true))]))
        .unwrap();

    native
        .patch_general_settings_current(&patch(&[("captureEnabled", json!(true))]))
        .unwrap();
    let error = dialog.commit_general_settings_write(plan).unwrap_err();
    assert!(error.to_string().contains("General settings changed"));

    let reopened = Database::open(&path).unwrap();
    let final_settings: Value = serde_json::from_str(
        reopened
            .read_renderer_general_settings()
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(final_settings["captureEnabled"], true);
    assert_eq!(final_settings["credential"], "fixture-token");
    assert!(final_settings.get("dialogValue").is_none());
}

#[test]
fn latest_current_patch_preserves_renderer_theme_and_unknown_credentials_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-write-current.sqlite");
    let renderer = Database::open(&path).unwrap();
    let initial = r#"{"theme":"dark","apiKey":"fixture-key","unknown":{"nested":[1,2]}}"#;
    renderer.set_setting(SETTINGS_KEY, initial).unwrap();
    let native = Database::open(&path).unwrap();
    let expected = renderer.read_renderer_general_settings().unwrap().unwrap();

    renderer
        .mutate_renderer_general_settings(Some(&expected), &patch(&[("theme", json!("light"))]))
        .unwrap();
    native
        .patch_general_settings_current(&patch(&[("captureEnabled", json!(true))]))
        .unwrap();

    let reopened = Database::open(&path).unwrap();
    let final_settings: Value = serde_json::from_str(
        reopened
            .read_renderer_general_settings()
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(final_settings["theme"], "light");
    assert_eq!(final_settings["captureEnabled"], true);
    assert_eq!(final_settings["apiKey"], "fixture-key");
    assert_eq!(final_settings["unknown"]["nested"], json!([1, 2]));
}

#[test]
fn malformed_or_oversized_general_writes_leave_the_existing_value_unchanged() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"theme":"dark","unknown":true}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();

    let mut too_many_fields = BTreeMap::new();
    for index in 0..=MAX_PATCH_FIELDS {
        too_many_fields.insert(format!("field{index}"), json!(index));
    }
    let too_deep = (0..=MAX_JSON_DEPTH).fold(Value::Null, |value, _| json!([value]));
    let invalid_patches = [
        BTreeMap::new(),
        too_many_fields,
        patch(&[(&"k".repeat(MAX_KEY_BYTES + 1), json!(true))]),
        patch(&[("__proto__", json!({"polluted": true}))]),
        patch(&[("nested", json!({"constructor": "bad"}))]),
        patch(&[("deep", too_deep)]),
        patch(&[("large", json!("x".repeat(MAX_GENERAL_BYTES)))]),
        patch(&[("wireHeavy", json!("\"".repeat(16_200)))]),
    ];
    for changes in invalid_patches {
        assert!(db
            .prepare_general_settings_write(Some(initial), &changes)
            .is_err());
        assert!(db.patch_general_settings_current(&changes).is_err());
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some(initial)
        );
    }

    db.set_setting(SETTINGS_KEY, "not-json").unwrap();
    assert!(db
        .prepare_general_settings_write(Some("not-json"), &patch(&[("theme", json!("light"))]),)
        .is_err());
    assert!(db
        .patch_general_settings_current(&patch(&[("theme", json!("light"))]))
        .is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some("not-json")
    );

    let oversized = format!("{{\"unknown\":\"{}\"}}", "x".repeat(MAX_GENERAL_BYTES));
    db.set_setting(SETTINGS_KEY, &oversized).unwrap();
    assert!(db
        .patch_general_settings_current(&patch(&[("theme", json!("light"))]))
        .is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(oversized.as_str())
    );
}
