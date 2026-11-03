use super::super::super::pasteboard::{PasteboardBlob, PasteboardItem, PasteboardItemKind};
use super::*;
use serde_json::{json, Value};

const T0: &str = "2026-10-23T10:00:00Z";

fn item(id: &str, kind: PasteboardItemKind, pinned: bool) -> PasteboardItem {
    PasteboardItem {
        id: id.to_string(),
        kind,
        title: Some(id.to_string()),
        source_app: None,
        source_device_id: "test-device".to_string(),
        copied_at: T0.to_string(),
        updated_at: T0.to_string(),
        content_fingerprint: format!("fingerprint-{id}"),
        payload: json!({"fixture": true}),
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned,
        field_clocks: json!({}),
    }
}

fn media_path(leaf: &str) -> String {
    std::env::temp_dir()
        .join(leaf)
        .to_string_lossy()
        .into_owned()
}

fn image_payload(leaf: &str) -> Value {
    json!({
        "imagePath": media_path(leaf),
        "byteSize": 123,
        "preview": "image fixture"
    })
}

fn record_image(db: &Database, item_id: &str, copied_at: &str, cutoff: &str) {
    db.upsert_pasteboard_item(&item(item_id, PasteboardItemKind::Image, true))
        .unwrap();
    db.record_clipboard_media_projection(
        item_id,
        "image",
        &image_payload("atools-history-image.png"),
        copied_at,
        cutoff,
    )
    .unwrap();
}

#[test]
fn plugin_clipboard_history_merges_pages_in_stable_order_and_escapes_wildcards() {
    let db = Database::in_memory().unwrap();
    let image_item = item("shelf-image", PasteboardItemKind::Image, true);
    let file_item = item("shelf-file", PasteboardItemKind::Files, false);
    db.upsert_pasteboard_item(&image_item).unwrap();
    db.upsert_pasteboard_item(&file_item).unwrap();
    db.record_clipboard_media_projection(
        &image_item.id,
        "image",
        &image_payload("merged-image.png"),
        T0,
        "2026-10-22T00:00:00Z",
    )
    .unwrap();
    db.record_clipboard_media_projection(
        &file_item.id,
        "file",
        &json!({
            "files": [{"path": media_path("merged-file.txt"), "name": "merged-file.txt"}],
            "preview": "file fixture"
        }),
        T0,
        "2026-10-22T00:00:00Z",
    )
    .unwrap();
    let text = db
        .record_clipboard_text("literal 100% and _ marker", T0)
        .unwrap();

    let first = db.plugin_clipboard_history_page("", 1, 2).unwrap();
    let second = db.plugin_clipboard_history_page("", 2, 2).unwrap();
    let image_path = media_path("merged-image.png");
    let file_path = media_path("merged-file.txt");
    assert_eq!(first.total, 3);
    assert_eq!(second.total, 3);
    assert_eq!(first.items.len(), 2);
    assert_eq!(second.items.len(), 1);
    let ids = first
        .items
        .iter()
        .chain(second.items.iter())
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    let mut sorted = ids.clone();
    sorted.sort_by(|left, right| right.cmp(left));
    assert_eq!(ids, sorted);
    assert!(ids.contains(&text.id));
    assert!(first
        .items
        .iter()
        .chain(second.items.iter())
        .any(|entry| entry.kind == "image"
            && entry.id.starts_with("clip-image-")
            && entry.payload["imagePath"].as_str() == Some(image_path.as_str())
            && entry.payload.get("binary").is_none()));
    assert!(ids.iter().any(|id| id.starts_with("clip-file-")));
    let file = first
        .items
        .iter()
        .chain(second.items.iter())
        .find(|entry| entry.kind == "file")
        .unwrap();
    assert_eq!(
        file.payload["files"][0]["path"].as_str(),
        Some(file_path.as_str())
    );
    assert!(file.payload.get("binary").is_none());

    assert_eq!(
        db.plugin_clipboard_history_page("100%", 1, 10)
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        db.plugin_clipboard_history_page("100_", 1, 10)
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        db.plugin_clipboard_history_page("merged-file.txt", 1, 10)
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        db.plugin_clipboard_history_content(&text.id)
            .unwrap()
            .unwrap()
            .payload["content"],
        "literal 100% and _ marker"
    );
}

