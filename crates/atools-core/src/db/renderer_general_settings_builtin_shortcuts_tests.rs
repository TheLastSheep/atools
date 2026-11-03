use super::*;
use serde_json::json;

fn patch(value: Value) -> BTreeMap<String, Value> {
    BTreeMap::from([("builtinAppShortcutsEnabled".to_owned(), value)])
}

#[test]
fn accepts_only_nonempty_typed_search_and_escape_patches() {
    for value in [
        json!({"search":false}),
        json!({"esc":true}),
        json!({"search":true,"esc":false}),
        json!({"closePlugin":false}),
        json!({"closePlugin":false,"search":true,"esc":false}),
    ] {
        assert!(validate_renderer_general_settings_patch(&patch(value)).is_ok());
    }
    for value in [
        json!({}),
        json!(null),
        json!(false),
        json!([]),
        json!({"search":"false"}),
        json!({"esc":null}),
        json!({"closePlugin":null}),
        json!({"killPlugin":false}),
        json!({"search":true,"unknown":"secret"}),
    ] {
        assert!(validate_renderer_general_settings_patch(&patch(value)).is_err());
    }
}

#[test]
fn nested_patch_keeps_unrelated_values_and_raw_numeric_tokens() {
    let db = Database::in_memory().unwrap();
    let original = r#"{"theme":"dark","secret":"private","opaque":{"large":90071992547409931234567},"builtinAppShortcutsEnabled":{"search":true,"esc":"invalid-existing","closePlugin":false,"killPlugin":false,"unknown":{"number":1.000000000000000111}}}"#;
    db.set_setting(SETTINGS_KEY, original).unwrap();
    let result = db
        .mutate_renderer_general_settings(Some(original), &patch(json!({"search":false})))
        .unwrap();
    assert!(result.contains("90071992547409931234567"));
    assert!(result.contains("1.000000000000000111"));
    let value: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(value["theme"], "dark");
    assert_eq!(value["secret"], "private");
    assert_eq!(value["builtinAppShortcutsEnabled"]["search"], false);
    assert_eq!(
        value["builtinAppShortcutsEnabled"]["esc"],
        "invalid-existing"
    );
    assert_eq!(value["builtinAppShortcutsEnabled"]["closePlugin"], false);
    assert_eq!(value["builtinAppShortcutsEnabled"]["killPlugin"], false);
    assert!(value["builtinAppShortcutsEnabled"]["unknown"].is_object());
}

#[test]
fn missing_object_is_created_but_nonobject_or_duplicate_existing_data_is_never_overwritten() {
    let db = Database::in_memory().unwrap();
    let created = db
        .mutate_renderer_general_settings(None, &patch(json!({"esc":false})))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&created).unwrap()["builtinAppShortcutsEnabled"],
        json!({"esc":false})
    );
    for original in [
        r#"{"builtinAppShortcutsEnabled":null,"secret":"keep"}"#,
        r#"{"builtinAppShortcutsEnabled":"invalid","secret":"keep"}"#,
        r#"{"builtinAppShortcutsEnabled":{"search":true,"search":false},"secret":"keep"}"#,
        r#"{"builtinAppShortcutsEnabled":{},"secret":"first","secret":"second"}"#,
    ] {
        db.set_setting(SETTINGS_KEY, original).unwrap();
        assert!(db
            .mutate_renderer_general_settings(Some(original), &patch(json!({"esc":false})))
            .is_err());
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some(original)
        );
    }
}

#[test]
fn stale_prepare_or_commit_conflicts_without_overwriting_the_new_snapshot() {
    let db = Database::in_memory().unwrap();
    let original = r#"{"builtinAppShortcutsEnabled":{"search":true,"esc":true},"secret":"first"}"#;
    db.set_setting(SETTINGS_KEY, original).unwrap();
    let plan = db
        .prepare_renderer_general_settings_write(Some(original), &patch(json!({"search":false})))
        .unwrap();
    let newer = r#"{"builtinAppShortcutsEnabled":{"search":true,"esc":false},"secret":"newer"}"#;
    db.set_setting(SETTINGS_KEY, newer).unwrap();
    assert!(db.commit_general_settings_write(plan).is_err());
    assert!(db
        .mutate_renderer_general_settings(Some(original), &patch(json!({"search":false})))
        .is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(newer)
    );
}

#[test]
fn r74_close_shortcut_patch_is_a_strict_nested_boolean() {
    assert!(validate_renderer_general_settings_patch(&patch(json!({"closePlugin":false}))).is_ok());
    for value in [json!({"closePlugin":"false"}),json!({"closePlugin":null}),json!({"closePlugin":true,"killPlugin":true})] {
        assert!(validate_renderer_general_settings_patch(&patch(value)).is_err());
    }
}

#[test]
fn r74_close_mutation_preserves_raw_fields_and_stale_cas_never_overwrites() {
    let raw = r#"{"opaque":90071992547409931234567,"builtinAppShortcutsEnabled":{"search":false,"esc":true,"closePlugin":true,"killPlugin":false,"unknown":1.000000000000000111}}"#;
    let cases = [
        (json!({"closePlugin":false}), false, true),
        (json!({"search":true,"esc":false,"closePlugin":false}), true, false),
    ];

    for (patch_value, expected_search, expected_esc) in cases {
        let db = Database::in_memory().unwrap();
        db.set_setting(SETTINGS_KEY, raw).unwrap();
        let supported_patch = patch(patch_value);
        let plan = db
            .prepare_renderer_general_settings_write(Some(raw), &supported_patch)
            .unwrap();
        let saved = db
            .mutate_renderer_general_settings(Some(raw), &supported_patch)
            .unwrap();

        assert!(saved.contains("90071992547409931234567"));
        assert!(saved.contains("1.000000000000000111"));
        let value: Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(value["builtinAppShortcutsEnabled"]["closePlugin"], false);
        assert_eq!(
            value["builtinAppShortcutsEnabled"]["search"],
            expected_search
        );
        assert_eq!(value["builtinAppShortcutsEnabled"]["esc"], expected_esc);
        assert_eq!(value["builtinAppShortcutsEnabled"]["killPlugin"], false);
        assert!(value["builtinAppShortcutsEnabled"]["unknown"].is_number());
        assert!(db.commit_general_settings_write(plan).is_err());
        assert!(db
            .mutate_renderer_general_settings(Some(raw), &patch(json!({"closePlugin":true})))
            .is_err());
        assert_eq!(
            db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
            Some(saved.as_str())
        );
    }
}
