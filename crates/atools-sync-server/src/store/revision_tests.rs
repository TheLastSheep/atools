use serde_json::Value;

use super::*;
use crate::{model::FullChangeEntry, store::Store};

#[test]
fn tombstones_and_sequences_survive_reopen_and_are_user_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sync.db");
    let store = Store::open(&path).unwrap();
    let created = change("1-a", false, serde_json::json!({"text":"hello"}));
    let created_seq = store
        .push_changes("alice", "device", &[created], 2)
        .unwrap();
    let deleted = change_with_parent("2-b", "1-a", true, serde_json::Value::Null);
    let deleted_seq = store
        .push_changes("alice", "device", &[deleted], 2)
        .unwrap();
    assert!(deleted_seq > created_seq);
    assert_eq!(store.pull_changes("bob", 0, false).unwrap().0.len(), 0);
    drop(store);

    let reopened = Store::open(&path).unwrap();
    let (changes, high_water) = reopened.pull_changes("alice", created_seq, false).unwrap();
    assert_eq!(high_water, deleted_seq);
    assert_eq!(changes.len(), 1);
    assert!(changes[0].deleted);
    assert_eq!(changes[0].rev, "2-b");
    let (snapshot, snapshot_seq) = reopened.pull_changes("alice", 0, true).unwrap();
    assert_eq!(snapshot_seq, deleted_seq);
    assert_eq!(snapshot.len(), 1);
    assert!(snapshot[0].deleted);
}

#[test]
fn rejects_attachment_payloads_before_writing_any_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).unwrap();
    let with_attachment = change(
        "1-a",
        false,
        serde_json::json!({"_attachments":{"a":{"digest":"md5-x"}}}),
    );
    assert!(matches!(
        store.push_changes("alice", "device", &[with_attachment], 2),
        Err(StoreError::UnsupportedPayload("attachments"))
    ));
    assert_eq!(store.max_user_seq("alice").unwrap(), 0);
}

#[test]
fn accepts_only_linear_revision_extensions_and_identical_retries() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).unwrap();
    let first = change("1-a", false, serde_json::json!({"text":"first"}));
    let first_seq = store.push_changes("alice", "device", &[first], 2).unwrap();
    let second = change_with_parent("2-b", "1-a", false, serde_json::json!({"text":"second"}));
    let second_seq = store
        .push_changes("alice", "device", &[second.clone()], 2)
        .unwrap();
    assert!(second_seq > first_seq);
    assert_eq!(
        store.push_changes("alice", "device", &[second], 2).unwrap(),
        second_seq
    );
    let mut changed_retry = change_with_parent(
        "2-b",
        "1-a",
        false,
        serde_json::json!({"text":"different body"}),
    );
    changed_retry.timestamp = 1;
    assert!(matches!(
        store.push_changes("alice", "device", &[changed_retry], 2),
        Err(StoreError::RevisionConflict(
            "duplicate revision content differs"
        ))
    ));

    let (current, sequence) = store.pull_changes("alice", 0, true).unwrap();
    assert_eq!(current[0].rev, "2-b");
    assert_eq!(current[0].doc["text"], "second");
    assert_eq!(sequence, second_seq);
}

#[test]
fn rejects_branch_and_rolls_back_the_entire_batch() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).unwrap();
    store
        .push_changes(
            "alice",
            "device",
            &[change("1-a", false, serde_json::json!({"text":"root"}))],
            2,
        )
        .unwrap();
    let valid = change_with_parent("2-b", "1-a", false, serde_json::json!({"text":"valid"}));
    let stale_branch = change_with_parent(
        "2-c",
        "1-a",
        false,
        serde_json::json!({"text":"stale branch"}),
    );
    assert!(matches!(
        store.push_changes("alice", "device", &[valid, stale_branch], 2),
        Err(StoreError::RevisionConflict(_))
    ));
    let (current, sequence) = store.pull_changes("alice", 0, true).unwrap();
    assert_eq!(sequence, 1);
    assert_eq!(current[0].rev, "1-a");
    assert_eq!(current[0].doc["text"], "root");
}

