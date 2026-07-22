use atools_core::{
    Database, PasteboardBlob, PasteboardItem, PasteboardItemKind, PasteboardPinboard,
    PasteboardSourceApp, PasteboardTombstone,
};

fn text_item(id: &str, text: &str, copied_at: &str) -> PasteboardItem {
    PasteboardItem {
        id: id.to_string(),
        kind: PasteboardItemKind::Text,
        title: None,
        source_app: Some(PasteboardSourceApp {
            bundle_id: Some("com.apple.TextEdit".into()),
            name: Some("TextEdit".into()),
        }),
        source_device_id: "device-local".into(),
        copied_at: copied_at.into(),
        updated_at: copied_at.into(),
        content_fingerprint: format!("fingerprint-{id}"),
        payload: serde_json::json!({ "text": text }),
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned: false,
        field_clocks: serde_json::json!({}),
    }
}

fn pinboard(id: &str, name: &str, order_key: &str) -> PasteboardPinboard {
    PasteboardPinboard {
        id: id.into(),
        name: name.into(),
        color: "#7c5cff".into(),
        order_key: order_key.into(),
        created_at: "2026-07-21T00:00:00Z".into(),
        updated_at: "2026-07-21T00:00:00Z".into(),
        field_clocks: serde_json::json!({}),
    }
}

fn blob(id: &str, bytes: u64) -> PasteboardBlob {
    PasteboardBlob {
        id: id.into(),
        content_hash: format!("hash-{id}"),
        relative_path: format!("{id}.bin"),
        media_type: "application/octet-stream".into(),
        byte_size: bytes,
        created_at: "2026-07-21T00:00:00Z".into(),
        last_accessed_at: "2026-07-21T00:00:00Z".into(),
    }
}

#[test]
fn pasteboard_item_round_trips_and_preserves_pinboards() {
    let db = Database::in_memory().unwrap();
    db.upsert_pasteboard_pinboard(&pinboard("board-1", "设计", "a0"))
        .unwrap();
    db.upsert_pasteboard_item(&text_item("item-1", "hello", "2026-07-21T00:00:00Z"))
        .unwrap();
    assert!(db
        .assign_pasteboard_item("item-1", Some("board-1"), Some("a0"))
        .unwrap());

    let item = db.get_pasteboard_item("item-1").unwrap().unwrap();
    assert_eq!(item.pinboard_id.as_deref(), Some("board-1"));
    assert_eq!(item.pinboard_order_key.as_deref(), Some("a0"));
    assert_eq!(db.list_pasteboard_pinboards().unwrap()[0].name, "设计");
}

#[test]
fn search_covers_payload_source_title_and_ocr() {
    let db = Database::in_memory().unwrap();
    let mut item = text_item("item-1", "Rust clipboard runtime", "2026-07-21T00:00:00Z");
    item.title = Some("Performance notes".into());
    item.ocr_text = Some("Invoice total 42".into());
    db.upsert_pasteboard_item(&item).unwrap();

    for query in ["clipboard", "textedit", "performance", "invoice"] {
        let results = db.search_pasteboard_items(query, None, &[], 20, 0).unwrap();
        assert_eq!(results.len(), 1, "missing query {query}");
        assert_eq!(results[0].id, "item-1");
    }
}

#[test]
fn search_matches_localized_item_kind_aliases() {
    let db = Database::in_memory().unwrap();
    let mut item = text_item("image-1", "", "2026-07-21T00:00:00Z");
    item.kind = PasteboardItemKind::Image;
    item.payload = serde_json::json!({"thumbnailBlobPath": "thumb.png"});
    db.upsert_pasteboard_item(&item).unwrap();

    for query in ["图片", "image", "picture"] {
        let results = db.search_pasteboard_items(query, None, &[], 20, 0).unwrap();
        assert_eq!(results.len(), 1, "missing kind alias {query}");
        assert_eq!(results[0].id, "image-1");
    }
}

