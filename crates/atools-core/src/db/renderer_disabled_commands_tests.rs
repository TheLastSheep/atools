use super::{
    Database, RENDERER_DISABLED_COMMANDS_CONFLICT, RENDERER_DISABLED_COMMANDS_GUARD_REJECTED,
    RENDERER_DISABLED_COMMANDS_KEY,
};
use crate::error::AToolsError;
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

fn stored(database: &Database) -> Option<String> {
    database
        .get_setting(RENDERER_DISABLED_COMMANDS_KEY)
        .unwrap()
}

fn assert_config_error(error: AToolsError, expected: &str) {
    assert!(matches!(error, AToolsError::Config(message) if message == expected));
}

#[test]
fn missing_empty_is_an_explicit_save_and_removing_ids_reenables_them() {
    let database = Database::in_memory().unwrap();
    database
        .set_setting("ztools-renderer:other-preference", "keep")
        .unwrap();
    database
        .set_setting("unrelated-setting", "also-keep")
        .unwrap();

    let empty = database
        .mutate_renderer_disabled_commands_guarded(&Value::Null, &json!([]), || true)
        .unwrap();
    assert!(empty.changed);
    assert_eq!(stored(&database).as_deref(), Some("[]"));

    let disabled = json!(["builtin:calculator", "plugin:legacy:feature"]);
    assert!(
        database
            .mutate_renderer_disabled_commands_guarded(&json!([]), &disabled, || true)
            .unwrap()
            .changed
    );
    let enabled_again = json!(["plugin:legacy:feature"]);
    assert!(
        database
            .mutate_renderer_disabled_commands_guarded(&disabled, &enabled_again, || true)
            .unwrap()
            .changed
    );
    assert_eq!(
        serde_json::from_str::<Value>(stored(&database).as_deref().unwrap()).unwrap(),
        enabled_again
    );

    assert_eq!(
        database
            .get_setting("ztools-renderer:other-preference")
            .unwrap()
            .as_deref(),
        Some("keep")
    );
    assert_eq!(
        database
            .get_setting("unrelated-setting")
            .unwrap()
            .as_deref(),
        Some("also-keep")
    );
}

#[test]
fn unknown_plugin_duplicate_and_unicode_ids_keep_exact_order_and_contents() {
    let database = Database::in_memory().unwrap();
    let ids = json!([
        "unknown:future-command",
        "plugin:old-plugin:feature:cmd",
        "legacy-id-without-a-prefix",
        "未来✨",
        "plugin:old-plugin:feature:cmd"
    ]);

    let write = database
        .mutate_renderer_disabled_commands_guarded(&Value::Null, &ids, || true)
        .unwrap();
    assert!(write.changed);
    assert_eq!(
        serde_json::from_str::<Value>(stored(&database).as_deref().unwrap()).unwrap(),
        ids
    );
}

#[test]
fn semantic_noop_preserves_raw_bytes_and_stale_cas_does_not_write() {
    let database = Database::in_memory().unwrap();
    let raw = " [ \"plugin:legacy:command\", \"\\u0061\", \"a\" ] ";
    database
        .set_setting(RENDERER_DISABLED_COMMANDS_KEY, raw)
        .unwrap();
    let expected = json!(["plugin:legacy:command", "a", "a"]);

    let noop = database
        .mutate_renderer_disabled_commands_guarded(&expected, &expected, || true)
        .unwrap();
    assert!(!noop.changed);
    assert_eq!(stored(&database).as_deref(), Some(raw));

    let error = database
        .mutate_renderer_disabled_commands_guarded(
            &json!(["stale"]),
            &json!(["replacement"]),
            || true,
        )
        .unwrap_err();
    assert_config_error(error, RENDERER_DISABLED_COMMANDS_CONFLICT);
    assert_eq!(stored(&database).as_deref(), Some(raw));
}

