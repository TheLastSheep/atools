use std::collections::BTreeMap;

use atools_core::{
    pasteboard_order_key_between, Database, HybridLogicalClock, PasteboardBlob,
    PasteboardEntityType, PasteboardItem, PasteboardItemKind, PasteboardPayload,
    PasteboardTombstone, Pinboard,
};
use serde_json::Value;

fn clock(wall_ms: i64, counter: u64) -> HybridLogicalClock {
    HybridLogicalClock {
        wall_ms,
        counter,
        device_id: "atools-test".to_string(),
    }
}

fn text_item(id: &str, text: &str, copied_at: &str) -> PasteboardItem {
    PasteboardItem {
        id: id.to_string(),
        kind: PasteboardItemKind::Text,
        title: None,
        source_app: None,
        source_device_id: "atools-test".to_string(),
        copied_at: copied_at.to_string(),
        updated_at: copied_at.to_string(),
        content_fingerprint: format!("fingerprint-{id}"),
        payload: PasteboardPayload {
            revision: format!("revision-{id}"),
            text: Some(text.to_string()),
            ..PasteboardPayload::default()
        },
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned: false,
        field_clocks: BTreeMap::from([("payload".to_string(), clock(1, 0))]),
    }
}

fn pinboard(id: &str, name: &str, order_key: &str) -> Pinboard {
    Pinboard {
        id: id.to_string(),
        name: name.to_string(),
        color: "#6F61EA".to_string(),
        order_key: order_key.to_string(),
        created_at: "2026-04-01T00:00:00Z".to_string(),
        updated_at: "2026-04-01T00:00:00Z".to_string(),
        field_clocks: BTreeMap::from([
            ("name".to_string(), clock(1, 0)),
            ("color".to_string(), clock(1, 1)),
            ("orderKey".to_string(), clock(1, 2)),
        ]),
    }
}

fn blob(id: &str, bytes: u64) -> PasteboardBlob {
    PasteboardBlob {
        id: id.to_string(),
        keyed_fingerprint: format!("keyed-{id}"),
        relative_path: format!("objects/{id}.bin"),
        media_type: "image/png".to_string(),
        byte_length: bytes,
        created_at: "2026-04-01T00:00:00Z".to_string(),
        last_accessed_at: "2026-04-01T00:00:00Z".to_string(),
        remote_available: false,
        sync_state: "local".to_string(),
        metadata: Value::Null,
    }
}

#[test]
fn pasteboard_item_round_trips_and_preserves_pinboards() {
    let db = Database::in_memory().unwrap();
    db.upsert_pasteboard_item(&text_item("item-1", "hello", "2026-04-01T00:00:00Z"))
        .unwrap();
    db.upsert_pinboard(&pinboard("board-1", "Design", "a0"))
        .unwrap();
    db.assign_pasteboard_item("item-1", Some("board-1"), Some("a0"))
        .unwrap();

    let item = db.get_pasteboard_item("item-1").unwrap().unwrap();
    assert_eq!(item.pinboard_id.as_deref(), Some("board-1"));
    assert_eq!(item.pinboard_order_key.as_deref(), Some("a0"));
    assert_eq!(db.list_pinboards().unwrap()[0].name, "Design");
    assert_eq!(
        db.search_pasteboard_items("hello", None, 20).unwrap().len(),
        1
    );
}

#[test]
fn pasteboard_batch_upsert_is_atomic_and_searchable() {
    let db = Database::in_memory().unwrap();
    let first = text_item("batch-1", "first batch needle", "2026-04-01T00:00:00Z");
    let second = text_item("batch-2", "second batch needle", "2026-04-01T00:00:01Z");
    db.upsert_pasteboard_items_batch(&[first, second])
        .unwrap();

    let results = db.search_pasteboard_items("batch needle", None, 20).unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(db.count_pasteboard_items().unwrap(), 2);
}