#[test]
fn pruning_never_removes_pinboard_or_pinned_items() {
    let db = Database::in_memory().unwrap();
    db.upsert_pasteboard_pinboard(&pinboard("board-1", "长期", "a0"))
        .unwrap();

    let expired = text_item("expired", "old", "2026-01-01T00:00:00Z");
    let mut grouped = text_item("grouped", "keep", "2026-01-01T00:00:00Z");
    grouped.pinboard_id = Some("board-1".into());
    grouped.pinboard_order_key = Some("a0".into());
    let mut pinned = text_item("pinned", "keep", "2026-01-01T00:00:00Z");
    pinned.pinned = true;

    db.upsert_pasteboard_item(&expired).unwrap();
    db.upsert_pasteboard_item(&grouped).unwrap();
    db.upsert_pasteboard_item(&pinned).unwrap();

    let result = db
        .prune_pasteboard_history("2026-04-01T00:00:00Z", 1_073_741_824)
        .unwrap();
    assert_eq!(result.deleted_items, 1);
    assert!(db.get_pasteboard_item("expired").unwrap().is_none());
    assert!(db.get_pasteboard_item("grouped").unwrap().is_some());
    assert!(db.get_pasteboard_item("pinned").unwrap().is_some());
}

#[test]
fn attachment_budget_evicts_oldest_unprotected_item_and_returns_blob_path() {
    let db = Database::in_memory().unwrap();
    db.upsert_pasteboard_pinboard(&pinboard("board-1", "长期", "a0"))
        .unwrap();

    let old = text_item("old", "old", "2026-07-01T00:00:00Z");
    let fresh = text_item("fresh", "fresh", "2026-07-20T00:00:00Z");
    let mut grouped = text_item("grouped", "keep", "2026-06-01T00:00:00Z");
    grouped.pinboard_id = Some("board-1".into());
    grouped.pinboard_order_key = Some("a0".into());
    for item in [&old, &fresh, &grouped] {
        db.upsert_pasteboard_item(item).unwrap();
    }
    for (item_id, blob_id) in [
        ("old", "blob-old"),
        ("fresh", "blob-fresh"),
        ("grouped", "blob-grouped"),
    ] {
        db.upsert_pasteboard_blob(&blob(blob_id, 100)).unwrap();
        db.link_pasteboard_blob(item_id, blob_id).unwrap();
    }

    let result = db
        .prune_pasteboard_history("2026-01-01T00:00:00Z", 200)
        .unwrap();
    assert_eq!(result.deleted_items, 1);
    assert_eq!(result.deleted_blobs, vec!["blob-old.bin"]);
    assert_eq!(result.reclaimed_bytes, 100);
    assert_eq!(result.remaining_attachment_bytes, 200);
    assert!(db.get_pasteboard_item("old").unwrap().is_none());
    assert!(db.get_pasteboard_item("fresh").unwrap().is_some());
    assert!(db.get_pasteboard_item("grouped").unwrap().is_some());
}

#[test]
fn sync_metadata_round_trips_blobs_and_tombstones() {
    let db = Database::in_memory().unwrap();
    let blob = blob("sync-blob", 42);
    db.upsert_pasteboard_blob(&blob).unwrap();
    assert_eq!(db.get_pasteboard_blob("sync-blob").unwrap(), Some(blob));

    let tombstone = PasteboardTombstone {
        entity_id: "item-deleted".into(),
        entity_kind: "paste_item".into(),
        deleted_at: "2026-07-21T05:30:00Z".into(),
        deleted_clock: serde_json::json!({"wallMs": 1, "counter": 0, "deviceId": "device-local"}),
        source_device_id: "device-local".into(),
    };
    db.upsert_pasteboard_tombstone(&tombstone).unwrap();
    assert_eq!(db.list_pasteboard_tombstones().unwrap(), vec![tombstone]);
    assert!(db
        .delete_pasteboard_tombstone("item-deleted", "paste_item")
        .unwrap());
    assert!(db.list_pasteboard_tombstones().unwrap().is_empty());
}
