use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, PasteboardSourceApp};
use atools_lib::pasteboard_runtime::{
    CaptureOutcome, NativePasteboardRepresentation, NativePasteboardSnapshot, PasteboardBackend,
    PasteboardRuntime,
};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

#[derive(Default)]
struct FakeBackend {
    snapshots: Mutex<VecDeque<NativePasteboardSnapshot>>,
    writes: Mutex<Vec<(String, bool)>>,
    paste_error: Mutex<Option<String>>,
}

#[async_trait]
impl PasteboardBackend for FakeBackend {
    async fn snapshot_if_changed(
        &self,
        previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        let mut snapshots = self.snapshots.lock();
        if snapshots
            .front()
            .is_some_and(|snapshot| snapshot.change_count == previous_change_count)
        {
            return Ok(None);
        }
        Ok(snapshots.pop_front())
    }

    async fn write_item(
        &self,
        item: &PasteboardItem,
        _blob_root: &Path,
        plain_text: bool,
    ) -> Result<(), String> {
        self.writes.lock().push((item.id.clone(), plain_text));
        Ok(())
    }

    async fn paste_frontmost(&self) -> Result<(), String> {
        self.paste_error.lock().clone().map_or(Ok(()), Err)
    }
}

fn snapshot(change_count: i64, text: &str, bundle_id: &str) -> NativePasteboardSnapshot {
    NativePasteboardSnapshot {
        change_count,
        copied_at: atools_core::utils::now_iso(),
        source_app: Some(PasteboardSourceApp {
            bundle_id: Some(bundle_id.into()),
            name: Some("Fixture".into()),
        }),
        is_confidential: false,
        is_transient: false,
        representations: vec![NativePasteboardRepresentation::Text(text.into())],
    }
}

fn runtime() -> (
    tempfile::TempDir,
    Arc<Database>,
    Arc<FakeBackend>,
    PasteboardRuntime,
) {
    let temp = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().to_path_buf());
    config.ensure_dirs().unwrap();
    let db = Arc::new(Database::open(&config.db_path()).unwrap());
    let backend = Arc::new(FakeBackend::default());
    let runtime = PasteboardRuntime::new(backend.clone(), db.clone(), &config).unwrap();
    (temp, db, backend, runtime)
}

#[tokio::test]
async fn ignored_snapshots_are_not_persisted() {
    let (_temp, db, backend, runtime) = runtime();
    backend
        .snapshots
        .lock()
        .push_back(snapshot(1, "secret", "com.1password.1password"));

    let outcome = runtime.capture_once().await.unwrap();
    assert!(matches!(
        outcome,
        CaptureOutcome::Ignored { ref reason, .. } if reason == "ignored_application"
    ));
    assert!(db
        .search_pasteboard_items("", None, &[], 20, 0)
        .unwrap()
        .is_empty());
    assert_eq!(db.clipboard_history_page("", 1, 1000).unwrap().total, 0);
}

#[tokio::test]
async fn duplicate_content_updates_one_item_instead_of_growing_history() {
    let (_temp, db, backend, runtime) = runtime();
    backend
        .snapshots
        .lock()
        .push_back(snapshot(1, "hello", "com.apple.TextEdit"));
    let second_snapshot = snapshot(2, "hello", "com.apple.TextEdit");
    let second_copied_at = second_snapshot.copied_at.clone();
    backend.snapshots.lock().push_back(second_snapshot);

    let first = runtime.capture_once().await.unwrap();
    let second = runtime.capture_once().await.unwrap();
    let first_id = first.changed_item_id().unwrap().to_string();
    assert!(matches!(second, CaptureOutcome::Updated { .. }));
    assert_eq!(second.changed_item_id(), Some(first_id.as_str()));
    let items = db.search_pasteboard_items("", None, &[], 20, 0).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].copied_at, second_copied_at);
}