#[test]
fn invalid_shapes_empty_ids_and_oversized_arrays_are_rejected() {
    let database = Database::in_memory().unwrap();
    for expected in [
        json!(false),
        json!("not-an-array"),
        json!({"id":"x"}),
        json!([1]),
    ] {
        assert!(database
            .mutate_renderer_disabled_commands_guarded(&expected, &json!(["valid"]), || true)
            .is_err());
    }

    for desired in [
        Value::Null,
        json!("not-an-array"),
        json!({"id":"x"}),
        json!([1]),
        json!([null]),
        json!([[]]),
        json!([""]),
    ] {
        assert!(database
            .mutate_renderer_disabled_commands_guarded(&Value::Null, &desired, || true)
            .is_err());
    }

    let ids_at_limit = vec![Value::String("same-id".to_owned()); 4096];
    let at_limit = Value::Array(ids_at_limit);
    assert!(
        database
            .mutate_renderer_disabled_commands_guarded(&Value::Null, &at_limit, || true)
            .unwrap()
            .changed
    );
    let over_limit = Value::Array(vec![Value::String("same-id".to_owned()); 4097]);
    assert!(database
        .mutate_renderer_disabled_commands_guarded(&at_limit, &over_limit, || true)
        .is_err());
    assert_eq!(
        serde_json::from_str::<Value>(stored(&database).as_deref().unwrap()).unwrap(),
        at_limit
    );
}

#[test]
fn command_id_uses_utf8_byte_limit_and_encoded_json_accepts_exact_128_kib() {
    let database = Database::in_memory().unwrap();
    let id_at_limit = format!("{}ab", "界".repeat(5482));
    assert_eq!(id_at_limit.len(), 16_448);
    let valid_id = json!([id_at_limit]);
    assert!(
        database
            .mutate_renderer_disabled_commands_guarded(&Value::Null, &valid_id, || true)
            .unwrap()
            .changed
    );

    let too_long_id = json!([format!("{}abc", "界".repeat(5482))]);
    assert_eq!(too_long_id[0].as_str().unwrap().len(), 16_449);
    assert!(database
        .mutate_renderer_disabled_commands_guarded(&valid_id, &too_long_id, || true)
        .is_err());

    let mut at_storage_limit = vec![json!("a".repeat(16_448)); 7];
    at_storage_limit.push(json!("b".repeat(15_911)));
    let at_storage_limit = Value::Array(at_storage_limit);
    assert_eq!(
        serde_json::to_string(&at_storage_limit).unwrap().len(),
        128 * 1024
    );
    assert!(
        database
            .mutate_renderer_disabled_commands_guarded(&valid_id, &at_storage_limit, || true)
            .unwrap()
            .changed
    );

    let mut over_storage_limit = at_storage_limit.as_array().unwrap().clone();
    over_storage_limit[7] = json!("b".repeat(15_912));
    let over_storage_limit = Value::Array(over_storage_limit);
    assert_eq!(
        serde_json::to_string(&over_storage_limit).unwrap().len(),
        128 * 1024 + 1
    );
    let error = database
        .mutate_renderer_disabled_commands_guarded(&at_storage_limit, &over_storage_limit, || true)
        .unwrap_err();
    assert!(matches!(error, AToolsError::Config(_)));
    assert_eq!(
        serde_json::from_str::<Value>(stored(&database).as_deref().unwrap()).unwrap(),
        at_storage_limit
    );

    let oversized_expected = database
        .mutate_renderer_disabled_commands_guarded(&over_storage_limit, &json!([]), || true)
        .unwrap_err();
    assert!(matches!(oversized_expected, AToolsError::Config(_)));
}

