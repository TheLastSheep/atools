//! Real SQLite contracts for plugin-isolated Web Storage.

use std::sync::{Arc, Barrier};
use std::thread;

use atools_core::db::{
    Database, PluginWebStorageError, PLUGIN_WEB_STORAGE_MAX_ENTRIES,
    PLUGIN_WEB_STORAGE_MAX_KEY_BYTES, PLUGIN_WEB_STORAGE_MAX_TOTAL_BYTES,
    PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES,
};
use atools_core::models::{Plugin, PluginManifest};
use serde_json::json;

fn register(db: &Database, id: &str, enabled: bool) {
    let manifest: PluginManifest = serde_json::from_value(json!({"name":id})).unwrap();
    db.save_plugin(&Plugin {
        id: id.into(),
        name: id.into(),
        version: "1".into(),
        path: format!("/tmp/{id}"),
        enabled,
        manifest,
        created_at: "now".into(),
        updated_at: "now".into(),
    })
    .unwrap();
}

fn database() -> Database {
    let db = Database::in_memory().unwrap();
    register(&db, "a", true);
    register(&db, "b", true);
    db
}

fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[test]
fn preserves_utf16_domstrings_empty_keys_order_and_mutation_results() {
    let db = database();
    let lone_surrogate = vec![0x0061, 0xd800, 0xdc00, 0xdfff];
    let set = db
        .plugin_web_storage_set("a", &[], &lone_surrogate)
        .unwrap();
    assert_eq!(set.key, Some(vec![]));
    assert_eq!(set.old_value, None);
    assert_eq!(set.new_value, Some(lone_surrogate.clone()));
    assert!(set.changed);
    assert_eq!(
        db.plugin_web_storage_get("a", &[]).unwrap(),
        Some(lone_surrogate.clone())
    );

    db.plugin_web_storage_set("a", &units("second"), &units("2"))
        .unwrap();
    let same = db
        .plugin_web_storage_set("a", &[], &lone_surrogate)
        .unwrap();
    assert!(!same.changed);
    assert_eq!(same.old_value, Some(lone_surrogate.clone()));
    assert_eq!(db.plugin_web_storage_length("a").unwrap(), 2);
    assert_eq!(db.plugin_web_storage_key("a", 0).unwrap(), Some(vec![]));
    assert_eq!(
        db.plugin_web_storage_key("a", 1).unwrap(),
        Some(units("second"))
    );
    assert_eq!(db.plugin_web_storage_key("a", 2).unwrap(), None);
    assert_eq!(
        db.plugin_web_storage_keys("a").unwrap(),
        vec![vec![], units("second")]
    );

    let missing = db.plugin_web_storage_remove("a", &units("absent")).unwrap();
    assert!(!missing.changed);
    assert_eq!(missing.old_value, None);
    let removed = db.plugin_web_storage_remove("a", &[]).unwrap();
    assert!(removed.changed);
    assert_eq!(removed.old_value, Some(lone_surrogate));
    assert_eq!(
        db.plugin_web_storage_key("a", 0).unwrap(),
        Some(units("second"))
    );
}

#[test]
fn storage_is_isolated_and_clear_does_not_touch_dbstorage_or_disabled_plugins() {
    let db = database();
    db.plugin_web_storage_set("a", &units("same"), &units("web"))
        .unwrap();
    db.plugin_web_storage_set("b", &units("same"), &units("other"))
        .unwrap();
    db.plugin_storage_set("a", "same", &json!("dbStorage"))
        .unwrap();

    let mut disabled = db.get_plugin("a").unwrap();
    disabled.enabled = false;
    db.save_plugin(&disabled).unwrap();
    assert_eq!(
        db.plugin_web_storage_get("a", &units("same")).unwrap(),
        Some(units("web"))
    );

    let cleared = db.plugin_web_storage_clear("a").unwrap();
    assert!(cleared.changed);
    assert_eq!(cleared.key, None);
    assert_eq!(db.plugin_web_storage_length("a").unwrap(), 0);
    assert_eq!(
        db.plugin_web_storage_get("b", &units("same")).unwrap(),
        Some(units("other"))
    );
    assert_eq!(
        db.plugin_storage_get("a", "same").unwrap(),
        json!("dbStorage")
    );
    assert!(!db.plugin_web_storage_clear("a").unwrap().changed);

    // Existing delete_plugin uses FK cascades for owned plugin data; this table follows it.
    db.delete_plugin("b").unwrap();
    assert_eq!(db.plugin_web_storage_length("b").unwrap(), 0);
}

#[test]
fn values_persist_across_connections_and_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.sqlite");
    let db = Database::open(&path).unwrap();
    register(&db, "persistent", true);
    db.plugin_web_storage_set("persistent", &units("k"), &[0xd800])
        .unwrap();
    let other_connection = Database::open(&path).unwrap();
    assert_eq!(
        other_connection
            .plugin_web_storage_get("persistent", &units("k"))
            .unwrap(),
        Some(vec![0xd800])
    );
    drop(other_connection);
    drop(db);

    let reopened = Database::open(&path).unwrap();
    assert_eq!(reopened.plugin_web_storage_length("persistent").unwrap(), 1);
    assert_eq!(
        reopened.plugin_web_storage_key("persistent", 0).unwrap(),
        Some(units("k"))
    );
}

