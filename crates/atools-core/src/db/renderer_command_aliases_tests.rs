use super::{normalize_renderer_command_aliases, Database};
use serde_json::{json, Value};
use std::sync::{Arc, Barrier};

const SETTINGS_KEY: &str = "ztools-renderer:command-aliases";

#[test]
fn normalization_matches_javascript_trim_dedup_order_and_icon_rules() {
    let raw = r#"{
      "direct:app:/Applications/Design.app": [
        {"alias":" \uFEFFAlpha\u3000", "icon":"first"},
        {"alias":"Alpha", "icon":" final "},
        {"alias":"alpha", "icon":"case-icon"},
        {"alias":"alpha", "icon":""},
        {"alias":"\uFEFF \uFEFF", "icon":"ignored"},
        {"alias":"Beta"}
      ]
    }"#;

    assert_eq!(
        normalize_renderer_command_aliases(Some(raw)).unwrap(),
        json!({
            "direct:app:/Applications/Design.app": [
                {"alias":"Alpha", "icon":" final "},
                {"alias":"alpha"},
                {"alias":"Beta"}
            ]
        })
    );
    assert_eq!(
        normalize_renderer_command_aliases(None).unwrap(),
        Value::Null
    );
}

#[test]
fn semantic_noop_preserves_exact_raw_legacy_format() {
    let db = Database::in_memory().unwrap();
    let raw = " { \"legacy-id\" : [ \" old \", \"two\" ] } ";
    db.set_setting(SETTINGS_KEY, raw).unwrap();

    let snapshot = db.read_renderer_command_aliases().unwrap();
    let write = db
        .mutate_renderer_command_aliases(Some(raw), &snapshot.value)
        .unwrap();

    assert!(!write.changed);
    assert_eq!(write.raw.as_deref(), Some(raw));
    assert_eq!(db.get_setting(SETTINGS_KEY).unwrap().as_deref(), Some(raw));
}

#[test]
fn changed_bucket_preserves_unrelated_legacy_and_opaque_data() {
    let db = Database::in_memory().unwrap();
    let raw = r#"{
      "legacy-id": [" old ", "two"],
      "plugin:feature:name:cmd": [
        {"alias":"keep", "icon":"old-icon", "extension":{"retained":true}},
        {"future-record":{"version":2}},
        {"alias":"remove", "privateField":"retained-with-alias"}
      ],
      "opaque-bucket":{"schema":9,"data":[1,2]},
      "unrelated-plugin-id":["leave", "as", "legacy"]
    }"#;
    db.set_setting(SETTINGS_KEY, raw).unwrap();
    let expected = db.read_renderer_command_aliases().unwrap().raw.unwrap();
    let desired = json!({
        "legacy-id": [{"alias":"old"}, {"alias":"two"}],
        "plugin:feature:name:cmd": [
            {"alias":"keep", "icon":"new-icon"},
            {"alias":"added"}
        ],
        "unrelated-plugin-id": [
            {"alias":"leave"}, {"alias":"as"}, {"alias":"legacy"}
        ]
    });

    let result = db
        .mutate_renderer_command_aliases(Some(&expected), &desired)
        .unwrap();
    assert!(result.changed);
    let stored: Value = serde_json::from_str(result.raw.as_deref().unwrap()).unwrap();
    assert_eq!(stored["legacy-id"], json!([" old ", "two"]));
    assert_eq!(
        stored["unrelated-plugin-id"],
        json!(["leave", "as", "legacy"])
    );
    assert_eq!(stored["opaque-bucket"], json!({"schema":9,"data":[1,2]}));
    let plugin_records = stored["plugin:feature:name:cmd"].as_array().unwrap();
    assert_eq!(plugin_records[0]["alias"], "keep");
    assert_eq!(plugin_records[0]["icon"], "new-icon");
    assert_eq!(plugin_records[0]["extension"], json!({"retained":true}));
    assert_eq!(plugin_records[1], json!({"alias":"added"}));
    assert_eq!(plugin_records[2], json!({"future-record":{"version":2}}));
    assert_eq!(result.value, desired);
}

