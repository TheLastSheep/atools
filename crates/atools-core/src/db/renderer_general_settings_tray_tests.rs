use super::{Database, SETTINGS_KEY};
use crate::db::DEFAULT_SHOW_TRAY_ICON;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn patch(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn tray_default_is_visible_and_patch_accepts_only_a_boolean() {
    const { assert!(DEFAULT_SHOW_TRAY_ICON) };
    let db = Database::in_memory().unwrap();
    let initial = r#"{"theme":"system","showTrayIcon":true,"unknown":7}"#;
    db.set_setting(SETTINGS_KEY, initial).unwrap();

    for value in [Value::Null, json!("false"), json!(0), json!([]), json!({})] {
        let changes = patch(&[("showTrayIcon", value)]);
        assert!(db
            .prepare_renderer_general_settings_write(Some(initial), &changes)
            .is_err());
        assert_eq!(
            db.read_renderer_general_settings().unwrap().as_deref(),
            Some(initial)
        );
    }
}

#[test]
fn prepared_tray_patch_is_cas_bound_and_explicit_false_survives_connections_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("general-tray-visibility.sqlite");
    let first = Database::open(&path).unwrap();
    let initial = json!({
        "aiApiKey": "secret-retained-only-in-storage",
        "theme": "system",
        "unknownNativeField": {"retained": ["value", 7]}
    })
    .to_string();
    first.set_setting(SETTINGS_KEY, &initial).unwrap();
    let expected = first.read_renderer_general_settings().unwrap().unwrap();
    let disable = patch(&[("showTrayIcon", json!(false))]);
    let plan = first
        .prepare_renderer_general_settings_write(Some(&expected), &disable)
        .unwrap();
    let prepared: Value = serde_json::from_str(plan.after()).unwrap();
    assert_eq!(prepared["showTrayIcon"], false);
    assert_eq!(
        first.read_renderer_general_settings().unwrap().as_deref(),
        Some(initial.as_str()),
        "preparing the settings write must not persist it"
    );

    let second = Database::open(&path).unwrap();
    let concurrent = second
        .mutate_renderer_general_settings(Some(&expected), &patch(&[("theme", json!("dark"))]))
        .unwrap();
    assert!(first.commit_general_settings_write(plan).is_err());
    assert_eq!(
        first.read_renderer_general_settings().unwrap().as_deref(),
        Some(concurrent.as_str())
    );

    let latest = second.read_renderer_general_settings().unwrap().unwrap();
    let disabled = second
        .mutate_renderer_general_settings(Some(&latest), &disable)
        .unwrap();
    let disabled_value: Value = serde_json::from_str(&disabled).unwrap();
    assert_eq!(disabled_value["showTrayIcon"], false);
    assert_eq!(disabled_value["theme"], "dark");
    assert_eq!(
        disabled_value["aiApiKey"],
        "secret-retained-only-in-storage"
    );
    assert_eq!(
        disabled_value["unknownNativeField"]["retained"],
        json!(["value", 7])
    );
    drop(first);
    drop(second);

    let reopened = Database::open(&path).unwrap();
    let reopened_raw = reopened.read_renderer_general_settings().unwrap().unwrap();
    let reopened_value: Value = serde_json::from_str(&reopened_raw).unwrap();
    assert_eq!(reopened_value["showTrayIcon"], false);
    let enabled = reopened
        .mutate_renderer_general_settings(
            Some(&reopened_raw),
            &patch(&[("showTrayIcon", json!(true))]),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&enabled).unwrap()["showTrayIcon"],
        true
    );
}
