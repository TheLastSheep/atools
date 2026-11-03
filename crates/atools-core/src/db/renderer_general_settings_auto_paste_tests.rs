use super::{validate_renderer_general_settings_patch, Database, SETTINGS_KEY};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn patch(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn auto_paste_values_persist_through_sqlite_reopen_and_preserve_unknown_settings() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-auto-paste.sqlite");
    let initial = json!({
        "theme": "dark",
        "hotkey": false,
        "apiCredential": "preserved-only-in-storage",
        "unknown": {"nested": ["kept", 7, true]}
    })
    .to_string();
    let first = Database::open(&path).unwrap();
    first.set_setting(SETTINGS_KEY, &initial).unwrap();
    let mut expected = first.read_renderer_general_settings().unwrap().unwrap();
    drop(first);

    for value in ["off", "1s", "3s", "5s", "10s"] {
        assert!(
            validate_renderer_general_settings_patch(&patch(&[("autoPaste", json!(value))]))
                .is_ok()
        );
        let db = Database::open(&path).unwrap();
        let updated = db
            .mutate_renderer_general_settings(
                Some(&expected),
                &patch(&[("autoPaste", json!(value))]),
            )
            .unwrap();
        drop(db);

        let reopened = Database::open(&path).unwrap();
        let stored_raw = reopened.read_renderer_general_settings().unwrap().unwrap();
        assert_eq!(stored_raw, updated);
        let stored: Value = serde_json::from_str(&stored_raw).unwrap();
        assert_eq!(stored["autoPaste"], value);
        assert_eq!(stored["theme"], "dark");
        assert_eq!(stored["hotkey"], false, "legacy values are not revalidated");
        assert_eq!(stored["apiCredential"], "preserved-only-in-storage");
        assert_eq!(stored["unknown"]["nested"], json!(["kept", 7, true]));
        expected = stored_raw;
    }
}

#[test]
fn auto_paste_rejects_unknown_values_and_types_without_mutating_sqlite() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"autoPaste":"3s","theme":"dark","unknown":{"kept":true}}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();

    for value in [
        Value::Null,
        json!(false),
        json!(0),
        json!([]),
        json!({}),
        json!(""),
        json!("0s"),
        json!("2s"),
        json!("30s"),
        json!("3S"),
        json!(" 3s"),
    ] {
        let changes = patch(&[("autoPaste", value)]);
        assert!(validate_renderer_general_settings_patch(&changes).is_err());
        assert!(db
            .mutate_renderer_general_settings(Some(initial), &changes)
            .is_err());
        assert_eq!(
            db.read_renderer_general_settings().unwrap().as_deref(),
            Some(initial)
        );
    }

    let unknown = patch(&[("autoPasteDelay", json!("3s"))]);
    assert!(validate_renderer_general_settings_patch(&unknown).is_err());
    assert!(db
        .mutate_renderer_general_settings(Some(initial), &unknown)
        .is_err());
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(initial)
    );
}

#[test]
fn stale_auto_paste_write_cannot_overwrite_a_concurrent_settings_winner() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-auto-paste-cas.sqlite");
    let first = Database::open(&path).unwrap();
    let initial = r#"{"theme":"system","unknown":{"kept":true}}"#;
    first.set_setting(SETTINGS_KEY, initial).unwrap();
    let expected = first.read_renderer_general_settings().unwrap().unwrap();
    let second = Database::open(&path).unwrap();
    let winner = second
        .mutate_renderer_general_settings(Some(&expected), &patch(&[("theme", json!("dark"))]))
        .unwrap();

    assert!(first
        .mutate_renderer_general_settings(Some(&expected), &patch(&[("autoPaste", json!("10s"))]),)
        .is_err());
    let final_raw = first.read_renderer_general_settings().unwrap().unwrap();
    assert_eq!(final_raw, winner);
    let stored: Value = serde_json::from_str(&final_raw).unwrap();
    assert_eq!(stored["theme"], "dark");
    assert!(stored.get("autoPaste").is_none());
    assert_eq!(stored["unknown"]["kept"], true);
}