#[test]
fn removing_last_alias_deletes_bucket_and_missing_empty_write_stays_missing() {
    let db = Database::in_memory().unwrap();
    let absent = db.read_renderer_command_aliases().unwrap();
    assert_eq!(absent.value, Value::Null);
    let empty_noop = db
        .mutate_renderer_command_aliases(None, &json!({}))
        .unwrap();
    assert!(!empty_noop.changed);
    assert_eq!(empty_noop.raw, None);
    assert_eq!(db.get_setting(SETTINGS_KEY).unwrap(), None);

    db.set_setting(SETTINGS_KEY, r#"{"id":[{"alias":"one"}]}"#)
        .unwrap();
    let expected = db.read_renderer_command_aliases().unwrap().raw.unwrap();
    let removed = db
        .mutate_renderer_command_aliases(Some(&expected), &json!({}))
        .unwrap();
    assert!(removed.changed);
    assert_eq!(removed.raw, None);
    assert_eq!(removed.value, Value::Null);
    assert_eq!(db.get_setting(SETTINGS_KEY).unwrap(), None);
}

#[test]
fn explicit_alias_deletion_keeps_opaque_bucket_records() {
    let db = Database::in_memory().unwrap();
    let raw = r#"{"id":[{"alias":"remove","unknown":3},{"opaque":true}]}"#;
    db.set_setting(SETTINGS_KEY, raw).unwrap();
    let expected = db.read_renderer_command_aliases().unwrap().raw.unwrap();

    let removed = db
        .mutate_renderer_command_aliases(Some(&expected), &json!({}))
        .unwrap();
    let stored: Value = serde_json::from_str(removed.raw.as_deref().unwrap()).unwrap();
    assert_eq!(stored, json!({"id":[{"opaque":true}]}));
    assert_eq!(removed.value, json!({}));
}

#[test]
fn stale_cas_and_invalid_or_oversized_candidates_do_not_write() {
    let db = Database::in_memory().unwrap();
    let raw = r#"{"id":[{"alias":"keep"}],"unknown":{"stay":true}}"#;
    db.set_setting(SETTINGS_KEY, raw).unwrap();

    assert!(db
        .mutate_renderer_command_aliases(Some("{}"), &json!({"id":[{"alias":"new"}]}))
        .is_err());
    assert!(db
        .mutate_renderer_command_aliases(Some(raw), &Value::Null)
        .is_err());
    assert!(db
        .mutate_renderer_command_aliases(Some(raw), &json!({"id":[{"alias":"x".repeat(513)}]}))
        .is_err());
    assert!(db
        .mutate_renderer_command_aliases(
            Some(raw),
            &json!({"id":[{"alias":"x".repeat(512),"icon":"i".repeat(65_537)}]})
        )
        .is_err());
    assert_eq!(db.get_setting(SETTINGS_KEY).unwrap().as_deref(), Some(raw));
}

#[test]
fn guarded_mutation_rejects_closed_session_after_queued_immediate_and_reopen_is_unchanged() {
    use rusqlite::{Connection, TransactionBehavior};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join("renderer-aliases-queued-close.sqlite");
    let database = Database::open(&path).unwrap();
    let original = r#"{"id":[{"alias":"before"}]}"#;
    database.set_setting(SETTINGS_KEY, original).unwrap();
    let expected = database
        .read_renderer_command_aliases()
        .unwrap()
        .raw
        .unwrap();

    let mut blocker = Connection::open(&path).unwrap();
    let blocker_transaction = blocker
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let closed = Arc::new(AtomicBool::new(false));
    let worker_closed = Arc::clone(&closed);
    let worker = std::thread::spawn(move || {
        database.mutate_renderer_command_aliases_guarded(
            Some(&expected),
            &json!({"id":[{"alias":"after-close"}]}),
            move || !worker_closed.load(Ordering::Acquire),
        )
    });

    // Let the second connection reach BEGIN IMMEDIATE while the blocker owns the writer slot.
    std::thread::sleep(Duration::from_millis(40));
    closed.store(true, Ordering::Release);
    drop(blocker_transaction);

    let error = worker.join().unwrap().unwrap_err();
    assert!(matches!(
        error,
        crate::error::AToolsError::Config(message)
            if message == "Renderer command alias session closed before transaction start"
    ));
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(original)
    );
}

