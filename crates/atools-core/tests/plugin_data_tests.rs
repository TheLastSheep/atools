//! Real SQLite contracts for the bounded synchronous plugin adapter.

use std::sync::{Arc, Barrier};
use std::thread;

use atools_core::db::{
    Database, PluginDataQuery, PluginDataRemove, PLUGIN_DATA_MAX_DOCUMENTS,
    PLUGIN_DATA_MAX_DOCUMENT_BYTES, PLUGIN_DATA_MAX_KEYS,
};
use atools_core::models::{Document, Plugin, PluginManifest};
use serde_json::{json, Value};

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

fn database() -> Database {
    let db = Database::in_memory().unwrap();
    register(&db, "a");
    register(&db, "b");
    db
}

fn doc(id: &str, value: Value) -> Document {
    Document {
        id: id.into(),
        rev: None,
        data: json!({"value":value}),
    }
}

#[test]
fn strict_revisions_are_actual_atomic_results_and_legacy_upserts_stay_compatible() {
    let db = database();
    let mut document = doc("item", json!(1));
    let created = db.plugin_data_put_strict("a", &document).unwrap();
    assert_eq!(created.ok, Some(true));
    assert!(created.rev.as_ref().unwrap().starts_with("1-"));
    assert_eq!(
        created.rev,
        db.plugin_data_get_bounded("a", "item")
            .unwrap()
            .unwrap()
            .rev
    );
    let conflict = db.plugin_data_put_strict("a", &document).unwrap();
    assert_eq!(
        serde_json::to_value(conflict).unwrap(),
        json!({
            "id":"item", "error":true, "name":"conflict", "message":"Document update conflict"
        })
    );
    document.rev = Some("stale".into());
    assert_eq!(
        db.plugin_data_put_strict("a", &document)
            .unwrap()
            .name
            .as_deref(),
        Some("conflict")
    );
    document.rev = created.rev;
    document.data = json!({"value":2});
    let updated = db.plugin_data_put_strict("a", &document).unwrap();
    assert!(updated.rev.as_ref().unwrap().starts_with("2-"));
    assert_eq!(
        updated.rev,
        db.plugin_data_get_bounded("a", "item")
            .unwrap()
            .unwrap()
            .rev
    );
    assert!(db.plugin_data_get_bounded("b", "item").unwrap().is_none());
    document.rev = None;
    db.plugin_data_put("a", &document).unwrap(); // Original blind-upsert API remains unchanged.
    assert_eq!(db.plugin_data_all("a").unwrap().len(), 1);
}

