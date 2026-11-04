use super::{
    validate_renderer_recommendation_pin, Database, RendererRecommendationPinsMutation,
    RENDERER_RECOMMENDATION_PINS_CONFLICT, RENDERER_RECOMMENDATION_PINS_GUARD_REJECTED,
    RENDERER_RECOMMENDATION_PINS_KEY,
};
use crate::error::AToolsError;
use serde_json::{json, Value};
use tempfile::TempDir;

fn record(path: &str, name: &str, kind: &str) -> Value {
    json!({ "path": path, "name": name, "type": kind })
}

fn stored(database: &Database) -> Option<String> {
    database
        .get_setting(RENDERER_RECOMMENDATION_PINS_KEY)
        .unwrap()
}

fn assert_config_error(error: AToolsError, expected: &str) {
    assert!(matches!(error, AToolsError::Config(message) if message == expected));
}

fn assert_fragment_order(raw: &str, fragments: &[&str]) {
    let mut offset = 0;
    for fragment in fragments {
        let relative = raw[offset..]
            .find(fragment)
            .unwrap_or_else(|| panic!("missing or out-of-order fragment: {fragment}"));
        offset += relative + fragment.len();
    }
}

#[test]
fn append_move_remove_preserve_raw_rows_and_reopen() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("lossless-pins.sqlite");
    let database = Database::open(&path).unwrap();
    database
        .set_setting("ztools-renderer:command-history", "history")
        .unwrap();
    database
        .set_setting("ztools-renderer:pinned-commands", "app pins")
        .unwrap();
    database
        .set_setting("ztools-renderer:plugin-data", "plugin data")
        .unwrap();

    let long_key = "x".repeat(257);
    let original_row = format!(
        "{}{}{}",
        r#"{"path":"/missing/plugin","name":"open","type":"plugin","pluginName":"Legacy","featureCode":"open-feature","#,
        serde_json::to_string(&long_key).unwrap(),
        r#":{ "integer":9007199254740993,"decimal":0.12345678901234567890123456789}}"#
    );
    assert_eq!(long_key.len(), 257);
    let future_row = r#"{"path":"/not-installed","name":"future","type":"future-type","metadata":{"big":9007199254740993,"fraction":0.12345678901234567890123456789}}"#;
    let initial_raw = format!("[ {original_row} , {original_row} , {future_row} ]");
    serde_json::from_str::<Value>(&initial_raw)
        .expect("recommendation pin fixture must be valid JSON");
    database
        .set_setting(RENDERER_RECOMMENDATION_PINS_KEY, &initial_raw)
        .unwrap();

    let new_pin = record("/new/plugin", "new-feature", "builtin");
    let new_pin_raw = serde_json::to_string(&new_pin).unwrap();
    let appended = database
        .mutate_renderer_recommendation_pins_guarded(
            Some(&initial_raw),
            RendererRecommendationPinsMutation::Append { pin: new_pin },
            || true,
        )
        .unwrap();
    assert!(appended.changed);
    let appended_raw = appended.raw.unwrap();
    assert_eq!(stored(&database).as_deref(), Some(appended_raw.as_str()));
    assert_eq!(appended_raw.matches(&original_row).count(), 2);
    assert!(appended_raw.contains("9007199254740993"));
    assert!(appended_raw.contains("0.12345678901234567890123456789"));
    assert_fragment_order(
        &appended_raw,
        &[&original_row, &original_row, future_row, &new_pin_raw],
    );

    let moved = database
        .mutate_renderer_recommendation_pins_guarded(
            Some(&appended_raw),
            RendererRecommendationPinsMutation::MoveToFront { index: 2 },
            || true,
        )
        .unwrap();
    assert!(moved.changed);
    let moved_raw = moved.raw.unwrap();
    assert_fragment_order(
        &moved_raw,
        &[future_row, &original_row, &original_row, &new_pin_raw],
    );

    let removed = database
        .mutate_renderer_recommendation_pins_guarded(
            Some(&moved_raw),
            RendererRecommendationPinsMutation::Remove { index: 2 },
            || true,
        )
        .unwrap();
    assert!(removed.changed);
    let removed_raw = removed.raw.unwrap();
    assert_eq!(removed_raw.matches(&original_row).count(), 1);
    assert_fragment_order(&removed_raw, &[future_row, &original_row, &new_pin_raw]);
    assert!(removed_raw.contains("9007199254740993"));
    assert!(removed_raw.contains("0.12345678901234567890123456789"));

    drop(database);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(stored(&reopened).as_deref(), Some(removed_raw.as_str()));
    for (key, expected) in [
        ("ztools-renderer:command-history", "history"),
        ("ztools-renderer:pinned-commands", "app pins"),
        ("ztools-renderer:plugin-data", "plugin data"),
    ] {
        assert_eq!(
            reopened.get_setting(key).unwrap().as_deref(),
            Some(expected)
        );
    }
}