#[tokio::test]
async fn sensitive_card_content_is_filtered_before_storage() {
    let (_temp, db, backend, runtime) = runtime();
    backend
        .snapshots
        .lock()
        .push_back(snapshot(1, "4242 4242 4242 4242", "com.apple.TextEdit"));

    let outcome = runtime.capture_once().await.unwrap();
    assert!(matches!(
        outcome,
        CaptureOutcome::Ignored { ref reason, .. } if reason == "sensitive_content"
    ));
    assert!(db
        .search_pasteboard_items("", None, &[], 20, 0)
        .unwrap()
        .is_empty());
    assert_eq!(db.clipboard_history_page("", 1, 1000).unwrap().total, 0);
}

#[tokio::test]
async fn failed_direct_paste_keeps_copy_and_returns_accessibility_warning() {
    let (_temp, db, backend, runtime) = runtime();
    backend
        .snapshots
        .lock()
        .push_back(snapshot(1, "hello", "com.apple.TextEdit"));
    let item_id = runtime
        .capture_once()
        .await
        .unwrap()
        .changed_item_id()
        .unwrap()
        .to_string();
    *backend.paste_error.lock() = Some("Accessibility permission required".into());

    let outcome = runtime.paste_item(&item_id, true).await.unwrap();
    assert!(outcome.copied);
    assert!(!outcome.pasted);
    assert_eq!(
        outcome.warning_code.as_deref(),
        Some("accessibility_required")
    );
    assert_eq!(backend.writes.lock().as_slice(), &[(item_id, true)]);
    assert_eq!(
        db.search_pasteboard_items("", None, &[], 20, 0)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn image_capture_creates_a_lightweight_thumbnail_blob() {
    let (temp, db, backend, runtime) = runtime();
    let mut png = Vec::new();
    image::DynamicImage::new_rgba8(64, 64)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    backend
        .snapshots
        .lock()
        .push_back(NativePasteboardSnapshot {
            change_count: 1,
            copied_at: atools_core::utils::now_iso(),
            source_app: None,
            is_confidential: false,
            is_transient: false,
            representations: vec![NativePasteboardRepresentation::Image {
                bytes: png,
                media_type: "image/png".into(),
            }],
        });

    let item_id = runtime
        .capture_once()
        .await
        .unwrap()
        .changed_item_id()
        .unwrap()
        .to_string();
    let item = db.get_pasteboard_item(&item_id).unwrap().unwrap();
    let thumbnail = item.payload["thumbnailBlobPath"].as_str().unwrap();
    assert!(temp
        .path()
        .join("pasteboard/blobs")
        .join(thumbnail)
        .is_file());
    assert_eq!(db.clipboard_history_page("", 1, 1000).unwrap().total, 0);
}

#[tokio::test]
async fn paste_stack_preserves_unique_queue_order_and_consumes_each_item_once() {
    let (_temp, _db, backend, runtime) = runtime();
    backend
        .snapshots
        .lock()
        .push_back(snapshot(1, "first", "com.apple.TextEdit"));
    backend
        .snapshots
        .lock()
        .push_back(snapshot(2, "second", "com.apple.TextEdit"));
    let first = runtime
        .capture_once()
        .await
        .unwrap()
        .changed_item_id()
        .unwrap()
        .to_string();
    let second = runtime
        .capture_once()
        .await
        .unwrap()
        .changed_item_id()
        .unwrap()
        .to_string();

    let status = runtime
        .set_paste_stack(vec![
            first.clone(),
            first.clone(),
            "missing-item".into(),
            second.clone(),
        ])
        .unwrap();
    assert!(status.active);
    assert_eq!(status.count, 2);
    assert_eq!(status.item_ids, vec![first.clone(), second.clone()]);
    assert_eq!(runtime.pop_paste_stack_item(), Some(first));
    assert_eq!(runtime.pop_paste_stack_item(), Some(second));
    assert_eq!(runtime.pop_paste_stack_item(), None);
    assert!(!runtime.paste_stack_status().active);

    runtime.set_paste_stack(status.item_ids).unwrap();
    assert_eq!(runtime.clear_paste_stack().count, 0);
}

fn representation_snapshot(
    change_count: i64,
    representation: NativePasteboardRepresentation,
) -> NativePasteboardSnapshot {
    NativePasteboardSnapshot {
        change_count,
        copied_at: atools_core::utils::now_iso(),
        source_app: None,
        is_confidential: false,
        is_transient: false,
        representations: vec![representation],
    }
}

#[tokio::test]
async fn capture_projects_exact_unicode_text_and_native_timestamp_to_legacy_history() {
    let (_temp, db, backend, runtime) = runtime();
    let content = "\n你好，剪贴板 🧪\n保留原始换行\n";
    let captured = snapshot(41, content, "com.apple.TextEdit");
    let copied_at = captured.copied_at.clone();
    backend.snapshots.lock().push_back(captured.clone());

    let outcome = runtime.capture_once().await.unwrap();
    assert!(matches!(outcome, CaptureOutcome::Captured { change_count: 41, .. }));
    assert!(outcome.legacy_text_projected());
    assert_eq!(runtime.status().last_change_count, 41);
    let page = db.clipboard_history_page("", 1, 10).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].content, content);
    assert_eq!(page.items[0].timestamp, copied_at);
    let marker = db
        .get_setting(&format!("pasteboard.clipboard_projection.{}", runtime.device_id()))
        .unwrap()
        .unwrap();
    assert!(!marker.contains(content));
}