#[test]
fn entries_pages_preserve_utf16_insertion_order_and_bound_the_encoded_budget() {
    let db = database();
    let value = vec![0xd800; 50 * 1024];
    for key in [
        vec![],
        vec![0xdfff],
        units("third"),
        units("fourth"),
        units("fifth"),
    ] {
        db.plugin_web_storage_set("a", &key, &value).unwrap();
    }

    let first = db.plugin_web_storage_entries("a", 0).unwrap();
    assert_eq!(first.entries.len(), 2);
    assert_eq!(first.next_offset, Some(2));
    assert_eq!(first.entries[0].key, Vec::<u16>::new());
    assert_eq!(first.entries[0].value, value);

    let second = db
        .plugin_web_storage_entries("a", first.next_offset.unwrap())
        .unwrap();
    assert_eq!(second.entries.len(), 2);
    assert_eq!(second.next_offset, Some(4));
    let third = db
        .plugin_web_storage_entries("a", second.next_offset.unwrap())
        .unwrap();
    assert_eq!(third.entries.len(), 1);
    assert_eq!(third.next_offset, None);
    assert_eq!(third.entries[0].key, units("fifth"));

    let beyond = db.plugin_web_storage_entries("a", 4096).unwrap();
    assert!(beyond.entries.is_empty());
    assert_eq!(beyond.next_offset, None);
}

#[test]
fn quotas_reject_oversized_inputs_and_failed_replacements_keep_the_old_value() {
    let db = database();
    assert_eq!(
        db.plugin_web_storage_set(
            "a",
            &vec![b'k' as u16; PLUGIN_WEB_STORAGE_MAX_KEY_BYTES / 2 + 1],
            &[]
        ),
        Err(PluginWebStorageError::QuotaExceeded)
    );
    assert_eq!(
        db.plugin_web_storage_set(
            "a",
            &[],
            &vec![b'v' as u16; PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES / 2 + 1]
        ),
        Err(PluginWebStorageError::QuotaExceeded)
    );

    db.plugin_web_storage_set("a", &units("last"), &[]).unwrap();
    let full_value = vec![b'x' as u16; PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES / 2];
    for index in 0..39 {
        db.plugin_web_storage_set("a", &units(&format!("filler-{index:02}")), &full_value)
            .unwrap();
    }
    let rejected = db.plugin_web_storage_set("a", &units("last"), &full_value);
    assert_eq!(rejected, Err(PluginWebStorageError::QuotaExceeded));
    assert_eq!(
        db.plugin_web_storage_get("a", &units("last")).unwrap(),
        Some(vec![])
    );
    assert!(PLUGIN_WEB_STORAGE_MAX_TOTAL_BYTES > full_value.len() as u64);
}

#[test]
fn aggregate_key_quota_rejects_the_next_key_without_mutating_storage() {
    let db = database();
    for index in 0..128u16 {
        let mut key = vec![b'k' as u16; PLUGIN_WEB_STORAGE_MAX_KEY_BYTES / 2];
        key[0] = index;
        db.plugin_web_storage_set("a", &key, &[]).unwrap();
    }
    let next = db.plugin_web_storage_set("a", &[0xffff], &[]);
    assert_eq!(next, Err(PluginWebStorageError::QuotaExceeded));
    assert_eq!(db.plugin_web_storage_length("a").unwrap(), 128);
    assert_eq!(
        db.plugin_web_storage_key("a", 0).unwrap().unwrap().len() * 2,
        PLUGIN_WEB_STORAGE_MAX_KEY_BYTES
    );
}

#[test]
fn entry_limit_is_enforced_and_failed_insert_does_not_change_order_or_count() {
    let db = database();
    for index in 0..PLUGIN_WEB_STORAGE_MAX_ENTRIES {
        db.plugin_web_storage_set("a", &[index as u16], &[])
            .unwrap();
    }
    assert_eq!(
        db.plugin_web_storage_length("a").unwrap(),
        PLUGIN_WEB_STORAGE_MAX_ENTRIES as u32
    );
    let failure = db.plugin_web_storage_set("a", &[0xfffe], &[]);
    assert_eq!(failure, Err(PluginWebStorageError::QuotaExceeded));
    assert_eq!(
        db.plugin_web_storage_length("a").unwrap(),
        PLUGIN_WEB_STORAGE_MAX_ENTRIES as u32
    );
    assert_eq!(db.plugin_web_storage_key("a", 0).unwrap(), Some(vec![0]));
}

#[test]
fn concurrent_connections_cannot_both_spend_the_last_quota() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("race.sqlite");
    let db = Database::open(&path).unwrap();
    register(&db, "race", true);
    let full_value = vec![b'x' as u16; 65_000]; // 130,000 UTF-16 bytes.
    for index in 0..40 {
        db.plugin_web_storage_set("race", &units(&format!("base-{index:02}")), &full_value)
            .unwrap();
    }

    let barrier = Arc::new(Barrier::new(3));
    let writers = ["left", "right"]
        .into_iter()
        .map(|key| {
            let connection = Database::open(&path).unwrap();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                connection.plugin_web_storage_set("race", &units(key), &vec![7; 11_000])
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = writers
        .into_iter()
        .map(|writer| writer.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| *result == &Err(PluginWebStorageError::QuotaExceeded))
            .count(),
        1
    );
    assert_eq!(db.plugin_web_storage_length("race").unwrap(), 41);
}
