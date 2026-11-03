use super::{validate_renderer_general_settings_patch, Database, SETTINGS_KEY};
use serde_json::{json, Value};
use std::collections::BTreeMap;
fn one(value: Value) -> BTreeMap<String, Value> {
    BTreeMap::from([("autoCheckUpdate".into(), value)])
}

#[test]
fn auto_check_boolean_cas_reopens_and_preserves_unknown_fields() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("auto-check.sqlite");
    let db = Database::open(&path).unwrap();
    let original=json!({"unknown":{"big":18446744073709551615u64,"items":[1,false]},"theme":"legacy-invalid-kept"}).to_string();
    db.set_setting(SETTINGS_KEY, &original).unwrap();
    let mut expected = original;
    for enabled in [true, false, true] {
        let next = db
            .mutate_renderer_general_settings(Some(&expected), &one(json!(enabled)))
            .unwrap();
        let reopened = Database::open(&path).unwrap();
        let raw = reopened.read_renderer_general_settings().unwrap().unwrap();
        assert_eq!(raw, next);
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["autoCheckUpdate"], enabled);
        assert_eq!(value["unknown"]["big"], json!(18446744073709551615u64));
        assert_eq!(value["unknown"]["items"], json!([1, false]));
        assert_eq!(value["theme"], "legacy-invalid-kept");
        expected = next;
    }
}

#[test]
fn auto_check_rejects_non_boolean_mixed_patch_and_stale_cas_without_writes() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"autoCheckUpdate":true,"unknown":["kept"]}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();
    for value in [Value::Null, json!("true"), json!(0), json!([]), json!({})] {
        assert!(validate_renderer_general_settings_patch(&one(value.clone())).is_err());
        assert!(db
            .mutate_renderer_general_settings(Some(initial), &one(value))
            .is_err());
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some(initial)
        );
    }
    let mixed = BTreeMap::from([
        ("autoCheckUpdate".into(), json!(false)),
        ("theme".into(), json!("dark")),
    ]);
    assert!(validate_renderer_general_settings_patch(&mixed).is_err());
    assert!(db
        .mutate_renderer_general_settings(Some(initial), &mixed)
        .is_err());
    let updated = db
        .mutate_renderer_general_settings(Some(initial), &one(json!(false)))
        .unwrap();
    assert!(db
        .mutate_renderer_general_settings(Some(initial), &one(json!(true)))
        .is_err());
    assert_eq!(db.get_setting(SETTINGS_KEY).unwrap(), Some(updated));
}

#[test]
fn auto_check_prepared_cas_rejects_intervening_write_and_keeps_shared_budget() {
    let db = Database::in_memory().unwrap();
    let initial = r#"{"autoCheckUpdate":false,"unknown":"keep"}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();
    let prepared = db
        .prepare_renderer_general_settings_write(Some(initial), &one(json!(true)))
        .unwrap();
    let newer = r#"{"autoCheckUpdate":false,"unknown":"newer"}"#;
    db.set_setting(SETTINGS_KEY, newer).unwrap();
    assert!(db.commit_general_settings_write(prepared).is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(newer)
    );
    let oversized = json!({"unknown":"x".repeat(65536)}).to_string();
    db.set_setting(SETTINGS_KEY, &oversized).unwrap();
    assert!(db
        .mutate_renderer_general_settings(Some(&oversized), &one(json!(true)))
        .is_err());
    assert_eq!(db.get_setting(SETTINGS_KEY).unwrap(), Some(oversized));
}
