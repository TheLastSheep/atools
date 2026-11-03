use super::{
    renderer_general_settings_clipboard_retention_days, validate_renderer_general_settings_patch,
    Database, RENDERER_GENERAL_SETTINGS_FIELDS, SETTINGS_KEY,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn patch(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn position_and_retention_fields_append_in_order_and_validate_strictly() {
    assert_eq!(RENDERER_GENERAL_SETTINGS_FIELDS.len(), 24);
    assert_eq!(
        RENDERER_GENERAL_SETTINGS_FIELDS[17],
        "windowPositionStrategy"
    );
    assert_eq!(
        RENDERER_GENERAL_SETTINGS_FIELDS[18],
        "clipboardRetentionDays"
    );
    assert_eq!(RENDERER_GENERAL_SETTINGS_FIELDS[19], "autoBackToSearch");
    assert_eq!(RENDERER_GENERAL_SETTINGS_FIELDS[20], "autoPaste");
    assert_eq!(
        RENDERER_GENERAL_SETTINGS_FIELDS[21],
        "builtinAppShortcutsEnabled"
    );

    for strategy in ["remember", "cursor", "primary", "lastActive"] {
        assert!(validate_renderer_general_settings_patch(&patch(&[(
            "windowPositionStrategy",
            json!(strategy)
        ),]))
        .is_ok());
    }
    for value in [
        Value::Null,
        json!(false),
        json!(1),
        json!("invalid"),
        json!([]),
        json!({}),
    ] {
        assert!(validate_renderer_general_settings_patch(&patch(&[(
            "windowPositionStrategy",
            value
        ),]))
        .is_err());
    }

    for days in [1.0, 30.0, 3650.0] {
        assert!(validate_renderer_general_settings_patch(&patch(&[(
            "clipboardRetentionDays",
            json!(days)
        ),]))
        .is_ok());
    }
    assert_eq!(
        renderer_general_settings_clipboard_retention_days(&json!(30.0)),
        Some(30)
    );
    for value in [
        Value::Null,
        json!(0),
        json!(-1),
        json!(3651),
        json!(1.5),
        json!("30"),
        json!(true),
        json!([]),
        json!({}),
    ] {
        assert!(renderer_general_settings_clipboard_retention_days(&value).is_none());
        assert!(validate_renderer_general_settings_patch(&patch(&[(
            "clipboardRetentionDays",
            value
        ),]))
        .is_err());
    }
}

#[test]
fn sqlite_write_canonicalizes_integral_float_and_preserves_other_values_across_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-position-policy.sqlite");
    let db = Database::open(&path).unwrap();
    let initial = json!({
        "windowPositionStrategy": "remember",
        "clipboardRetentionDays": 7,
        "apiCredential": "secret-retained-in-storage",
        "unknown": {"nested": ["kept", 9, true]}
    })
    .to_string();
    db.set_setting(SETTINGS_KEY, &initial).unwrap();
    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    let changes = patch(&[
        ("windowPositionStrategy", json!("lastActive")),
        ("clipboardRetentionDays", json!(30.0)),
    ]);

    let plan = db
        .prepare_renderer_general_settings_write(Some(&expected), &changes)
        .unwrap();
    let prepared: Value = serde_json::from_str(plan.after()).unwrap();
    assert_eq!(prepared["windowPositionStrategy"], "lastActive");
    assert_eq!(prepared["clipboardRetentionDays"].as_u64(), Some(30));
    assert_eq!(prepared["apiCredential"], "secret-retained-in-storage");
    assert_eq!(prepared["unknown"]["nested"], json!(["kept", 9, true]));
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(initial.as_str()),
        "preparing must not persist changes"
    );

    let committed = db.commit_general_settings_write(plan).unwrap();
    drop(db);
    let reopened = Database::open(&path).unwrap();
    let stored = reopened.read_renderer_general_settings().unwrap().unwrap();
    assert_eq!(stored, committed);
    let value: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(value["windowPositionStrategy"], "lastActive");
    assert_eq!(value["clipboardRetentionDays"].as_u64(), Some(30));
    assert_eq!(value["apiCredential"], "secret-retained-in-storage");
    assert_eq!(value["unknown"]["nested"], json!(["kept", 9, true]));
}

#[test]
fn two_connection_change_conflicts_and_invalid_values_leave_sqlite_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-position-cas.sqlite");
    let first = Database::open(&path).unwrap();
    let initial = r#"{"theme":"system","unknown":true}"#;
    first.set_setting(SETTINGS_KEY, initial).unwrap();
    let expected = first.read_renderer_general_settings().unwrap().unwrap();
    let position_patch = patch(&[
        ("windowPositionStrategy", json!("primary")),
        ("clipboardRetentionDays", json!(3650)),
    ]);
    let plan = first
        .prepare_renderer_general_settings_write(Some(&expected), &position_patch)
        .unwrap();

    let second = Database::open(&path).unwrap();
    let concurrent = second
        .mutate_renderer_general_settings(Some(&expected), &patch(&[("theme", json!("dark"))]))
        .unwrap();
    assert!(first.commit_general_settings_write(plan).is_err());
    assert_eq!(
        first.read_renderer_general_settings().unwrap().as_deref(),
        Some(concurrent.as_str())
    );

    for invalid in [
        patch(&[("windowPositionStrategy", json!("last-active"))]),
        patch(&[("clipboardRetentionDays", json!(30.5))]),
        patch(&[("clipboardRetentionDays", json!(0))]),
        patch(&[("clipboardRetentionDays", json!(3651))]),
        patch(&[("clipboardRetentionDays", Value::Null)]),
        patch(&[("unknownPositionOption", json!("cursor"))]),
    ] {
        assert!(second
            .mutate_renderer_general_settings(Some(&concurrent), &invalid)
            .is_err());
        assert_eq!(
            second.read_renderer_general_settings().unwrap().as_deref(),
            Some(concurrent.as_str())
        );
    }
}
