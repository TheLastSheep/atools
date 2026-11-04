use super::super::clipboard_history::CLIPBOARD_HISTORY_TEXT_BYTES_MAX;
use super::*;

#[test]
fn test_clipboard_history_record_search_and_prune() {
    let db = Database::in_memory().unwrap();

    let first = db
        .record_clipboard_text("Invoice API key copied", "2026-06-01T10:00:00Z")
        .unwrap();
    let duplicate = db
        .record_clipboard_text("Invoice API key copied", "2026-06-01T10:05:00Z")
        .unwrap();
    db.record_clipboard_text("Build error log", "2026-06-02T10:00:00Z")
        .unwrap();

    assert_eq!(first.id, duplicate.id);
    assert_eq!(duplicate.used_count, 2);
    assert_eq!(duplicate.last_copied_at, "2026-06-01T10:05:00Z");

    let matches = db.search_clipboard_history("api", 10).unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].text, "Invoice API key copied");
    assert_eq!(matches[0].used_count, 2);

    let recent = db.search_clipboard_history("", 10).unwrap();
    assert_eq!(
        recent
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        vec!["Build error log", "Invoice API key copied"]
    );

    let removed = db.prune_clipboard_history("2026-06-02T00:00:00Z").unwrap();
    assert_eq!(removed, 1);
    let remaining = db.search_clipboard_history("", 10).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].text, "Build error log");

    let exported = db.export_clipboard_history_json(10).unwrap();
    let exported_json: serde_json::Value = serde_json::from_str(&exported).unwrap();
    assert_eq!(exported_json["count"], 1);
    assert_eq!(exported_json["entries"][0]["text"], "Build error log");

    assert_eq!(db.clear_clipboard_history().unwrap(), 1);
    assert!(db.search_clipboard_history("", 10).unwrap().is_empty());
}

#[test]
fn test_attachment_operations() {
    let db = Database::in_memory().unwrap();
    let plugin_id = "attach-plugin";

    let plugin = create_test_plugin(plugin_id, "Attach Plugin");
    db.save_plugin(&plugin).unwrap();

    let doc = Document {
        id: "doc1".to_string(),
        rev: None,
        data: serde_json::json!({"type": "document"}),
    };
    db.plugin_data_put(plugin_id, &doc).unwrap();

    // Create
    let data = b"image binary data";
    db.put_attachment(plugin_id, "doc1", "image.png", data, "image/png")
        .unwrap();

    // Read
    let (retrieved_data, content_type) = db
        .get_attachment(plugin_id, "doc1", "image.png")
        .unwrap()
        .unwrap();
    assert_eq!(retrieved_data, data);
    assert_eq!(content_type, "image/png");

    // Update
    let new_data = b"updated binary data";
    db.put_attachment(plugin_id, "doc1", "image.png", new_data, "image/png")
        .unwrap();
    let (re_retrieved, _) = db
        .get_attachment(plugin_id, "doc1", "image.png")
        .unwrap()
        .unwrap();
    assert_eq!(re_retrieved, new_data);

    // Delete
    assert!(db
        .delete_attachment(plugin_id, "doc1", "image.png")
        .unwrap());
    assert!(db
        .get_attachment(plugin_id, "doc1", "image.png")
        .unwrap()
        .is_none());
    assert!(!db
        .delete_attachment(plugin_id, "doc1", "nonexistent.png")
        .unwrap());
}