#[test]
fn guarded_mutation_true_preserves_exact_cas_and_changes_the_value() {
    let database = Database::in_memory().unwrap();
    let original = r#"{"id":[{"alias":"before"}]}"#;
    database.set_setting(SETTINGS_KEY, original).unwrap();
    let result = database
        .mutate_renderer_command_aliases_guarded(
            Some(original),
            &json!({"id":[{"alias":"after"}]}),
            || true,
        )
        .unwrap();
    assert!(result.changed);
    assert_eq!(result.value, json!({"id":[{"alias":"after"}]}));

    let stale = database.mutate_renderer_command_aliases_guarded(
        Some(original),
        &json!({"id":[{"alias":"stale"}]}),
        || true,
    );
    assert!(matches!(
        stale,
        Err(crate::error::AToolsError::Config(message))
            if message == "Renderer command aliases changed since the supplied snapshot"
    ));
}

#[test]
fn stored_size_and_projection_limits_are_checked_before_mutation() {
    let db = Database::in_memory().unwrap();
    let oversized_raw = format!("{{\"id\":[\"{}\"]}}", "x".repeat(128 * 1024));
    db.set_setting(SETTINGS_KEY, &oversized_raw).unwrap();
    assert!(db.read_renderer_command_aliases().is_err());
    assert!(db
        .mutate_renderer_command_aliases(Some(&oversized_raw), &json!({}))
        .is_err());
    assert_eq!(
        db.get_setting(SETTINGS_KEY).unwrap().as_deref(),
        Some(oversized_raw.as_str())
    );

    db.delete_setting(SETTINGS_KEY).unwrap();
    let many_aliases = (0..1300)
        .map(|index| json!({"alias":format!("{index:04}-{}", "x".repeat(395))}))
        .collect::<Vec<_>>();
    let desired = json!({"id":many_aliases});
    assert!(db.mutate_renderer_command_aliases(None, &desired).is_err());
    assert_eq!(db.get_setting(SETTINGS_KEY).unwrap(), None);
}

#[test]
fn independent_connections_allow_only_one_writer_and_reopen_saved_value() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("renderer-aliases.sqlite");
    let first = Database::open(&path).unwrap();
    first
        .set_setting(SETTINGS_KEY, r#"{"id":[{"alias":"before"}]}"#)
        .unwrap();
    let second = Database::open(&path).unwrap();
    let first_expected = first.read_renderer_command_aliases().unwrap().raw.unwrap();
    let second_expected = second.read_renderer_command_aliases().unwrap().raw.unwrap();
    assert_eq!(first_expected, second_expected);

    let barrier = Arc::new(Barrier::new(3));
    let first_barrier = Arc::clone(&barrier);
    let first_writer = std::thread::spawn(move || {
        first_barrier.wait();
        first.mutate_renderer_command_aliases(
            Some(&first_expected),
            &json!({"id":[{"alias":"first"}]}),
        )
    });
    let second_barrier = Arc::clone(&barrier);
    let second_writer = std::thread::spawn(move || {
        second_barrier.wait();
        second.mutate_renderer_command_aliases(
            Some(&second_expected),
            &json!({"id":[{"alias":"second"}]}),
        )
    });
    barrier.wait();
    let first_result = first_writer.join().unwrap();
    let second_result = second_writer.join().unwrap();
    assert_eq!(
        first_result.is_ok() as usize + second_result.is_ok() as usize,
        1
    );
    assert_eq!(
        first_result.is_err() as usize + second_result.is_err() as usize,
        1
    );

    let reopened = Database::open(&path).unwrap();
    let snapshot = reopened.read_renderer_command_aliases().unwrap();
    assert!(matches!(
        snapshot.value["id"][0]["alias"].as_str(),
        Some("first" | "second")
    ));
    assert_eq!(snapshot.raw, reopened.get_setting(SETTINGS_KEY).unwrap());
}