#[test]
fn pruning_never_removes_pinboard_or_pinned_items() {
    let db = Database::in_memory().unwrap();
    let mut regular = text_item("regular", "regular", "2026-01-01T00:00:00Z");
    regular.payload.blob_id = Some("blob-regular".to_string());
    db.upsert_pasteboard_blob(&blob("blob-regular", 30))
        .unwrap();
    db.upsert_pasteboard_item(&regular).unwrap();

    db.upsert_pinboard(&pinboard("board-1", "Protected", "a0"))
        .unwrap();
    let mut board_item = text_item("board", "board", "2026-01-01T00:00:00Z");
    board_item.payload.blob_id = Some("blob-board".to_string());
    db.upsert_pasteboard_blob(&blob("blob-board", 40)).unwrap();
    db.upsert_pasteboard_item(&board_item).unwrap();
    db.assign_pasteboard_item("board", Some("board-1"), Some("a0"))
        .unwrap();

    let mut pinned = text_item("pinned", "pinned", "2026-01-01T00:00:00Z");
    pinned.pinned = true;
    pinned.payload.blob_id = Some("blob-pinned".to_string());
    db.upsert_pasteboard_blob(&blob("blob-pinned", 50)).unwrap();
    db.upsert_pasteboard_item(&pinned).unwrap();

    let result = db
        .prune_pasteboard_history("2026-04-16T00:00:00Z", 1_073_741_824)
        .unwrap();
    assert_eq!(result.deleted_items, 1);
    assert_eq!(result.deleted_item_ids, vec!["regular"]);
    assert_eq!(result.deleted_blob_ids, vec!["blob-regular"]);
    assert!(db.get_pasteboard_item("regular").unwrap().is_none());
    assert!(db.get_pasteboard_item("board").unwrap().is_some());
    assert!(db.get_pasteboard_item("pinned").unwrap().is_some());
}

#[test]
fn tombstone_replaces_live_entity_and_live_revision_can_restore_it() {
    let db = Database::in_memory().unwrap();
    let item = text_item("item-1", "hello", "2026-04-01T00:00:00Z");
    db.upsert_pasteboard_item(&item).unwrap();
    db.upsert_pasteboard_tombstone(&PasteboardTombstone {
        id: item.id.clone(),
        entity_type: PasteboardEntityType::PasteItem,
        deleted: true,
        deleted_at: "2026-04-02T00:00:00Z".to_string(),
        source_device_id: "atools-test".to_string(),
        clock: clock(2, 0),
    })
    .unwrap();
    assert!(db.get_pasteboard_item("item-1").unwrap().is_none());
    assert_eq!(db.list_pasteboard_tombstones().unwrap().len(), 1);

    db.upsert_pasteboard_item(&item).unwrap();
    assert!(db.get_pasteboard_item("item-1").unwrap().is_some());
    assert!(db.list_pasteboard_tombstones().unwrap().is_empty());
}

#[test]
fn order_keys_match_the_shared_base62_contract() {
    assert_eq!(pasteboard_order_key_between(None, None).unwrap(), "a0");
    assert_eq!(
        pasteboard_order_key_between(Some("0"), Some("1")).unwrap(),
        "0V"
    );
    let after_first = pasteboard_order_key_between(Some("a0"), None).unwrap();
    assert!(after_first.as_str() > "a0");
    let between = pasteboard_order_key_between(Some("a0"), Some(&after_first)).unwrap();
    assert!(between.as_str() > "a0");
    assert!(between < after_first);
}

#[test]
fn ocr_updates_are_searchable_and_clocked_without_replacing_payload() {
    let db = Database::in_memory().unwrap();
    db.upsert_pasteboard_item(&text_item(
        "ocr-item",
        "image fallback",
        "2026-04-01T00:00:00Z",
    ))
    .unwrap();

    let updated = db
        .update_pasteboard_item_ocr_from_device(
            "ocr-item",
            Some("  scanned invoice  "),
            "ocr-device",
        )
        .unwrap();

    assert_eq!(updated.ocr_text.as_deref(), Some("scanned invoice"));
    assert_eq!(updated.payload.text.as_deref(), Some("image fallback"));
    assert_eq!(
        updated
            .field_clocks
            .get("ocrText")
            .map(|clock| clock.device_id.as_str()),
        Some("ocr-device")
    );
    assert_eq!(
        db.search_pasteboard_items("invoice", None, 20)
            .unwrap()
            .len(),
        1
    );
}