#[test]
fn test_cascade_delete() {
    let db = Database::in_memory().unwrap();
    let plugin_id = "cascade-plugin";

    let plugin = create_test_plugin(plugin_id, "Cascade Plugin");
    db.save_plugin(&plugin).unwrap();

    // Add features
    db.index_features(plugin_id, &[create_test_feature("feat1")])
        .unwrap();

    // Add documents
    let doc = Document {
        id: "doc1".to_string(),
        rev: None,
        data: serde_json::json!({"data": "test"}),
    };
    db.plugin_data_put(plugin_id, &doc).unwrap();

    // Add attachment
    db.put_attachment(plugin_id, "doc1", "file.txt", b"data", "text/plain")
        .unwrap();

    // Delete plugin should cascade
    db.delete_plugin(plugin_id).unwrap();

    assert!(db.get_plugin(plugin_id).is_err());
    assert!(db.get_feature("feat1").is_err());
    assert!(db.plugin_data_get(plugin_id, "doc1").unwrap().is_none());
    assert!(db
        .get_attachment(plugin_id, "doc1", "file.txt")
        .unwrap()
        .is_none());
}

#[test]
fn clipboard_history_page_is_bounded_stable_and_counts_with_its_page() {
    let db = Database::in_memory().unwrap();
    db.record_clipboard_text("alpha % token", "2026-06-01T10:00:00Z")
        .unwrap();
    db.record_clipboard_text("beta _ token", "2026-06-02T10:00:00Z")
        .unwrap();
    db.record_clipboard_text("gamma token", "2026-06-02T10:00:00Z")
        .unwrap();

    let page = db.clipboard_history_page("token", 1, 2).unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(page.page, 1);
    assert_eq!(page.page_size, 2);
    assert_eq!(page.items.len(), 2);
    assert!(page.items.iter().all(|item| item.r#type == "text"));
    assert_eq!(page.items[0].timestamp, "2026-06-02T10:00:00Z");
    assert!(page
        .items
        .iter()
        .any(|item| item.content == "gamma token" && item.preview == "gamma token"));
    assert!(page.items[0].id > page.items[1].id);
    assert_eq!(db.clipboard_history_page("%", 1, 10).unwrap().total, 1);
    assert_eq!(db.clipboard_history_page("_", 1, 10).unwrap().total, 1);
    assert_eq!(db.clipboard_history_page("", 2, 2).unwrap().items.len(), 1);
}

#[test]
fn clipboard_history_page_returns_full_rows_and_rejects_content_overflow() {
    let db = Database::in_memory().unwrap();
    let long_unicode = "🧪line\n".repeat(60);
    db.record_clipboard_text(&long_unicode, "2026-06-01T10:00:00Z")
        .unwrap();
    let page = db.clipboard_history_page("", 1, 10).unwrap();
    assert_eq!(page.items[0].content, long_unicode);
    assert_eq!(
        page.items[0].preview,
        long_unicode.chars().take(256).collect::<String>()
    );

    let aggregate_db = Database::in_memory().unwrap();
    let exact_row = "a".repeat(CLIPBOARD_HISTORY_TEXT_BYTES_MAX);
    aggregate_db
        .record_clipboard_text(&exact_row, "2026-06-01T08:00:00Z")
        .unwrap();
    let second_row = "b".repeat(CLIPBOARD_HISTORY_TEXT_BYTES_MAX);
    aggregate_db
        .record_clipboard_text(&second_row, "2026-06-01T09:00:00Z")
        .unwrap();
    let exact_page = aggregate_db.clipboard_history_page("", 1, 2).unwrap();
    assert_eq!(exact_page.items.len(), 2);
    assert_eq!(exact_page.items[0].content, second_row);
    assert_eq!(exact_page.items[1].content, exact_row);

    aggregate_db
        .record_clipboard_text("small third row", "2026-06-01T10:00:00Z")
        .unwrap();
    assert!(aggregate_db.clipboard_history_page("", 1, 3).is_err());

    let oversized_db = Database::in_memory().unwrap();
    let oversized = "x".repeat(CLIPBOARD_HISTORY_TEXT_BYTES_MAX + 1);
    oversized_db
        .record_clipboard_text(&oversized, "2026-06-01T10:00:00Z")
        .unwrap();
    assert!(oversized_db.clipboard_history_page("", 1, 10).is_err());
}

#[test]
fn clipboard_history_page_and_full_text_enforce_independent_limits() {
    let db = Database::in_memory().unwrap();
    let exact_text = "🧪".repeat(65_536);
    let exact_entry = db
        .record_clipboard_text(&exact_text, "2026-06-01T09:00:00Z")
        .unwrap();
    assert_eq!(
        db.clipboard_history_text(&exact_entry.id)
            .unwrap()
            .unwrap()
            .text,
        exact_text
    );
    let long_text = "🧪".repeat(65_537);
    let entry = db
        .record_clipboard_text(&long_text, "2026-06-01T10:00:00Z")
        .unwrap();
    assert!(db.clipboard_history_page("", 1, 1).is_err());
    let page = db.clipboard_history_page("🧪", 2, 1).unwrap();
    assert_eq!(page.items[0].preview.chars().count(), 256);
    assert_eq!(page.items[0].content, exact_text);
    assert!(db.clipboard_history_text(&entry.id).is_err());

    assert!(db.clipboard_history_page(&"q".repeat(257), 1, 1).is_err());
    assert!(db.clipboard_history_page(&"界".repeat(86), 1, 1).is_err());
    assert!(db.clipboard_history_page("", 0, 1).is_err());
    assert!(db.clipboard_history_page("", 1, 0).is_err());
    assert!(db.clipboard_history_page("", 1, 101).is_err());
    assert!(db.clipboard_history_page("", 10_000_002, 1).is_err());
    assert!(db.clipboard_history_text("clip-INVALID0000000").is_err());
}

#[test]
fn clipboard_history_content_and_delete_are_exact_and_non_mutating_on_rejection() {
    let db = Database::in_memory().unwrap();
    let entry = db
        .record_clipboard_text("selected secret text", "2026-06-01T10:00:00Z")
        .unwrap();
    let content = db.clipboard_history_text(&entry.id).unwrap().unwrap();
    assert_eq!(content.text, "selected secret text");
    assert_eq!(content.last_copied_at, "2026-06-01T10:00:00Z");
    assert!(db
        .clipboard_history_text("clip-aaaaaaaaaaaaaaaa")
        .unwrap()
        .is_none());

    assert!(db.delete_clipboard_history_item("invalid").is_err());
    assert_eq!(db.clipboard_history_page("", 1, 10).unwrap().total, 1);
    assert!(db.delete_clipboard_history_item(&entry.id).unwrap());
    assert!(!db.delete_clipboard_history_item(&entry.id).unwrap());
    assert_eq!(db.clipboard_history_page("", 1, 10).unwrap().total, 0);
}

#[test]
fn clipboard_history_preserves_raw_text_and_deduplicates_only_exact_bytes() {
    let db = Database::in_memory().unwrap();
    let raw = " \n🧪wrapped text \t\n";
    let first = db
        .record_clipboard_text(raw, "2026-06-01T10:00:00Z")
        .unwrap();
    let repeated = db
        .record_clipboard_text(raw, "2026-06-01T10:01:00Z")
        .unwrap();
    let trimmed = db
        .record_clipboard_text("🧪wrapped text", "2026-06-01T10:02:00Z")
        .unwrap();

    assert_eq!(first.id, repeated.id);
    assert_ne!(first.id, trimmed.id);
    assert_eq!(repeated.text, raw);
    assert_eq!(repeated.used_count, 2);
    assert_eq!(repeated.last_copied_at, "2026-06-01T10:01:00Z");
    assert_eq!(trimmed.text, "🧪wrapped text");

    let page = db.clipboard_history_page("wrapped", 1, 10).unwrap();
    assert!(page
        .items
        .iter()
        .any(|item| item.id == first.id && item.content == raw));
    assert!(page
        .items
        .iter()
        .any(|item| item.id == trimmed.id && item.content == "🧪wrapped text"));
    assert!(db
        .record_clipboard_text(" \n\t", "2026-06-01T10:03:00Z")
        .is_err());
}

#[test]
fn clipboard_history_preview_preserves_embedded_nul_and_unicode() {
    let db = Database::in_memory().unwrap();
    let text = "a\0b🧪\n";
    let entry = db
        .record_clipboard_text(text, "2026-06-01T10:04:00Z")
        .unwrap();

    let stored = db.clipboard_history_text(&entry.id).unwrap().unwrap();
    assert_eq!(stored.text, text);
    let page = db.clipboard_history_page("", 1, 10).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].content, text);
    assert_eq!(page.items[0].preview, text);
}