#[test]
fn malformed_existing_null_scalar_and_oversized_storage_are_never_treated_as_missing() {
    for raw in ["null", "42", "{bad", "[1]", "[\"\"]"] {
        let database = Database::in_memory().unwrap();
        database
            .set_setting(RENDERER_DISABLED_COMMANDS_KEY, raw)
            .unwrap();
        assert!(database
            .mutate_renderer_disabled_commands_guarded(
                &Value::Null,
                &json!(["replacement"]),
                || true
            )
            .is_err());
        assert_eq!(stored(&database).as_deref(), Some(raw));
    }

    let database = Database::in_memory().unwrap();
    let oversized_raw = "x".repeat(128 * 1024 + 1);
    database
        .set_setting(RENDERER_DISABLED_COMMANDS_KEY, &oversized_raw)
        .unwrap();
    let error = database
        .mutate_renderer_disabled_commands_guarded(&json!(["old"]), &json!(["new"]), || true)
        .unwrap_err();
    assert!(matches!(
        error,
        AToolsError::Config(message) if message.contains("exceed 128 KiB")
    ));
    assert_eq!(stored(&database).as_deref(), Some(oversized_raw.as_str()));
}

#[test]
fn false_guard_returns_stable_error_without_mutating_the_database() {
    let database = Database::in_memory().unwrap();
    database
        .set_setting(RENDERER_DISABLED_COMMANDS_KEY, "[\"before\"]")
        .unwrap();
    let guard_calls = std::cell::Cell::new(0);
    let error = database
        .mutate_renderer_disabled_commands_guarded(&json!(["before"]), &json!(["after"]), || {
            guard_calls.set(guard_calls.get() + 1);
            false
        })
        .unwrap_err();
    assert_eq!(guard_calls.get(), 1);
    assert_config_error(error, RENDERER_DISABLED_COMMANDS_GUARD_REJECTED);
    assert_eq!(stored(&database).as_deref(), Some("[\"before\"]"));
}

#[test]
fn guard_runs_after_a_queued_file_database_write_lock_is_acquired() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join("renderer-disabled-commands-queued.sqlite");
    let database = Database::open(&path).unwrap();
    let original = "[\"before\"]";
    database
        .set_setting(RENDERER_DISABLED_COMMANDS_KEY, original)
        .unwrap();

    let mut blocker = Connection::open(&path).unwrap();
    let blocker_transaction = blocker
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let closed = Arc::new(AtomicBool::new(false));
    let guard_calls = Arc::new(AtomicUsize::new(0));
    let worker_closed = Arc::clone(&closed);
    let worker_guard_calls = Arc::clone(&guard_calls);
    let worker = std::thread::spawn(move || {
        database.mutate_renderer_disabled_commands_guarded(
            &json!(["before"]),
            &json!(["after"]),
            move || {
                worker_guard_calls.fetch_add(1, Ordering::AcqRel);
                !worker_closed.load(Ordering::Acquire)
            },
        )
    });

    std::thread::sleep(Duration::from_millis(50));
    closed.store(true, Ordering::Release);
    drop(blocker_transaction);

    let error = worker.join().unwrap().unwrap_err();
    assert_config_error(error, RENDERER_DISABLED_COMMANDS_GUARD_REJECTED);
    assert_eq!(guard_calls.load(Ordering::Acquire), 1);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(stored(&reopened).as_deref(), Some(original));
}

#[test]
fn sqlite_write_failure_rolls_back_and_preserves_other_settings() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join("renderer-disabled-commands-rollback.sqlite");
    let database = Database::open(&path).unwrap();
    let original = "[\"before\"]";
    database
        .set_setting(RENDERER_DISABLED_COMMANDS_KEY, original)
        .unwrap();
    database.set_setting("unrelated-setting", "keep").unwrap();

    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(&format!(
            "CREATE TRIGGER reject_disabled_command_update \
             BEFORE UPDATE ON settings \
             WHEN OLD.key = '{RENDERER_DISABLED_COMMANDS_KEY}' \
             BEGIN SELECT RAISE(ABORT, 'forced write failure'); END;"
        ))
        .unwrap();

    assert!(database
        .mutate_renderer_disabled_commands_guarded(&json!(["before"]), &json!(["after"]), || true,)
        .is_err());
    drop(connection);
    drop(database);

    let reopened = Database::open(&path).unwrap();
    assert_eq!(stored(&reopened).as_deref(), Some(original));
    assert_eq!(
        reopened
            .get_setting("unrelated-setting")
            .unwrap()
            .as_deref(),
        Some("keep")
    );
}
