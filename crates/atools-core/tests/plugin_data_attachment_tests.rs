//! Attachment transactions, metadata migration and bounded persistence.

use std::sync::{Arc, Barrier};
use std::thread;

use atools_core::db::{Database, PLUGIN_DATA_MAX_DOCUMENT_BYTES};
use atools_core::models::{Document, Plugin, PluginManifest};
use rusqlite::Connection;
use serde_json::json;

fn register(db: &Database, id: &str) {
    let manifest: PluginManifest = serde_json::from_value(json!({"name":id})).unwrap();
    db.save_plugin(&Plugin {
        id: id.into(),
        name: id.into(),
        version: "1".into(),
        path: format!("/tmp/{id}"),
        enabled: true,
        manifest,
        created_at: "now".into(),
        updated_at: "now".into(),
    })
    .unwrap();
}

#[test]
fn attachment_creates_real_parent_and_receipt_metadata_survive_reopen_and_document_update() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.sqlite");
    let db = Database::open(&path).unwrap();
    register(&db, "a");
    register(&db, "b");
    let receipt = db
        .plugin_data_post_attachment_bounded("a", "image", "default", b"abc", "text/plain")
        .unwrap();
    assert_eq!(receipt.ok, Some(true));
    let mut parent = db.plugin_data_get_bounded("a", "image").unwrap().unwrap();
    assert_eq!(parent.rev, receipt.rev);
    assert_eq!(
        parent.data["_attachments"]["default"],
        json!({
            "stub":true, "digest":"md5-900150983cd24fb0d6963f7d28e17f72", "content_type":"text/plain", "length":3, "revpos":1
        })
    );
    let (bytes, metadata) = db
        .plugin_data_get_attachment_bounded("a", "image", "default")
        .unwrap()
        .unwrap();
    assert_eq!(bytes, b"abc");
    assert_eq!(
        serde_json::to_value(&metadata).unwrap(),
        json!({
            "type":"text/plain", "length":3, "md5":"900150983cd24fb0d6963f7d28e17f72",
            "digest":"md5-900150983cd24fb0d6963f7d28e17f72", "name":"default", "revpos":1
        })
    );
    assert!(db
        .plugin_data_get_attachment_bounded("b", "image", "default")
        .unwrap()
        .is_none());
    assert!(db
        .plugin_data_get_attachment_bounded("a", "image", "other")
        .unwrap()
        .is_none());
    let conflict = db
        .plugin_data_post_attachment_bounded("a", "image", "default", b"different", "bad/type")
        .unwrap();
    assert_eq!(conflict.name.as_deref(), Some("conflict"));
    assert_eq!(
        db.plugin_data_get_bounded("a", "image")
            .unwrap()
            .unwrap()
            .rev,
        receipt.rev
    );
    parent.data = json!({"ordinary":"updated without attachment stub"});
    db.plugin_data_put_strict("a", &parent).unwrap();
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened
            .plugin_data_get_attachment_type_bounded("a", "image", "default")
            .unwrap(),
        Some(metadata.clone())
    );
    assert_eq!(
        reopened
            .plugin_data_get_attachment_bounded("a", "image", "default")
            .unwrap()
            .unwrap(),
        (b"abc".to_vec(), metadata)
    );
}

#[test]
fn attachment_names_and_plugin_owners_are_isolated_and_existing_fields_are_retained() {
    let db = Database::in_memory().unwrap();
    register(&db, "a");
    register(&db, "b");
    db.plugin_storage_set("a", "doc", &json!(42)).unwrap();
    let receipt = db
        .plugin_data_post_attachment_bounded("a", "doc", "first", b"one", "text/plain")
        .unwrap();
    assert!(receipt.rev.unwrap().starts_with("2-"));
    db.plugin_data_post_attachment_bounded("a", "doc", "second", b"two", "text/plain")
        .unwrap();
    db.plugin_data_post_attachment_bounded("b", "doc", "first", b"private", "text/plain")
        .unwrap();
    let parent = db.plugin_data_get_bounded("a", "doc").unwrap().unwrap();
    assert_eq!(parent.data["value"], 42);
    assert_eq!(parent.data["_attachments"].as_object().unwrap().len(), 2);
    assert_eq!(
        db.plugin_data_get_attachment_type_bounded("a", "doc", "first")
            .unwrap()
            .unwrap()
            .revpos,
        Some(2)
    );
    assert_eq!(
        db.plugin_data_get_attachment_type_bounded("a", "doc", "second")
            .unwrap()
            .unwrap()
            .revpos,
        Some(3)
    );
    assert_eq!(
        db.plugin_data_get_attachment_bounded("b", "doc", "first")
            .unwrap()
            .unwrap()
            .0,
        b"private"
    );
}