#[test]
fn clipboard_history_page_supports_bounded_1000_item_reads() {
    let db = Database::in_memory().unwrap();
    for index in 0..101 {
        db.record_clipboard_text(&format!("bounded-row-{index:03}"), "2026-06-01T10:00:00Z")
            .unwrap();
    }
    let page = db.clipboard_history_page("bounded-row", 1, 1000).unwrap();
    assert_eq!(page.total, 101);
    assert_eq!(page.items.len(), 101);
    assert!(db.clipboard_history_page("", 1, 1001).is_err());
}

#[test]
fn clipboard_capture_projection_is_transactional_and_retry_idempotent() {
    let db = Database::in_memory().unwrap();
    let text = "\n你好 🧪 exact text\n";
    let copied_at = "2026-10-22T10:00:00Z";
    let fingerprint = "a".repeat(64);
    db.record_clipboard_text("expired entry", "2025-01-01T00:00:00Z")
        .unwrap();
    let project = |epoch: &str, change_count: i64| {
        db.record_clipboard_capture_projection(
            text,
            copied_at,
            "device-test",
            epoch,
            change_count,
            &fingerprint,
            "2026-01-01T00:00:00Z",
        )
        .unwrap()
    };

    assert!(project("epoch-a", 41));
    assert!(!project("epoch-a", 41));
    let page = db.clipboard_history_page("", 1, 10).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].content, text);
    assert_eq!(
        db.search_clipboard_history("expired entry", 10)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(page.items[0].timestamp, copied_at);
    assert_eq!(
        db.clipboard_history_text(&page.items[0].id)
            .unwrap()
            .unwrap()
            .used_count,
        1
    );

    // A later capture increments once; a new runtime epoch records a reused OS count again.
    assert!(project("epoch-a", 42));
    assert!(project("epoch-b", 41));
    assert!(!project("epoch-b", 41));
    let entry = db
        .clipboard_history_text(&page.items[0].id)
        .unwrap()
        .unwrap();
    assert_eq!(entry.text, text);
    assert_eq!(entry.used_count, 3);
    let marker = db
        .get_setting("pasteboard.clipboard_projection.device-test")
        .unwrap()
        .unwrap();
    assert!(!marker.contains(text));
}

#[test]
fn clipboard_capture_projection_rolls_back_history_when_marker_write_fails() {
    let db = Database::in_memory().unwrap();
    db.conn
        .lock()
        .execute_batch(
            "CREATE TRIGGER fail_projection_marker BEFORE INSERT ON settings
         WHEN NEW.key LIKE 'pasteboard.clipboard_projection.%'
         BEGIN SELECT RAISE(ABORT, 'fixture marker failure'); END;",
        )
        .unwrap();
    let project = || {
        db.record_clipboard_capture_projection(
            "retry me",
            "2026-10-22T10:00:00Z",
            "device-test",
            "epoch-test",
            7,
            &"b".repeat(64),
            "2026-01-01T00:00:00Z",
        )
    };

    assert!(project().is_err());
    assert_eq!(db.clipboard_history_page("", 1, 10).unwrap().total, 0);
    db.conn
        .lock()
        .execute_batch("DROP TRIGGER fail_projection_marker;")
        .unwrap();
    assert!(project().unwrap());
    assert!(!project().unwrap());
    let page = db.clipboard_history_page("", 1, 10).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(
        db.clipboard_history_text(&page.items[0].id)
            .unwrap()
            .unwrap()
            .used_count,
        1
    );
}