#[test]
fn separate_connections_racing_the_same_revision_have_one_winner_and_persist_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.sqlite");
    let db = Database::open(&path).unwrap();
    register(&db, "a");
    let first = db
        .plugin_data_put_strict("a", &doc("race", json!(0)))
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let workers = [1, 2]
        .into_iter()
        .map(|value| {
            let connection = Database::open(&path).unwrap();
            let barrier = barrier.clone();
            let revision = first.rev.clone();
            thread::spawn(move || {
                let mut candidate = doc("race", json!(value));
                candidate.rev = revision;
                barrier.wait();
                (
                    value,
                    connection.plugin_data_put_strict("a", &candidate).unwrap(),
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
            .filter(|(_, result)| result.ok == Some(true))
            .count(),
        1
    );
    let winner = results
        .iter()
        .find(|(_, result)| result.ok == Some(true))
        .unwrap();
    drop(db);
    let reopened = Database::open(&path).unwrap();
    let saved = reopened
        .plugin_data_get_bounded("a", "race")
        .unwrap()
        .unwrap();
    assert_eq!(saved.data["value"], winner.0);
    assert_eq!(saved.rev, winner.1.rev);
}

#[test]
fn bulk_reports_per_item_conflicts_and_budget_rejection_writes_nothing() {
    let db = database();
    db.plugin_data_put_strict("a", &doc("exists", json!(1)))
        .unwrap();
    let results = db
        .plugin_data_bulk_strict(
            "a",
            &[
                doc("exists", json!(2)),
                doc("new", json!(3)),
                doc("other", json!(4)),
            ],
        )
        .unwrap();
    assert_eq!(results[0].name.as_deref(), Some("conflict"));
    assert_eq!(results[1].ok, Some(true));
    assert_eq!(results[2].ok, Some(true));
    assert_eq!(
        db.plugin_data_get_bounded("a", "new").unwrap().unwrap().rev,
        results[1].rev
    );
    let mut existing = doc("new", json!(99));
    existing.rev = results[1].rev.clone();
    assert!(db
        .plugin_data_bulk_strict(
            "a",
            &[
                existing,
                doc("duplicate", json!(1)),
                doc("duplicate", json!(2)),
            ]
        )
        .is_err());
    let unchanged = db.plugin_data_get_bounded("a", "new").unwrap().unwrap();
    assert_eq!(unchanged.rev, results[1].rev);
    assert_eq!(unchanged.data["value"], 3);
    assert!(db
        .plugin_data_get_bounded("a", "duplicate")
        .unwrap()
        .is_none());
    assert!(db
        .plugin_data_bulk_strict(
            "a",
            &[
                doc("must-not-exist", json!(1)),
                doc(
                    "too-large",
                    json!("x".repeat(PLUGIN_DATA_MAX_DOCUMENT_BYTES))
                ),
            ]
        )
        .is_err());
    assert!(db
        .plugin_data_get_bounded("a", "must-not-exist")
        .unwrap()
        .is_none());
    let oversized = (0..PLUGIN_DATA_MAX_DOCUMENTS + 1)
        .map(|n| doc(&n.to_string(), json!(0)))
        .collect::<Vec<_>>();
    assert!(db.plugin_data_bulk_strict("a", &oversized).is_err());
    let aggregate = (0..3)
        .map(|n| doc(&format!("large-{n}"), json!("x".repeat(200_000))))
        .collect::<Vec<_>>();
    assert!(db.plugin_data_bulk_strict("a", &aggregate).is_err());
    assert!(db
        .plugin_data_get_bounded("a", "large-0")
        .unwrap()
        .is_none());
}

#[test]
fn bulk_response_overflow_rolls_back_writes_already_attempted_in_transaction() {
    let db = database();
    let documents = (0..1000)
        .map(|index| doc(&format!("{index:04}-{}", "x".repeat(470)), json!(0)))
        .collect::<Vec<_>>();
    assert!(serde_json::to_vec(&documents).unwrap().len() < 512 * 1024);
    assert!(db.plugin_data_bulk_strict("a", &documents).is_err());
    assert!(db.plugin_data_all("a").unwrap().is_empty());
}

#[test]
fn default_query_limit_accepts_1000_and_explicitly_rejects_a_1001st_match() {
    let db = database();
    let documents = (0..1000)
        .map(|index| doc(&format!("{index:04}"), json!(0)))
        .collect::<Vec<_>>();
    db.plugin_data_bulk_strict("a", &documents).unwrap();
    assert_eq!(
        db.plugin_data_all_bounded("a", &PluginDataQuery::All, None)
            .unwrap()
            .len(),
        1000
    );
    db.plugin_data_put_strict("a", &doc("extra", json!(0)))
        .unwrap();
    assert!(db
        .plugin_data_all_bounded("a", &PluginDataQuery::All, None)
        .is_err());
}

#[test]
fn sql_queries_keep_literal_prefix_and_key_order_and_fail_explicitly_on_limits() {
    let db = database();
    for id in [
        "a%_1",
        "a%_2",
        "ab_3",
        "中文/一",
        "中文/二",
        "nul\0x",
        "nul\0y",
        "nulX",
    ] {
        db.plugin_data_put_strict("a", &doc(id, json!(id))).unwrap();
    }
    let ids = |query, limit| {
        db.plugin_data_all_bounded("a", &query, limit)
            .unwrap()
            .into_iter()
            .map(|doc| doc.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(PluginDataQuery::Prefix("a%_".into()), None),
        ["a%_1", "a%_2"]
    );
    assert_eq!(
        ids(PluginDataQuery::Prefix("中文/".into()), None),
        ["中文/一", "中文/二"]
    );
    assert_eq!(
        ids(PluginDataQuery::Prefix("nul\0".into()), None),
        ["nul\0x", "nul\0y"]
    );
    assert_eq!(
        ids(
            PluginDataQuery::Keys(vec![
                "ab_3".into(),
                "missing".into(),
                "a%_1".into(),
                "ab_3".into()
            ]),
            None
        ),
        ["ab_3", "a%_1", "ab_3"]
    );
    assert!(db
        .plugin_data_all_bounded("a", &PluginDataQuery::All, Some(1))
        .is_err());
    assert_eq!(ids(PluginDataQuery::Prefix("a%_".into()), Some(2)).len(), 2);
    for limit in [0, PLUGIN_DATA_MAX_DOCUMENTS + 1] {
        assert!(db
            .plugin_data_all_bounded("a", &PluginDataQuery::All, Some(limit))
            .is_err());
    }
    assert!(db
        .plugin_data_all_bounded(
            "a",
            &PluginDataQuery::Keys(vec!["missing".into(); PLUGIN_DATA_MAX_KEYS + 1]),
            None
        )
        .is_err());
    assert!(db
        .plugin_data_all_bounded("b", &PluginDataQuery::All, None)
        .unwrap()
        .is_empty());
}

#[test]
fn reads_refuse_legacy_oversize_rows_and_aggregate_response_overflow() {
    let db = database();
    db.plugin_data_put(
        "a",
        &doc(
            "oversize",
            json!("x".repeat(PLUGIN_DATA_MAX_DOCUMENT_BYTES)),
        ),
    )
    .unwrap();
    assert!(db.plugin_data_get_bounded("a", "oversize").is_err());
    for index in 0..3 {
        db.plugin_data_put_strict(
            "a",
            &doc(&format!("prefix/{index}"), json!("x".repeat(200_000))),
        )
        .unwrap();
    }
    assert!(db
        .plugin_data_all_bounded("a", &PluginDataQuery::Prefix("prefix/".into()), None)
        .is_err());
    // SQL selects only the requested rows; unrelated oversized rows cannot poison a keyed read.
    assert_eq!(
        db.plugin_data_all_bounded("a", &PluginDataQuery::Keys(vec!["prefix/1".into()]), None)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn storage_is_the_same_persistent_document_store_and_atomic_set_retains_attachments() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data.sqlite");
    let db = Database::open(&path).unwrap();
    register(&db, "a");
    register(&db, "b");
    assert_eq!(db.plugin_storage_get("a", "prefs").unwrap(), Value::Null);
    let first = db
        .plugin_storage_set("a", "prefs", &json!({"color":"red"}))
        .unwrap();
    db.put_attachment("a", "prefs", "default", b"bytes", "text/plain")
        .unwrap();
    let second = db
        .plugin_storage_set("a", "prefs", &json!({"color":"green"}))
        .unwrap();
    assert_ne!(first.rev, second.rev);
    let saved = db.plugin_data_get_bounded("a", "prefs").unwrap().unwrap();
    assert_eq!(saved.rev, second.rev);
    assert_eq!(saved.data, json!({"value":{"color":"green"}}));
    assert!(db
        .get_attachment("a", "prefs", "default")
        .unwrap()
        .is_some());
    assert_eq!(db.plugin_storage_get("b", "prefs").unwrap(), Value::Null);
    db.plugin_data_put(
        "a",
        &Document {
            id: "fallback".into(),
            rev: None,
            data: json!({"value":null,"data":42}),
        },
    )
    .unwrap();
    assert_eq!(db.plugin_storage_get("a", "fallback").unwrap(), json!(42));
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened.plugin_storage_get("a", "prefs").unwrap(),
        json!({"color":"green"})
    );
    assert_eq!(
        reopened.plugin_storage_remove("a", "prefs").unwrap().ok,
        Some(true)
    );
    assert_eq!(
        reopened.plugin_storage_get("a", "prefs").unwrap(),
        Value::Null
    );
    assert!(reopened
        .get_attachment("a", "prefs", "default")
        .unwrap()
        .is_none());
}

#[test]
fn strict_remove_matches_string_missing_and_optional_document_revision_semantics() {
    let db = database();
    assert_eq!(
        db.plugin_data_remove_strict("a", &PluginDataRemove::Id("missing".into()))
            .unwrap()
            .name
            .as_deref(),
        Some("not_found")
    );
    assert_eq!(
        db.plugin_data_remove_strict("a", &PluginDataRemove::Document(doc("missing", json!(0))))
            .unwrap()
            .ok,
        Some(true)
    );
    db.plugin_data_put_strict("a", &doc("present", json!(0)))
        .unwrap();
    let mut wrong = doc("present", json!(0));
    wrong.rev = Some("wrong".into());
    assert_eq!(
        db.plugin_data_remove_strict("a", &PluginDataRemove::Document(wrong))
            .unwrap()
            .name
            .as_deref(),
        Some("conflict")
    );
    assert!(db
        .plugin_data_get_bounded("a", "present")
        .unwrap()
        .is_some());
    assert_eq!(
        db.plugin_data_remove_strict("a", &PluginDataRemove::Document(doc("present", json!(0))))
            .unwrap()
            .ok,
        Some(true)
    );
}

#[test]
fn stored_document_budget_counts_generated_revision_and_allows_exact_boundary() {
    let db = database();
    let mut boundary = doc("boundary", json!(""));
    boundary.rev = Some(format!("1-{}", "0".repeat(32)));
    let overhead = serde_json::to_vec(&boundary).unwrap().len();
    boundary.data = json!({"value":"x".repeat(PLUGIN_DATA_MAX_DOCUMENT_BYTES - overhead)});
    boundary.rev = None;
    db.plugin_data_put_strict("a", &boundary).unwrap();
    let stored = db
        .plugin_data_get_bounded("a", "boundary")
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&stored).unwrap().len(),
        PLUGIN_DATA_MAX_DOCUMENT_BYTES
    );
    let mut overflow = boundary;
    overflow.id = "overflow".into();
    let value = format!("{}x", overflow.data["value"].as_str().unwrap());
    overflow.data["value"] = json!(value);
    assert!(db.plugin_data_put_strict("a", &overflow).is_err());
    assert!(db
        .plugin_data_get_bounded("a", "overflow")
        .unwrap()
        .is_none());
}