#[test]
fn rejects_missing_parent_generation_jumps_and_first_revision_parent() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).unwrap();
    store
        .push_changes(
            "alice",
            "device",
            &[change("1-a", false, serde_json::json!({"text":"root"}))],
            2,
        )
        .unwrap();
    assert!(matches!(
        store.push_changes(
            "alice",
            "device",
            &[change(
                "2-b",
                false,
                serde_json::json!({"text":"missing parent"})
            )],
            2,
        ),
        Err(StoreError::RevisionConflict(
            "parent revision must match the current revision"
        ))
    ));
    assert!(matches!(
        store.push_changes(
            "alice",
            "device",
            &[change_with_parent(
                "3-c",
                "1-a",
                false,
                serde_json::json!({"text":"jump"})
            )],
            2,
        ),
        Err(StoreError::RevisionConflict(
            "revision generation must advance by one"
        ))
    ));
    let mut orphan =
        change_with_parent("2-new", "1-a", false, serde_json::json!({"text":"orphan"}));
    orphan.doc_id = "orphan".into();
    assert!(matches!(
        store.push_changes("alice", "device", &[orphan], 2),
        Err(StoreError::RevisionConflict(
            "first revision must be generation one without a parent"
        ))
    ));
    assert_eq!(store.max_user_seq("alice").unwrap(), 1);
}

#[test]
fn explicitly_rejects_resolution_winner_and_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).unwrap();
    for wire in [
        serde_json::json!({"docId":"a","rev":"1-a","doc":{},"resolution":null}),
        serde_json::json!({"docId":"b","rev":"1-b","doc":{},"winnerRev":"1-b"}),
        serde_json::json!({"docId":"c","rev":"1-c","doc":{},"isWinner":null}),
        serde_json::json!({"docId":"d","rev":"1-d","doc":{},"retireOtherLeaves":true}),
        serde_json::json!({"docId":"e","rev":"1-e","doc":{},"leaves":[]}),
    ] {
        let change: FullChangeEntry = serde_json::from_value(wire).unwrap();
        assert!(matches!(
            store.push_changes("alice", "device", &[change], 2),
            Err(StoreError::UnsupportedPayload(_))
        ));
    }
    assert_eq!(store.max_user_seq("alice").unwrap(), 0);
}

#[test]
fn rejects_missing_or_blank_revision_instead_of_acknowledging_a_noop() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).unwrap();
    let missing = change("", false, Value::Null);
    assert!(matches!(
        store.push_changes("alice", "device", &[missing], 2),
        Err(StoreError::MissingRevision)
    ));
    assert_eq!(store.max_user_seq("alice").unwrap(), 0);
}

#[test]
fn push_budget_counts_change_metadata_and_limits_batch_length() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).unwrap();
    let mut oversized_entry = change("1-a", false, Value::Null);
    oversized_entry.doc_type = Some("x".repeat(MAX_CHANGE_BYTES));
    assert!(matches!(
        store.push_changes("alice", "device", &[oversized_entry], 2),
        Err(StoreError::PayloadTooLarge)
    ));

    let per_entry_metadata = MAX_PUSH_BYTES / 5 + 1;
    let aggregate_overflow = (0..5)
        .map(|index| {
            let mut change = change(&format!("1-total-{index}"), false, Value::Null);
            change.doc_id = format!("aggregate-{index}");
            change.doc_type = Some("x".repeat(per_entry_metadata));
            change
        })
        .collect::<Vec<_>>();
    assert!(aggregate_overflow
        .iter()
        .all(|change| { serde_json::to_vec(change).unwrap().len() <= MAX_CHANGE_BYTES }));
    assert!(matches!(
        store.push_changes("alice", "device", &aggregate_overflow, 2),
        Err(StoreError::PayloadTooLarge)
    ));

    let too_many = (0..=MAX_PUSH_CHANGES)
        .map(|index| {
            let mut change = change(&format!("1-{index}"), false, Value::Null);
            change.doc_id = format!("note-{index}");
            change
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        store.push_changes("alice", "device", &too_many, 2),
        Err(StoreError::PayloadTooLarge)
    ));
    assert_eq!(store.max_user_seq("alice").unwrap(), 0);
}

fn change(rev: &str, deleted: bool, doc: Value) -> FullChangeEntry {
    FullChangeEntry {
        seq: 0,
        doc_id: "note".into(),
        rev: rev.into(),
        parent_rev: None,
        revision_history: None,
        deleted,
        timestamp: 0,
        doc,
        doc_type: Some("note".into()),
        protocol_version: Some(2),
        extra_fields: Default::default(),
    }
}

fn change_with_parent(rev: &str, parent_rev: &str, deleted: bool, doc: Value) -> FullChangeEntry {
    let mut change = change(rev, deleted, doc);
    change.parent_rev = Some(parent_rev.into());
    change
}
