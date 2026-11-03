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
fn auto_back_enum_is_strict_and_keeps_auto_clear_values_separate() {
    for value in ["immediately", "30s", "1m", "3m", "5m", "10m", "never"] {
        assert!(validate_renderer_general_settings_patch(&patch(&[(
            "autoBackToSearch",
            json!(value)
        ),]))
        .is_ok());
    }
    for value in [
        Value::Null,
        json!(false),
        json!(1),
        json!([]),
        json!({}),
        json!("2m"),
        json!("30 seconds"),
    ] {
        assert!(
            validate_renderer_general_settings_patch(&patch(&[("autoBackToSearch", value),]))
                .is_err()
        );
    }

    assert!(
        validate_renderer_general_settings_patch(&patch(&[("autoClear", json!("2m"))])).is_ok()
    );
    assert!(
        validate_renderer_general_settings_patch(&patch(&[("autoClear", json!("30s"))])).is_err()
    );
    assert!(
        validate_renderer_general_settings_patch(&patch(&[("autoBack", json!("1m"))])).is_err()
    );
}

#[test]
fn sqlite_cas_persists_auto_back_without_revalidating_legacy_hotkey_or_unknown_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-auto-back.sqlite");
    let db = Database::open(&path).unwrap();
    let initial = json!({
        "autoBackToSearch": "never",
        "autoClear": "2m",
        "hotkey": false,
        "secret": "preserved-only-in-storage",
        "unknown": {"preserve": ["value", 7, true]},
        "theme": "dark"
    })
    .to_string();
    db.set_setting(SETTINGS_KEY, &initial).unwrap();

    assert!(
        db.mutate_renderer_general_settings(
            Some("{}"),
            &patch(&[("autoBackToSearch", json!("30s"))]),
        )
        .is_err()
    );
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(initial.as_str())
    );

    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    let updated = db
        .mutate_renderer_general_settings(
            Some(&expected),
            &patch(&[("autoBackToSearch", json!("30s"))]),
        )
        .unwrap();
    let stored: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(stored["autoBackToSearch"], "30s");
    assert_eq!(stored["autoClear"], "2m");
    assert_eq!(stored["hotkey"], false);
    assert_eq!(stored["secret"], "preserved-only-in-storage");
    assert_eq!(stored["unknown"]["preserve"], json!(["value", 7, true]));
    assert_eq!(stored["theme"], "dark");
}

#[test]
fn stale_second_connection_cannot_overwrite_auto_back_after_a_cas_winner() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-auto-back-cas.sqlite");
    let first = Database::open(&path).unwrap();
    let initial = r#"{"autoBackToSearch":"never","theme":"system"}"#;
    first.set_setting(SETTINGS_KEY, initial).unwrap();
    let expected = first.read_renderer_general_settings().unwrap().unwrap();

    let second = Database::open(&path).unwrap();
    let winner = second
        .mutate_renderer_general_settings(Some(&expected), &patch(&[("theme", json!("dark"))]))
        .unwrap();
    assert!(first
        .mutate_renderer_general_settings(
            Some(&expected),
            &patch(&[("autoBackToSearch", json!("3m"))]),
        )
        .is_err());
    assert_eq!(
        first.read_renderer_general_settings().unwrap().as_deref(),
        Some(winner.as_str())
    );
    let stored: Value = serde_json::from_str(&winner).unwrap();
    assert_eq!(stored["autoBackToSearch"], "never");
    assert_eq!(stored["theme"], "dark");
}