#[test]
fn attachment_limits_fail_before_writes_and_legacy_oversize_is_refused_on_read() {
    let db = Database::in_memory().unwrap();
    register(&db, "a");
    let exact = vec![255; PLUGIN_DATA_MAX_DOCUMENT_BYTES];
    db.plugin_data_post_attachment_bounded(
        "a",
        "exact",
        "default",
        &exact,
        "application/octet-stream",
    )
    .unwrap();
    assert_eq!(
        db.plugin_data_get_attachment_bounded("a", "exact", "default")
            .unwrap()
            .unwrap()
            .0,
        exact
    );
    let overflow = vec![0; PLUGIN_DATA_MAX_DOCUMENT_BYTES + 1];
    assert!(db
        .plugin_data_post_attachment_bounded("a", "overflow", "default", &overflow, "text/plain")
        .is_err());
    assert!(db
        .plugin_data_get_bounded("a", "overflow")
        .unwrap()
        .is_none());
    assert!(db
        .plugin_data_post_attachment_bounded("a", "bad-mime", "default", b"a", &"x".repeat(1025))
        .is_err());
    assert!(db
        .plugin_data_get_bounded("a", "bad-mime")
        .unwrap()
        .is_none());
    db.put_attachment("a", "exact", "legacy-big", &overflow, "text/plain")
        .unwrap();
    assert!(db
        .plugin_data_get_attachment_bounded("a", "exact", "legacy-big")
        .is_err());
    assert!(db
        .plugin_data_get_attachment_type_bounded("a", "exact", "legacy-big")
        .is_err());
    // Adding the stub would overflow a document at its exact budget: all effects roll back.
    let mut full = Document {
        id: "full".into(),
        rev: Some(format!("1-{}", "0".repeat(32))),
        data: json!({"value":""}),
    };
    let overhead = serde_json::to_vec(&full).unwrap().len();
    full.data["value"] = json!("x".repeat(PLUGIN_DATA_MAX_DOCUMENT_BYTES - overhead));
    full.rev = None;
    db.plugin_data_put_strict("a", &full).unwrap();
    let before = db.plugin_data_get_bounded("a", "full").unwrap().unwrap();
    assert!(db
        .plugin_data_post_attachment_bounded("a", "full", "default", b"a", "text/plain")
        .is_err());
    assert!(db
        .plugin_data_get_attachment_bounded("a", "full", "default")
        .unwrap()
        .is_none());
    assert_eq!(
        db.plugin_data_get_bounded("a", "full")
            .unwrap()
            .unwrap()
            .rev,
        before.rev
    );
}

#[test]
fn old_attachment_schema_upgrades_once_and_recovers_only_known_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.sqlite");
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
        CREATE TABLE plugin_data_attachments (
          plugin_id TEXT NOT NULL,doc_id TEXT NOT NULL,name TEXT NOT NULL,data BLOB NOT NULL,
          content_type TEXT NOT NULL,PRIMARY KEY(plugin_id,doc_id,name),
          FOREIGN KEY(plugin_id,doc_id) REFERENCES plugin_data(plugin_id,_id) ON DELETE CASCADE);
        INSERT INTO plugin_data_attachments VALUES('a','old','default',x'616263','text/plain');",
        )
        .unwrap();
    drop(legacy);
    let db = Database::open(&path).unwrap();
    register(&db, "a");
    db.plugin_storage_set("a", "old", &json!(1)).unwrap();
    let recovered = db
        .plugin_data_get_attachment_type_bounded("a", "old", "default")
        .unwrap()
        .unwrap();
    assert_eq!(recovered.md5, "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(recovered.revpos, None); // Never invent the historical upload revision.
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened
            .plugin_data_get_attachment_type_bounded("a", "old", "default")
            .unwrap(),
        Some(recovered)
    );
    let connection = Connection::open(&path).unwrap();
    let columns: usize = connection.query_row("SELECT count(*) FROM pragma_table_info('plugin_data_attachments') WHERE name='metadata'", [], |row| row.get(0)).unwrap();
    assert_eq!(columns, 1);
}

#[test]
fn concurrent_attachment_post_has_one_committed_receipt_and_no_parent_revision_race() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.sqlite");
    let db = Database::open(&path).unwrap();
    register(&db, "a");
    let barrier = Arc::new(Barrier::new(3));
    let workers = [b"one", b"two"]
        .into_iter()
        .map(|bytes| {
            let db = Database::open(&path).unwrap();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                (
                    bytes,
                    db.plugin_data_post_attachment_bounded(
                        "a",
                        "race",
                        "default",
                        bytes,
                        "text/plain",
                    )
                    .unwrap(),
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|(_, receipt)| receipt.ok == Some(true))
            .count(),
        1
    );
    let (winner_bytes, winner) = results
        .iter()
        .find(|(_, receipt)| receipt.ok == Some(true))
        .unwrap();
    assert_eq!(
        db.plugin_data_get_attachment_bounded("a", "race", "default")
            .unwrap()
            .unwrap()
            .0,
        *winner_bytes
    );
    assert_eq!(
        db.plugin_data_get_bounded("a", "race")
            .unwrap()
            .unwrap()
            .rev,
        winner.rev
    );
}

#[test]
fn concurrent_opens_serialize_the_additive_metadata_migration() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.sqlite");
    // Start from a complete pre-metadata database without requiring a separate old binary.
    drop(Database::open(&path).unwrap());
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute(
            "ALTER TABLE plugin_data_attachments DROP COLUMN metadata",
            [],
        )
        .unwrap();
    drop(legacy);
    let barrier = Arc::new(Barrier::new(3));
    let workers = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                Database::open(&path).unwrap()
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    for worker in workers {
        drop(worker.join().unwrap());
    }
    let conn = Connection::open(&path).unwrap();
    let count: usize = conn.query_row("SELECT count(*) FROM pragma_table_info('plugin_data_attachments') WHERE name='metadata'", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 1);
}