#[test]
fn exact_raw_cas_detects_whitespace_and_stale_cross_connection_writes() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("cas.sqlite");
    let first_connection = Database::open(&path).unwrap();
    let second_connection = Database::open(&path).unwrap();
    let first = r#"{ "path" : "/one", "name" : "One", "type" : "plugin" }"#;
    let second = r#"{ "path" : "/two", "name" : "Two", "type" : "plugin" }"#;
    let initial_raw = format!("[ {first} , {second} ]");
    first_connection
        .set_setting(RENDERER_RECOMMENDATION_PINS_KEY, &initial_raw)
        .unwrap();

    let semantically_equivalent = format!("[{first},{second}]");
    let error = first_connection
        .mutate_renderer_recommendation_pins_guarded(
            Some(&semantically_equivalent),
            RendererRecommendationPinsMutation::Noop,
            || true,
        )
        .unwrap_err();
    assert_config_error(error, RENDERER_RECOMMENDATION_PINS_CONFLICT);
    assert_eq!(
        stored(&first_connection).as_deref(),
        Some(initial_raw.as_str())
    );

    let winner = first_connection
        .mutate_renderer_recommendation_pins_guarded(
            Some(&initial_raw),
            RendererRecommendationPinsMutation::MoveToFront { index: 1 },
            || true,
        )
        .unwrap();
    assert!(winner.changed);
    let winner_raw = winner.raw.unwrap();

    let error = second_connection
        .mutate_renderer_recommendation_pins_guarded(
            Some(&initial_raw),
            RendererRecommendationPinsMutation::Append {
                pin: record("/stale", "stale", "plugin"),
            },
            || true,
        )
        .unwrap_err();
    assert_config_error(error, RENDERER_RECOMMENDATION_PINS_CONFLICT);
    assert_eq!(
        stored(&second_connection).as_deref(),
        Some(winner_raw.as_str())
    );

    drop(first_connection);
    drop(second_connection);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(stored(&reopened).as_deref(), Some(winner_raw.as_str()));
}

#[test]
fn noop_absent_and_move_first_preserve_the_exact_raw_value() {
    let database = Database::in_memory().unwrap();
    let absent = database
        .mutate_renderer_recommendation_pins_guarded(
            None,
            RendererRecommendationPinsMutation::Noop,
            || true,
        )
        .unwrap();
    assert!(!absent.changed);
    assert_eq!(absent.raw, None);
    assert_eq!(stored(&database), None);

    let raw = concat!(
        " ",
        r#"[ { "path" : "/one", "name" : "One", "type" : "plugin", "future" : "\u0061" } ]"#,
        " \t"
    );
    database
        .set_setting(RENDERER_RECOMMENDATION_PINS_KEY, raw)
        .unwrap();

    for mutation in [
        RendererRecommendationPinsMutation::Noop,
        RendererRecommendationPinsMutation::MoveToFront { index: 0 },
    ] {
        let result = database
            .mutate_renderer_recommendation_pins_guarded(Some(raw), mutation, || true)
            .unwrap();
        assert!(!result.changed);
        assert_eq!(result.raw.as_deref(), Some(raw));
        assert_eq!(stored(&database).as_deref(), Some(raw));
    }
}

