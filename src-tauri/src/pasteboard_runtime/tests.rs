use super::support::{looks_sensitive, prefer_kind, safe_blob_path};
use atools_core::PasteboardItemKind;
use std::path::Path;
#[test]
fn luhn_filter_rejects_cards_but_not_regular_numbers() {
    assert!(looks_sensitive("4242 4242 4242 4242"));
    assert!(!looks_sensitive("build 202607210001"));
}

#[test]
fn snapshot_kind_prefers_files_and_images_over_text() {
    assert_eq!(
        prefer_kind(PasteboardItemKind::Text, PasteboardItemKind::Image),
        PasteboardItemKind::Image
    );
    assert_eq!(
        prefer_kind(PasteboardItemKind::Image, PasteboardItemKind::Files),
        PasteboardItemKind::Files
    );
}

#[test]
fn blob_paths_reject_parent_components() {
    assert!(safe_blob_path(Path::new("/tmp/blobs"), "../secret").is_err());
    assert!(safe_blob_path(Path::new("/tmp/blobs"), "ab/hash.png").is_ok());
}

#[test]
fn legacy_projection_uses_only_exact_plain_text_payload() {
    use super::capture::legacy_history_text;
    let payload = serde_json::json!({"text": "\n原样 text\n", "previewText": "preview"});
    assert_eq!(
        legacy_history_text(PasteboardItemKind::Text, &payload),
        Some("\n原样 text\n")
    );
    assert_eq!(
        legacy_history_text(PasteboardItemKind::Html, &payload),
        None
    );
    assert_eq!(legacy_history_text(PasteboardItemKind::Url, &payload), None);
    assert_eq!(
        legacy_history_text(
            PasteboardItemKind::Text,
            &serde_json::json!({"previewText": "preview"})
        ),
        None
    );
}

#[test]
fn legacy_projection_retention_uses_180_day_default_and_explicit_setting() {
    use super::model::PasteboardRuntimeSettings;
    use atools_core::Database;

    let db = Database::in_memory().unwrap();
    let copied_at = atools_core::utils::iso_days_ago(120);
    db.record_clipboard_text("older legacy row", &copied_at)
        .unwrap();

    let missing = PasteboardRuntimeSettings::from_value(&serde_json::json!({}));
    let partial = PasteboardRuntimeSettings::from_value(&serde_json::json!({
        "pasteboardCapturePaused": true
    }));
    assert_eq!(missing.retention_days, 180);
    assert_eq!(partial.retention_days, 180);
    assert_eq!(missing.legacy_history_retention_days, 180);
    assert_eq!(partial.legacy_history_retention_days, 180);
    let default_cutoff = atools_core::utils::iso_days_ago(partial.legacy_history_retention_days);
    assert_eq!(db.prune_clipboard_history(&default_cutoff).unwrap(), 0);
    assert_eq!(
        db.search_clipboard_history("older legacy row", 10)
            .unwrap()
            .len(),
        1
    );

    let explicit = PasteboardRuntimeSettings::from_value(&serde_json::json!({
        "clipboardRetentionDays": 30
    }));
    assert_eq!(explicit.retention_days, 30);
    assert_eq!(explicit.legacy_history_retention_days, 30);
    let explicit_cutoff = atools_core::utils::iso_days_ago(explicit.legacy_history_retention_days);
    assert_eq!(db.prune_clipboard_history(&explicit_cutoff).unwrap(), 1);
    assert!(db
        .search_clipboard_history("older legacy row", 10)
        .unwrap()
        .is_empty());
}
