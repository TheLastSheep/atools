use super::{Database, SETTINGS_KEY};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn hotkey_patch(value: Value) -> BTreeMap<String, Value> {
    BTreeMap::from([("hotkey".to_owned(), value)])
}

#[test]
fn hotkey_accepts_nonempty_trimmed_control_free_utf8_within_256_bytes() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"unknown":{"retained":true}}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();
    let maximum_utf8 = "é".repeat(128);

    let updated = db
        .mutate_renderer_general_settings(Some(initial), &hotkey_patch(json!(maximum_utf8)))
        .unwrap();

    let stored: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(stored["hotkey"].as_str().unwrap().len(), 256);
    assert_eq!(stored["unknown"]["retained"], true);
}

#[test]
fn hotkey_rejects_empty_whitespace_control_oversized_and_non_string_values() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"theme":"dark","unknown":7}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();

    let invalid = [
        json!(""),
        json!(" Command+K"),
        json!("Command+K "),
        json!("line\nfeed"),
        json!("\u{0085}"),
        json!("x".repeat(257)),
        json!("é".repeat(129)),
        Value::Null,
        json!(false),
        json!(1),
        json!([]),
        json!({}),
    ];
    for value in invalid {
        assert!(db
            .mutate_renderer_general_settings(Some(initial), &hotkey_patch(value))
            .is_err());
        assert_eq!(
            db.read_renderer_general_settings().unwrap().as_deref(),
            Some(initial)
        );
    }
}