#[test]
fn mutation_wire_format_is_tagged_and_rejects_unknown_fields() {
    let pin = record("/plugin", "feature", "plugin");
    let append =
        serde_json::to_value(RendererRecommendationPinsMutation::Append { pin: pin.clone() })
            .unwrap();
    assert_eq!(append["kind"], "append");
    assert_eq!(
        serde_json::from_value::<RendererRecommendationPinsMutation>(append).unwrap(),
        RendererRecommendationPinsMutation::Append { pin }
    );
    assert_eq!(
        serde_json::to_value(RendererRecommendationPinsMutation::MoveToFront { index: 3 }).unwrap(),
        json!({ "kind": "moveToFront", "index": 3 })
    );
    assert_eq!(
        serde_json::to_value(RendererRecommendationPinsMutation::Noop).unwrap(),
        json!({ "kind": "noop" })
    );

    for invalid in [
        json!({ "kind": "noop", "extra": true }),
        json!({ "kind": "append", "pin": record("/p", "n", "plugin"), "extra": true }),
        json!({ "kind": "unknown" }),
        json!({ "kind": "append" }),
    ] {
        assert!(serde_json::from_value::<RendererRecommendationPinsMutation>(invalid).is_err());
    }
}

#[test]
fn guard_bad_storage_invalid_pin_and_bad_indices_do_not_write() {
    let database = Database::in_memory().unwrap();
    let first = r#"{"path":"/one","name":"One","type":"plugin"}"#;
    let raw = format!("[{first}]");
    database
        .set_setting(RENDERER_RECOMMENDATION_PINS_KEY, &raw)
        .unwrap();

    let error = database
        .mutate_renderer_recommendation_pins_guarded(
            Some(&raw),
            RendererRecommendationPinsMutation::Noop,
            || false,
        )
        .unwrap_err();
    assert_config_error(error, RENDERER_RECOMMENDATION_PINS_GUARD_REJECTED);
    assert_eq!(stored(&database).as_deref(), Some(raw.as_str()));

    for mutation in [
        RendererRecommendationPinsMutation::Append { pin: Value::Null },
        RendererRecommendationPinsMutation::Append { pin: json!({}) },
        RendererRecommendationPinsMutation::Append {
            pin: json!({ "path": "/p", "name": "n", "type": "plugin", "pluginName": null }),
        },
        RendererRecommendationPinsMutation::Remove { index: 1 },
        RendererRecommendationPinsMutation::MoveToFront { index: 1 },
    ] {
        assert!(database
            .mutate_renderer_recommendation_pins_guarded(Some(&raw), mutation, || true)
            .is_err());
        assert_eq!(stored(&database).as_deref(), Some(raw.as_str()));
    }

    let malformed = Database::in_memory().unwrap();
    malformed
        .set_setting(RENDERER_RECOMMENDATION_PINS_KEY, "null")
        .unwrap();
    assert!(malformed
        .mutate_renderer_recommendation_pins_guarded(
            Some("null"),
            RendererRecommendationPinsMutation::Noop,
            || true,
        )
        .is_err());
    assert_eq!(stored(&malformed).as_deref(), Some("null"));

    malformed
        .set_setting(RENDERER_RECOMMENDATION_PINS_KEY, "[{}]")
        .unwrap();
    assert!(malformed
        .mutate_renderer_recommendation_pins_guarded(
            Some("[{}]"),
            RendererRecommendationPinsMutation::Noop,
            || true,
        )
        .is_err());
    assert_eq!(stored(&malformed).as_deref(), Some("[{}]"));
}

#[test]
fn standalone_validator_accepts_future_types_and_enforces_row_shape() {
    let mut future_pin = record("/future", "command", "future-type");
    future_pin["featureCode"] = json!("future-feature");
    future_pin["extension"] = json!({ "kept": [true, 1] });
    assert!(validate_renderer_recommendation_pin(&future_pin).is_ok());

    for invalid in [
        json!([]),
        json!({ "name": "command", "type": "plugin" }),
        json!({ "path": "/x", "name": "command", "type": "plugin", "pluginName": null }),
    ] {
        assert!(validate_renderer_recommendation_pin(&invalid).is_err());
    }
}