#[tokio::test]
async fn paused_confidential_and_transient_text_never_enters_legacy_history() {
    let (_temp, db, backend, runtime) = runtime();
    db.set_setting(
        "settings-general",
        &serde_json::json!({"pasteboardCapturePaused": true}).to_string(),
    )
    .unwrap();
    backend
        .snapshots
        .lock()
        .push_back(snapshot(51, "paused text", "com.apple.TextEdit"));
    let paused = runtime.capture_once().await.unwrap();
    assert!(matches!(paused, CaptureOutcome::Paused { .. }));
    assert!(!paused.legacy_text_projected());

    db.set_setting(
        "settings-general",
        &serde_json::json!({"pasteboardCapturePaused": false}).to_string(),
    )
    .unwrap();
    for (change_count, confidential, transient) in [(52, true, false), (53, false, true)] {
        let mut value = snapshot(change_count, "filtered text", "com.apple.TextEdit");
        value.is_confidential = confidential;
        value.is_transient = transient;
        backend.snapshots.lock().push_back(value);
        let outcome = runtime.capture_once().await.unwrap();
        assert!(matches!(outcome, CaptureOutcome::Ignored { .. }));
        assert!(!outcome.legacy_text_projected());
    }
    assert_eq!(db.clipboard_history_page("", 1, 1000).unwrap().total, 0);
}

#[tokio::test]
async fn rich_and_unbounded_text_captures_do_not_project_preview_or_partial_content() {
    let (_temp, db, backend, runtime) = runtime();
    let too_large = "x".repeat(atools_core::db::CLIPBOARD_HISTORY_TEXT_BYTES_MAX + 1);
    let representations = [
        NativePasteboardRepresentation::Html("<p>html only</p>".into()),
        NativePasteboardRepresentation::Url("https://example.test/path".into()),
        NativePasteboardRepresentation::Files(vec!["/tmp/a.txt".into()]),
        NativePasteboardRepresentation::Text(" \n\t ".into()),
        NativePasteboardRepresentation::Text(too_large),
    ];
    for (index, representation) in representations.into_iter().enumerate() {
        backend
            .snapshots
            .lock()
            .push_back(representation_snapshot(61 + index as i64, representation));
        let outcome = runtime.capture_once().await.unwrap();
        assert!(matches!(outcome, CaptureOutcome::Captured { .. }));
        assert!(!outcome.legacy_text_projected());
    }
    assert_eq!(db.search_pasteboard_items("", None, &[], 20, 0).unwrap().len(), 5);
    assert_eq!(db.clipboard_history_page("", 1, 1000).unwrap().total, 0);
}
