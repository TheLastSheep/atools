use super::{Database, SETTINGS_KEY};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn patch(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn integral_float_row_counts_store_as_integers_without_breaking_cas_or_unknown_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-row-counts.sqlite");
    let db = Database::open(&path).unwrap();
    let initial = json!({
        "aiApiKey": "secret-retained-only-in-storage",
        "unknownNativeField": {"retained": true}
    })
    .to_string();
    db.set_setting(SETTINGS_KEY, &initial).unwrap();
    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    let changes = patch(&[("recentRows", json!(2.0)), ("pinnedRows", json!(-0.0))]);

    assert!(db
        .mutate_renderer_general_settings(Some("{}"), &changes)
        .is_err());
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(initial.as_str())
    );

    let updated = db
        .mutate_renderer_general_settings(Some(&expected), &changes)
        .unwrap();
    let stored: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(stored["recentRows"].as_u64(), Some(2));
    assert_eq!(stored["pinnedRows"].as_u64(), Some(0));
    assert_eq!(stored["aiApiKey"], "secret-retained-only-in-storage");
    assert_eq!(stored["unknownNativeField"]["retained"], true);

    drop(db);
    let reopened = Database::open(&path).unwrap();
    let reopened_raw = reopened.read_renderer_general_settings().unwrap().unwrap();
    assert_eq!(reopened_raw, updated);
    let reopened_settings: Value = serde_json::from_str(&reopened_raw).unwrap();
    assert_eq!(reopened_settings["recentRows"].as_u64(), Some(2));
    assert_eq!(reopened_settings["pinnedRows"].as_u64(), Some(0));
}