#[test]
fn append_enforces_aggregate_depth_and_node_budgets_without_write() {
    let database = Database::in_memory().unwrap();

    let mut depth_limit = record("/depth", "Depth", "future");
    let mut nested = json!(true);
    for _ in 0..5 {
        nested = json!([nested]);
    }
    depth_limit["extension"] = nested;
    let result = database
        .mutate_renderer_recommendation_pins_guarded(
            None,
            RendererRecommendationPinsMutation::Append { pin: depth_limit },
            || true,
        )
        .unwrap();
    assert!(result.changed);
    let current_raw = result.raw.unwrap();

    let mut over_depth = record("/depth", "Too deep", "future");
    let mut nested = json!(true);
    for _ in 0..6 {
        nested = json!([nested]);
    }
    over_depth["extension"] = nested;
    assert!(database
        .mutate_renderer_recommendation_pins_guarded(
            Some(&current_raw),
            RendererRecommendationPinsMutation::Append { pin: over_depth },
            || true,
        )
        .is_err());
    assert_eq!(stored(&database).as_deref(), Some(current_raw.as_str()));

    let nodes = Database::in_memory().unwrap();
    let mut at_node_limit = record("/nodes", "Nodes", "future");
    at_node_limit["extension"] = Value::Array(vec![Value::Bool(true); 8192 - 6]);
    let result = nodes
        .mutate_renderer_recommendation_pins_guarded(
            None,
            RendererRecommendationPinsMutation::Append { pin: at_node_limit },
            || true,
        )
        .unwrap();
    let current_raw = result.raw.unwrap();
    assert!(nodes
        .mutate_renderer_recommendation_pins_guarded(
            Some(&current_raw),
            RendererRecommendationPinsMutation::Append {
                pin: record("/extra", "Extra", "plugin"),
            },
            || true,
        )
        .is_err());
    assert_eq!(stored(&nodes).as_deref(), Some(current_raw.as_str()));
}

#[test]
fn utf8_and_escaped_values_hit_exact_array_byte_limit() {
    let database = Database::in_memory().unwrap();
    let mut pin = record("/bytes", "Bytes", "future");
    pin["unicodeMetadata"] = json!("状态🌱");
    pin["escapedMetadata"] = json!("line\nquote:\"slash:\\");
    pin["padding"] = json!("");

    let base = serde_json::to_string(&pin).unwrap().len();
    pin["padding"] = json!("x".repeat(128 * 1024 - 2 - base));
    let encoded_pin = serde_json::to_string(&pin).unwrap();
    assert_eq!(encoded_pin.len(), 128 * 1024 - 2);

    let exact = database
        .mutate_renderer_recommendation_pins_guarded(
            None,
            RendererRecommendationPinsMutation::Append { pin: pin.clone() },
            || true,
        )
        .unwrap();
    assert!(exact.changed);
    let exact_raw = exact.raw.unwrap();
    assert_eq!(exact_raw.len(), 128 * 1024);

    let mut over = pin;
    let padding = over["padding"].as_str().unwrap();
    over["padding"] = json!(format!("{padding}x"));
    assert!(database
        .mutate_renderer_recommendation_pins_guarded(
            Some(&exact_raw),
            RendererRecommendationPinsMutation::Append { pin: over },
            || true,
        )
        .is_err());
    assert_eq!(stored(&database).as_deref(), Some(exact_raw.as_str()));
}

#[test]
fn oversized_unknown_metadata_is_counted_before_write_and_leaves_storage_unchanged() {
    let database = Database::in_memory().unwrap();
    let initial = database
        .mutate_renderer_recommendation_pins_guarded(
            None,
            RendererRecommendationPinsMutation::Append {
                pin: record("/stable", "Stable", "plugin"),
            },
            || true,
        )
        .unwrap()
        .raw
        .unwrap();
    let mut oversized = record("/plugin", "command", "future");
    oversized["futureMetadata"] = json!({ "payload": "x".repeat(2 * 1024 * 1024) });

    assert!(database
        .mutate_renderer_recommendation_pins_guarded(
            Some(&initial),
            RendererRecommendationPinsMutation::Append { pin: oversized },
            || true,
        )
        .is_err());
    assert_eq!(stored(&database).as_deref(), Some(initial.as_str()));
}
