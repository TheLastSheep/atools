use super::*;
use serde_json::json;

#[test]
fn height_accepts_fractional_and_large_values_but_rejects_unrepresentable_geometry() {
    for height in [200.0, 200.5, 541.0, 2001.0] {
        let changes = BTreeMap::from([("windowDefaultHeight".into(), json!(height))]);
        validate_renderer_general_settings_patch(&changes).unwrap();
    }
    for value in [
        json!(199.9),
        json!("541"),
        json!(null),
        json!(true),
        json!(-1),
        json!(f64::MAX),
    ] {
        let changes = BTreeMap::from([("windowDefaultHeight".into(), value)]);
        assert!(validate_renderer_general_settings_patch(&changes).is_err());
    }
    assert!(renderer_general_settings_window_default_height(&Value::Null).is_none());
}

#[test]
fn height_write_preserves_raw_precision_and_conflicting_cas_does_not_overwrite() {
    let db = Database::in_memory().unwrap();
    let raw = r#"{"unknown":9007199254740993,"builtinAppShortcutsEnabled":{"kill":false},"theme":"dark"}"#;
    db.set_setting("settings-general", raw).unwrap();
    let changes = BTreeMap::from([("windowDefaultHeight".into(), json!(200.5))]);
    let updated = db
        .mutate_renderer_general_settings(Some(raw), &changes)
        .unwrap();
    assert!(updated.contains("9007199254740993"));
    let value: Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(value["windowDefaultHeight"], 200.5);
    assert_eq!(value["builtinAppShortcutsEnabled"]["kill"], false);
    assert!(db
        .mutate_renderer_general_settings(Some(raw), &changes)
        .is_err());
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(updated.as_str())
    );
    let bad = BTreeMap::from([("windowDefaultHeight".into(), json!(199))]);
    assert!(db
        .mutate_renderer_general_settings(Some(&updated), &bad)
        .is_err());
    assert_eq!(
        db.read_renderer_general_settings().unwrap().unwrap(),
        updated
    );
}