#[test]
fn plugin_clipboard_history_clear_delete_and_fk_leave_shelf_blobs_untouched() {
    let db = Database::in_memory().unwrap();
    let image = item("shelf-image-clear", PasteboardItemKind::Image, true);
    let file = item("shelf-file-clear", PasteboardItemKind::Files, false);
    db.upsert_pasteboard_item(&image).unwrap();
    db.upsert_pasteboard_item(&file).unwrap();
    let blob = PasteboardBlob {
        id: "blob-clear-image".into(),
        content_hash: "hash-clear-image".into(),
        relative_path: "images/clear.png".into(),
        media_type: "image/png".into(),
        byte_size: 10,
        created_at: T0.into(),
        last_accessed_at: T0.into(),
    };
    db.upsert_pasteboard_blob(&blob).unwrap();
    db.link_pasteboard_blob(&image.id, &blob.id).unwrap();
    db.record_clipboard_media_projection(
        &image.id,
        "image",
        &image_payload("clear-image.png"),
        T0,
        "2026-10-22T00:00:00Z",
    )
    .unwrap();
    db.record_clipboard_media_projection(
        &file.id,
        "file",
        &json!({"files": [{"path": media_path("clear-file.txt")}], "preview": "file"}),
        T0,
        "2026-10-22T00:00:00Z",
    )
    .unwrap();
    db.record_clipboard_text("text row", T0).unwrap();

    assert_eq!(db.clear_plugin_clipboard_history(Some("image")).unwrap(), 1);
    assert!(!db
        .plugin_clipboard_history_projection_exists(&image.id, "image")
        .unwrap());
    assert!(db
        .plugin_clipboard_history_projection_exists(&file.id, "file")
        .unwrap());
    assert!(db.get_pasteboard_item(&image.id).unwrap().unwrap().pinned);
    assert!(db.get_pasteboard_blob(&blob.id).unwrap().is_some());
    assert_eq!(db.clear_plugin_clipboard_history(Some("text")).unwrap(), 1);
    assert_eq!(
        db.plugin_clipboard_history_page("", 1, 10)
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(db.clear_plugin_clipboard_history(None).unwrap(), 1);
    assert_eq!(
        db.plugin_clipboard_history_page("", 1, 10).unwrap().total,
        0
    );
    assert!(db.get_pasteboard_item(&file.id).unwrap().is_some());
    assert!(db.get_pasteboard_item(&image.id).unwrap().is_some());
    assert!(db.get_pasteboard_blob(&blob.id).unwrap().is_some());

    let fk_db = Database::in_memory().unwrap();
    record_image(&fk_db, "shelf-image-fk", T0, "2026-10-22T00:00:00Z");
    assert!(fk_db
        .plugin_clipboard_history_projection_exists("shelf-image-fk", "image")
        .unwrap());
    assert!(fk_db.delete_pasteboard_item("shelf-image-fk").unwrap());
    assert!(!fk_db
        .plugin_clipboard_history_projection_exists("shelf-image-fk", "image")
        .unwrap());
    assert_eq!(
        fk_db
            .plugin_clipboard_history_page("", 1, 10)
            .unwrap()
            .total,
        0
    );
}

#[test]
fn stale_reprojection_removes_only_its_projection_and_keeps_pinned_shelf_item() {
    let db = Database::in_memory().unwrap();
    let shelf = item("pinned-stale-image", PasteboardItemKind::Image, true);
    db.upsert_pasteboard_item(&shelf).unwrap();
    let blob = PasteboardBlob {
        id: "blob-stale-image".into(),
        content_hash: "hash-stale-image".into(),
        relative_path: "images/stale.png".into(),
        media_type: "image/png".into(),
        byte_size: 10,
        created_at: T0.into(),
        last_accessed_at: T0.into(),
    };
    db.upsert_pasteboard_blob(&blob).unwrap();
    db.link_pasteboard_blob(&shelf.id, &blob.id).unwrap();
    db.record_clipboard_media_projection(
        &shelf.id,
        "image",
        &image_payload("pinned-stale.png"),
        T0,
        T0,
    )
    .unwrap();
    assert!(db
        .plugin_clipboard_history_projection_exists(&shelf.id, "image")
        .unwrap());

    db.record_clipboard_media_projection(
        &shelf.id,
        "image",
        &image_payload("pinned-stale.png"),
        "2026-10-22T09:00:00Z",
        T0,
    )
    .unwrap();

    assert!(!db
        .plugin_clipboard_history_projection_exists(&shelf.id, "image")
        .unwrap());
    assert!(db.get_pasteboard_item(&shelf.id).unwrap().unwrap().pinned);
    assert!(db.get_pasteboard_blob(&blob.id).unwrap().is_some());
    assert_eq!(
        db.plugin_clipboard_history_page("", 1, 10).unwrap().total,
        0
    );
}

#[test]
fn plugin_clipboard_media_validation_rejects_bad_paths_counts_sizes_and_previews() {
    let db = Database::in_memory().unwrap();
    let base_item = item("validations", PasteboardItemKind::Image, false);
    db.upsert_pasteboard_item(&base_item).unwrap();
    let cutoff = "2026-10-22T00:00:00Z";
    let path = media_path("valid.png");
    let mut bad_payloads = vec![
        json!({"imagePath":"relative.png","preview":"bad"}),
        json!({"imagePath":format!("{}{}", media_path(""), "x".repeat(8192)),"preview":"bad"}),
        json!({"imagePath":path,"byteSize":-1,"preview":"bad"}),
        json!({"imagePath":path,"byteSize":9_007_199_254_740_992u64,"preview":"bad"}),
        json!({"imagePath":path,"preview":"x".repeat(257)}),
        json!({"imagePath":format!("{}\0bad", media_path("")),"preview":"bad"}),
    ];
    for payload in bad_payloads.drain(..) {
        assert!(db
            .record_clipboard_media_projection("validations", "image", &payload, T0, cutoff)
            .is_err());
    }
    assert!(db
        .record_clipboard_media_projection(
            "missing-item",
            "image",
            &image_payload("orphan.png"),
            T0,
            cutoff,
        )
        .is_err());

    db.upsert_pasteboard_item(&item("file-validation", PasteboardItemKind::Files, false))
        .unwrap();
    for payload in [
        json!({"files": [], "preview": "empty"}),
        json!({"files": (0..21).map(|i| json!({"path": media_path(&format!("file-{i}"))})).collect::<Vec<_>>(), "preview": "count"}),
        json!({"files": [{"path":"relative.txt"}], "preview": "relative"}),
        json!({"files": [{"path":path}, {"path":path}], "preview": "duplicate"}),
        json!({"files": (0..17).map(|i| json!({"path": std::env::temp_dir().join(format!("{}-{i}", "x".repeat(4090))).to_string_lossy()})).collect::<Vec<_>>(), "preview": "aggregate"}),
    ] {
        assert!(db
            .record_clipboard_media_projection("file-validation", "file", &payload, T0, cutoff)
            .is_err());
    }
    assert!(db
        .record_clipboard_media_projection(
            "file-validation",
            "files",
            &json!({"files": [{"path":path}], "preview":"wrong kind"}),
            T0,
            cutoff,
        )
        .is_err());
}

#[test]
fn plugin_clipboard_history_enforces_item_and_serialized_response_budgets() {
    use super::super::clipboard_history::CLIPBOARD_HISTORY_TEXT_BYTES_MAX;

    let item_db = Database::in_memory().unwrap();
    let oversized_text = "x".repeat(CLIPBOARD_HISTORY_TEXT_BYTES_MAX + 1);
    let oversized_item = item_db.record_clipboard_text(&oversized_text, T0).unwrap();
    assert!(item_db.plugin_clipboard_history_page("", 1, 10).is_err());
    assert!(item_db
        .plugin_clipboard_history_content(&oversized_item.id)
        .is_err());

    let serialized_db = Database::in_memory().unwrap();
    let escaped_text = "\"".repeat(140 * 1024);
    let first = format!("{escaped_text}a");
    let second = format!("{escaped_text}b");
    assert!(first.len() + second.len() < 512 * 1024);
    serialized_db.record_clipboard_text(&first, T0).unwrap();
    serialized_db
        .record_clipboard_text(&second, "2026-10-23T10:01:00Z")
        .unwrap();
    assert!(serialized_db
        .plugin_clipboard_history_page("", 1, 2)
        .is_err());
}
