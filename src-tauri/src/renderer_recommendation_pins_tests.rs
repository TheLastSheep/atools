use atools_core::{
    db::{Database, RENDERER_RECOMMENDATION_PINS_KEY},
    AToolsError,
};
use serde_json::{json, Value};
use std::sync::Arc;

use super::{
    ensure_main_context, map_save_error, parse_expected_raw, save_pins_on_worker, MAIN_WINDOW_ONLY,
    SAVE_CONFLICT, SAVE_FAILED,
};

#[test]
fn command_is_limited_to_the_main_webview_parent_and_window() {
    assert!(ensure_main_context("main", "main", "main").is_ok());
    assert_eq!(
        ensure_main_context("settings-child", "main", "main"),
        Err(MAIN_WINDOW_ONLY)
    );
    assert_eq!(
        ensure_main_context("main", "settings-child", "main"),
        Err(MAIN_WINDOW_ONLY)
    );
    assert_eq!(
        ensure_main_context("main", "main", "other-window"),
        Err(MAIN_WINDOW_ONLY)
    );
}

#[test]
fn expected_raw_accepts_only_null_or_a_string() {
    assert_eq!(parse_expected_raw(Value::Null), Ok(None));
    assert_eq!(
        parse_expected_raw(Value::String("raw snapshot".to_owned())),
        Ok(Some("raw snapshot".to_owned()))
    );
    for expected in [json!(false), json!(1), json!({"raw":"value"}), json!([])] {
        assert_eq!(parse_expected_raw(expected), Err(SAVE_FAILED));
    }
}

#[tokio::test]
async fn core_worker_returns_raw_receipt_and_preserves_other_settings() {
    let database = Arc::new(Database::in_memory().unwrap());
    database
        .set_setting("settings-general", "{\"theme\":\"dark\"}")
        .unwrap();
    let pin = json!({
        "path": "/plugins/example",
        "name": "Example",
        "type": "plugin",
        "pluginName": "example",
        "featureCode": "one",
        "futureMetadata": {"preserved": true}
    });
    let mutation = json!({"kind":"append","pin":pin.clone()});

    let receipt = save_pins_on_worker(Arc::clone(&database), Value::Null, mutation)
        .await
        .unwrap();
    let stored = database
        .get_setting(RENDERER_RECOMMENDATION_PINS_KEY)
        .unwrap()
        .unwrap();

    assert_eq!(receipt.version, 1);
    assert!(receipt.changed);
    assert_eq!(receipt.raw.as_deref(), Some(stored.as_str()));
    assert_eq!(
        serde_json::from_str::<Value>(&stored).unwrap(),
        json!([pin])
    );
    assert_eq!(
        database.get_setting("settings-general").unwrap().as_deref(),
        Some("{\"theme\":\"dark\"}")
    );
}

#[tokio::test]
async fn noop_returns_the_exact_stored_raw_without_rewriting_it() {
    let database = Arc::new(Database::in_memory().unwrap());
    let raw = r#"[ { "path" : "/plugins/example", "name" : "Example", "type" : "plugin", "future" : {"integer":9007199254740993,"decimal":1.2300} } ]"#;
    database
        .set_setting(RENDERER_RECOMMENDATION_PINS_KEY, raw)
        .unwrap();

    let receipt = save_pins_on_worker(
        Arc::clone(&database),
        Value::String(raw.to_owned()),
        json!({"kind":"noop"}),
    )
    .await
    .unwrap();

    assert_eq!(receipt.version, 1);
    assert!(!receipt.changed);
    assert_eq!(receipt.raw.as_deref(), Some(raw));
    assert_eq!(
        database
            .get_setting(RENDERER_RECOMMENDATION_PINS_KEY)
            .unwrap()
            .as_deref(),
        Some(raw)
    );
}

#[tokio::test]
async fn stale_raw_cas_and_invalid_mutations_return_fixed_errors_without_writes() {
    let database = Arc::new(Database::in_memory().unwrap());
    database
        .set_setting("settings-general", "untouched")
        .unwrap();
    let pin = json!({"path":"/plugins/example","name":"Example","type":"plugin"});
    let first = save_pins_on_worker(
        Arc::clone(&database),
        Value::Null,
        json!({"kind":"append","pin":pin.clone()}),
    )
    .await
    .unwrap();
    let current_raw = first.raw.clone().unwrap();

    let stale = save_pins_on_worker(
        Arc::clone(&database),
        Value::Null,
        json!({"kind":"append","pin":{"path":"/plugins/other","name":"Other","type":"plugin"}}),
    )
    .await;
    assert_eq!(stale, Err(SAVE_CONFLICT));

    for invalid in [
        json!({"kind":"noop","unknown":true}),
        json!({"kind":"append","pin":pin.clone(),"unknown":true}),
        json!({"kind":"remove","index":99}),
        json!({"kind":"moveToFront","index":99}),
        json!({"kind":"future"}),
    ] {
        let result = save_pins_on_worker(
            Arc::clone(&database),
            Value::String(current_raw.clone()),
            invalid,
        )
        .await;
        assert_eq!(result, Err(SAVE_FAILED));
    }

    assert_eq!(
        database
            .get_setting(RENDERER_RECOMMENDATION_PINS_KEY)
            .unwrap()
            .as_deref(),
        Some(current_raw.as_str())
    );
    assert_eq!(
        database.get_setting("settings-general").unwrap().as_deref(),
        Some("untouched")
    );
}

#[test]
fn only_the_core_compare_and_swap_conflict_maps_to_the_conflict_error() {
    assert_eq!(
        map_save_error(AToolsError::Config(
            atools_core::db::RENDERER_RECOMMENDATION_PINS_CONFLICT.to_owned()
        )),
        SAVE_CONFLICT
    );
    assert_eq!(
        map_save_error(AToolsError::Config(
            "invalid record at /private/path".to_owned()
        )),
        SAVE_FAILED
    );
}
