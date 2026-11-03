use super::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn missing_settings() -> BTreeMap<String, Option<String>> {
    COMMAND_SETTINGS_KEYS
        .iter()
        .map(|key| ((*key).to_owned(), None))
        .collect()
}

fn put_json(settings: &mut BTreeMap<String, Option<String>>, key: &str, value: &Value) {
    settings.insert(key.to_owned(), Some(serde_json::to_string(value).unwrap()));
}

fn as_value(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

#[test]
fn temporary_database_read_captures_only_the_fixed_namespaced_keys() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("renderer-command-settings.sqlite");
    let db = Database::open(&path).unwrap();
    let pinned = json!([{
        "name": "Pinned",
        "path": "/Applications/Pinned.app",
        "icon": "opaque://icon",
        "unknownField": {"kept": true}
    }]);
    let super_panel = json!([{
        "isFolder": true,
        "items": [{"path": "/Applications/Child.app", "opaque": 7}]
    }]);
    let global = json!([{"id":"g","shortcut":"Ctrl+G","target":"open","enabled":true}]);

    db.set_setting(
        "ztools-renderer:disable-commands",
        r#"["direct:app:/disabled"]"#,
    )
    .unwrap();
    db.set_setting("ztools-renderer:pinned-commands", &pinned.to_string())
        .unwrap();
    db.set_setting(
        "ztools-renderer:super-panel-pinned",
        &super_panel.to_string(),
    )
    .unwrap();
    db.set_setting("ztools-renderer:global-shortcuts", &global.to_string())
        .unwrap();
    db.set_setting("pinned-commands", r#"["legacy-unprefixed"]"#)
        .unwrap();
    db.set_setting("ztools-renderer:command-aliases", r#"{"not":"requested"}"#)
        .unwrap();

    let encoded = capture(&db).unwrap();
    let snapshot = as_value(&encoded);
    let object = snapshot.as_object().unwrap();
    assert_eq!(
        object.keys().cloned().collect::<BTreeSet<_>>(),
        [
            "disable-commands",
            "pinned-commands",
            "super-panel-pinned",
            "global-shortcuts",
            "app-shortcuts",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    assert_eq!(
        snapshot["disable-commands"],
        json!(["direct:app:/disabled"])
    );
    assert_eq!(
        snapshot["pinned-commands"][0]["unknownField"],
        json!({"kept":true})
    );
    assert_eq!(snapshot["super-panel-pinned"], super_panel);
    assert_eq!(snapshot["global-shortcuts"], global);
    assert_eq!(snapshot["app-shortcuts"], Value::Null);
    assert!(!object.contains_key("command-aliases"));
}

#[test]
fn temporary_database_confirms_missing_rows_as_null() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join("renderer-command-settings-missing.sqlite");
    let db = Database::open(&path).unwrap();

    let snapshot = as_value(&capture(&db).unwrap());
    assert_eq!(
        snapshot.as_object().unwrap().len(),
        COMMAND_SETTINGS_KEYS.len()
    );
    let object = snapshot.as_object().unwrap();
    for key in [
        "disable-commands",
        "pinned-commands",
        "super-panel-pinned",
        "global-shortcuts",
        "app-shortcuts",
    ] {
        assert!(object.contains_key(key), "missing document key {key}");
        assert_eq!(snapshot[key], Value::Null, "{key}");
    }
}

#[test]
fn temporary_database_rejects_malformed_json_and_core_byte_limit_failures() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join("renderer-command-settings-invalid.sqlite");
    let db = Database::open(&path).unwrap();
    db.set_setting("ztools-renderer:disable-commands", "[]")
        .unwrap();
    db.set_setting("ztools-renderer:global-shortcuts", "[")
        .unwrap();
    assert!(capture(&db).is_err());

    let padding = "x".repeat(MAX_COMMAND_SETTINGS_RAW_KEY_BYTES);
    let oversized = format!("[{{\"opaque\":\"{padding}\"}}]");
    db.set_setting("ztools-renderer:global-shortcuts", &oversized)
        .unwrap();
    assert!(capture(&db).is_err());
}

#[test]
fn valid_shortcut_and_pin_arrays_keep_unknown_records_and_exact_shape() {
    let mut settings = missing_settings();
    let search_pins = json!([{"path":"/p","name":"N","future":{"x":1}}]);
    let super_panel = json!([{"path":"/s","name":"S","future":false}]);
    let global = json!([{"id":"g","shortcut":"Ctrl+G","target":"open","enabled":true,"future":4}]);
    let app =
        json!([{"id":"a","shortcut":"Ctrl+A","target":"/app","enabled":false,"future":"kept"}]);
    put_json(
        &mut settings,
        "ztools-renderer:pinned-commands",
        &search_pins,
    );
    put_json(
        &mut settings,
        "ztools-renderer:super-panel-pinned",
        &super_panel,
    );
    put_json(&mut settings, "ztools-renderer:global-shortcuts", &global);
    put_json(&mut settings, "ztools-renderer:app-shortcuts", &app);

    let snapshot = as_value(&snapshot_from_values(settings).unwrap());
    assert_eq!(snapshot["pinned-commands"], search_pins);
    assert_eq!(snapshot["super-panel-pinned"], super_panel);
    assert_eq!(snapshot["global-shortcuts"], global);
    assert_eq!(snapshot["app-shortcuts"], app);
    assert_eq!(snapshot.as_object().unwrap().len(), 5);
}

#[test]
fn stored_json_null_is_invalid_but_confirmed_missing_is_null() {
    let mut settings = missing_settings();
    settings.insert(
        "ztools-renderer:disable-commands".into(),
        Some("null".into()),
    );
    assert!(snapshot_from_values(settings).is_err());

    let snapshot = as_value(&snapshot_from_values(missing_settings()).unwrap());
    assert_eq!(snapshot["disable-commands"], Value::Null);
}

#[test]
fn malformed_json_wrong_roots_and_wrong_row_types_reject_the_whole_snapshot() {
    let mut invalid_json = missing_settings();
    invalid_json.insert("ztools-renderer:global-shortcuts".into(), Some("[".into()));
    assert!(snapshot_from_values(invalid_json).is_err());

    let mut wrong_root = missing_settings();
    wrong_root.insert("ztools-renderer:app-shortcuts".into(), Some("{}".into()));
    assert!(snapshot_from_values(wrong_root).is_err());

    let mut wrong_disable_row = missing_settings();
    wrong_disable_row.insert(
        "ztools-renderer:disable-commands".into(),
        Some("[1]".into()),
    );
    assert!(snapshot_from_values(wrong_disable_row).is_err());

    for key in [
        "ztools-renderer:pinned-commands",
        "ztools-renderer:super-panel-pinned",
        "ztools-renderer:global-shortcuts",
        "ztools-renderer:app-shortcuts",
    ] {
        let mut wrong_record = missing_settings();
        wrong_record.insert(key.into(), Some("[false]".into()));
        assert!(snapshot_from_values(wrong_record).is_err(), "{key}");
    }
}

#[test]
fn disable_ids_and_raw_values_obey_byte_limits() {
    let mut empty_id = missing_settings();
    empty_id.insert(
        "ztools-renderer:disable-commands".into(),
        Some(r#"[""]"#.into()),
    );
    assert!(snapshot_from_values(empty_id).is_err());

    let too_long_id = json!(["x".repeat(MAX_COMMAND_ID_BYTES + 1)]).to_string();
    let mut oversized_id = missing_settings();
    oversized_id.insert("ztools-renderer:disable-commands".into(), Some(too_long_id));
    assert!(snapshot_from_values(oversized_id).is_err());

    let oversized_json = format!("[]{}", " ".repeat(MAX_COMMAND_SETTINGS_RAW_KEY_BYTES));
    let mut oversized_value = missing_settings();
    oversized_value.insert(
        "ztools-renderer:global-shortcuts".into(),
        Some(oversized_json),
    );
    assert!(snapshot_from_values(oversized_value).is_err());
}

#[test]
fn arrays_accept_exactly_the_row_limit_and_reject_truncation() {
    let ids = vec!["id"; MAX_COMMAND_SETTINGS_ROWS];
    let mut at_limit = missing_settings();
    at_limit.insert(
        "ztools-renderer:disable-commands".into(),
        Some(serde_json::to_string(&ids).unwrap()),
    );
    assert!(snapshot_from_values(at_limit).is_ok());

    let too_many_ids = vec!["id"; MAX_COMMAND_SETTINGS_ROWS + 1];
    let mut over_limit = missing_settings();
    over_limit.insert(
        "ztools-renderer:disable-commands".into(),
        Some(serde_json::to_string(&too_many_ids).unwrap()),
    );
    assert!(snapshot_from_values(over_limit).is_err());
}

#[test]
fn super_panel_folder_expands_for_limit_check_once_without_rewriting_snapshot() {
    let mut rows = (0..MAX_COMMAND_SETTINGS_ROWS - 1)
        .map(|index| json!({"path": format!("/app/{index}")}))
        .collect::<Vec<_>>();
    rows.push(json!({"isFolder":true,"items":[{"path":"/folder/one"}]}));
    let original = Value::Array(rows.clone());
    let mut settings = missing_settings();
    put_json(
        &mut settings,
        "ztools-renderer:super-panel-pinned",
        &original,
    );
    let snapshot = as_value(&snapshot_from_values(settings).unwrap());
    assert_eq!(snapshot["super-panel-pinned"], original);

    rows.pop();
    rows.push(json!({
        "isFolder":true,
        "items":[{"path":"/folder/one"},{"path":"/folder/two"}]
    }));
    let mut over_limit = missing_settings();
    put_json(
        &mut over_limit,
        "ztools-renderer:super-panel-pinned",
        &Value::Array(rows),
    );
    assert!(snapshot_from_values(over_limit).is_err());
}

#[test]
fn super_panel_validates_only_one_level_of_folder_items() {
    let value = json!([{
        "isFolder":true,
        "items":[{"isFolder":true,"items":[{"opaque":true}]}]
    }]);
    let mut settings = missing_settings();
    put_json(&mut settings, "ztools-renderer:super-panel-pinned", &value);
    let snapshot = as_value(&snapshot_from_values(settings.clone()).unwrap());
    assert_eq!(snapshot["super-panel-pinned"], value);

    let invalid_child = json!([{"isFolder":true,"items":["not-a-record"]}]);
    put_json(
        &mut settings,
        "ztools-renderer:super-panel-pinned",
        &invalid_child,
    );
    assert!(snapshot_from_values(settings).is_err());
}

#[test]
fn super_panel_folder_detection_matches_javascript_truthiness() {
    assert!(!javascript_truthy(&Value::Null));
    assert!(!javascript_truthy(&json!(false)));
    assert!(!javascript_truthy(&json!(0)));
    assert!(!javascript_truthy(&json!("")));
    assert!(javascript_truthy(&json!("yes")));
    assert!(javascript_truthy(&json!(1)));
    assert!(javascript_truthy(&json!([])));
    assert!(javascript_truthy(&json!({})));

    let children = vec![json!({}); MAX_COMMAND_SETTINGS_ROWS + 1];
    for marker in [json!("yes"), json!(1), json!([]), json!({})] {
        let folder = json!({"isFolder":marker,"items":children.clone()});
        let mut settings = missing_settings();
        put_json(
            &mut settings,
            "ztools-renderer:super-panel-pinned",
            &json!([folder]),
        );
        assert!(
            snapshot_from_values(settings).is_err(),
            "truthy marker {marker}"
        );
    }

    for marker in [Value::Null, json!(false), json!(0), json!("")] {
        let folder = json!({"isFolder":marker,"items":children.clone()});
        let mut settings = missing_settings();
        put_json(
            &mut settings,
            "ztools-renderer:super-panel-pinned",
            &json!([folder]),
        );
        assert!(
            snapshot_from_values(settings).is_ok(),
            "falsy marker {marker}"
        );
    }
}

#[test]
fn snapshot_rejects_any_unrequested_key_instead_of_expanding_the_namespace() {
    let mut settings = missing_settings();
    settings.insert("ztools-renderer:command-aliases".into(), Some("{}".into()));
    assert!(snapshot_from_values(settings).is_err());
}
