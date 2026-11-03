use super::{
    CaptureOutcome, NativePasteboardRepresentation, NativePasteboardSnapshot, PasteboardBackend,
    PasteboardRuntime,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, PasteboardSourceApp};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

#[derive(Default)]
struct FixtureBackend {
    snapshots: Mutex<VecDeque<NativePasteboardSnapshot>>,
}

#[async_trait]
impl PasteboardBackend for FixtureBackend {
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
        _item: &PasteboardItem,
        _blob_root: &Path,
        _plain_text: bool,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn paste_frontmost(&self) -> Result<(), String> {
        Ok(())
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    db: Arc<Database>,
    backend: Arc<FixtureBackend>,
    runtime: PasteboardRuntime,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().to_path_buf());
    config.ensure_dirs().unwrap();
    let db = Arc::new(Database::open(&config.db_path()).unwrap());
    let backend = Arc::new(FixtureBackend::default());
    let runtime = PasteboardRuntime::new(backend.clone(), db.clone(), &config).unwrap();
    Fixture {
        _temp: temp,
        db,
        backend,
        runtime,
    }
}

fn snapshot(
    change_count: i64,
    copied_at: String,
    representation: NativePasteboardRepresentation,
) -> NativePasteboardSnapshot {
    NativePasteboardSnapshot {
        change_count,
        copied_at,
        source_app: None,
        is_confidential: false,
        is_transient: false,
        representations: vec![representation],
    }
}

fn image_bytes() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

fn assert_history_contains(
    fixture: &Fixture,
    query: &str,
) -> atools_core::db::PluginClipboardHistoryPage {
    fixture
        .db
        .plugin_clipboard_history_page(query, 1, 20)
        .unwrap()
}

#[tokio::test]
async fn successful_legacy_text_projection_sets_both_semantic_flags() {
    let fixture = fixture();
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Text("clipboard text".into()),
    ));

    let outcome = fixture.runtime.capture_once().await.unwrap();
    assert!(outcome.legacy_text_projected());
    assert!(outcome.plugin_history_projected());
    let page = assert_history_contains(&fixture, "clipboard text");
    assert_eq!(page.total, 1);
}

#[tokio::test]
async fn image_projection_uses_the_persisted_absolute_blob_path() {
    let fixture = fixture();
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Image {
            bytes: image_bytes(),
            media_type: "image/png".into(),
        },
    ));

    let outcome = fixture.runtime.capture_once().await.unwrap();
    assert!(outcome.plugin_history_projected());
    assert!(!outcome.legacy_text_projected());
    let item_id = outcome.changed_item_id().unwrap().to_owned();
    let page = assert_history_contains(&fixture, "");
    assert_eq!(page.total, 1);
    let entry = fixture
        .db
        .plugin_clipboard_history_content(&page.items[0].id)
        .unwrap()
        .unwrap();
    assert_eq!(entry.kind, "image");
    let image_path = entry.payload["imagePath"].as_str().unwrap();
    assert!(Path::new(image_path).is_absolute());
    assert!(Path::new(image_path).is_file());
    assert!(fixture.db.get_pasteboard_item(&item_id).unwrap().is_some());
}

#[tokio::test]
async fn file_projection_preserves_paths_and_uses_file_names_for_preview() {
    let fixture = fixture();
    let paths = vec![
        fixture
            ._temp
            .path()
            .join("Report.md")
            .to_string_lossy()
            .into_owned(),
        fixture
            ._temp
            .path()
            .join("design")
            .join("final.sketch")
            .to_string_lossy()
            .into_owned(),
    ];
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Files(paths.clone()),
    ));

    let outcome = fixture.runtime.capture_once().await.unwrap();
    assert!(outcome.plugin_history_projected());
    assert!(!outcome.legacy_text_projected());
    let item_id = outcome.changed_item_id().unwrap().to_owned();
    let page = assert_history_contains(&fixture, "Report.md");
    assert_eq!(page.total, 1);
    let entry = fixture
        .db
        .plugin_clipboard_history_content(&page.items[0].id)
        .unwrap()
        .unwrap();
    assert_eq!(entry.kind, "file");
    assert_eq!(entry.payload["files"][0]["path"], paths[0]);
    assert_eq!(entry.payload["files"][0]["name"], "Report.md");
    assert_eq!(entry.payload["files"][1]["name"], "final.sketch");
    assert_eq!(entry.preview, "Report.md\nfinal.sketch");
    assert!(fixture.db.get_pasteboard_item(&item_id).unwrap().is_some());
}

#[tokio::test]
async fn duplicate_image_capture_updates_one_history_row() {
    let fixture = fixture();
    let bytes = image_bytes();
    for change_count in [1, 2] {
        fixture.backend.snapshots.lock().push_back(snapshot(
            change_count,
            atools_core::utils::now_iso(),
            NativePasteboardRepresentation::Image {
                bytes: bytes.clone(),
                media_type: "image/png".into(),
            },
        ));
    }

    let first = fixture.runtime.capture_once().await.unwrap();
    let second = fixture.runtime.capture_once().await.unwrap();
    assert!(first.plugin_history_projected());
    assert!(second.plugin_history_projected());
    assert_eq!(second.changed_item_id(), first.changed_item_id());
    assert_eq!(assert_history_contains(&fixture, "").total, 1);
}

#[tokio::test]
async fn paused_and_ignored_media_are_not_projected() {
    let fixture = fixture();
    fixture
        .db
        .set_setting(
            "settings-general",
            &serde_json::json!({ "pasteboardCapturePaused": true }).to_string(),
        )
        .unwrap();
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Image {
            bytes: image_bytes(),
            media_type: "image/png".into(),
        },
    ));
    let paused = fixture.runtime.capture_once().await.unwrap();
    assert!(matches!(paused, CaptureOutcome::Paused { .. }));
    assert!(!paused.plugin_history_projected());

    fixture.db.set_setting("settings-general", "{}").unwrap();
    let private_path = fixture
        ._temp
        .path()
        .join("private.txt")
        .to_string_lossy()
        .into_owned();
    let mut ignored = snapshot(
        2,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Files(vec![private_path]),
    );
    ignored.source_app = Some(PasteboardSourceApp {
        bundle_id: Some("com.1password.1password".into()),
        name: Some("Password Manager".into()),
    });
    fixture.backend.snapshots.lock().push_back(ignored);
    let ignored = fixture.runtime.capture_once().await.unwrap();
    assert!(matches!(ignored, CaptureOutcome::Ignored { .. }));
    assert!(!ignored.plugin_history_projected());
    assert_eq!(assert_history_contains(&fixture, "").total, 0);
}

#[tokio::test]
async fn adapter_over_budget_files_remain_in_shelf_without_history_projection() {
    let fixture = fixture();
    let paths = (0..21)
        .map(|index| {
            fixture
                ._temp
                .path()
                .join(format!("file-{index}.txt"))
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Files(paths),
    ));

    let outcome = fixture.runtime.capture_once().await.unwrap();
    assert!(!outcome.plugin_history_projected());
    let item_id = outcome.changed_item_id().unwrap();
    assert!(fixture.db.get_pasteboard_item(item_id).unwrap().is_some());
    assert_eq!(assert_history_contains(&fixture, "").total, 0);
}

#[tokio::test]
async fn pruned_media_projection_does_not_raise_history_notification() {
    let fixture = fixture();
    let old_path = fixture
        ._temp
        .path()
        .join("old.txt")
        .to_string_lossy()
        .into_owned();
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::iso_days_ago(200),
        NativePasteboardRepresentation::Files(vec![old_path]),
    ));

    let outcome = fixture.runtime.capture_once().await.unwrap();
    assert!(!outcome.plugin_history_projected());
    assert!(fixture
        .db
        .get_pasteboard_item(outcome.changed_item_id().unwrap())
        .unwrap()
        .is_none());
    assert_eq!(assert_history_contains(&fixture, "").total, 0);
}

#[tokio::test]
async fn stale_projection_for_pinned_shelf_item_does_not_raise_notification() {
    let fixture = fixture();
    let pinned_path = fixture
        ._temp
        .path()
        .join("pinned.txt")
        .to_string_lossy()
        .into_owned();
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Files(vec![pinned_path.clone()]),
    ));
    let first = fixture.runtime.capture_once().await.unwrap();
    let item_id = first.changed_item_id().unwrap().to_owned();
    let mut item = fixture.db.get_pasteboard_item(&item_id).unwrap().unwrap();
    item.pinned = true;
    item.copied_at = atools_core::utils::iso_days_ago(200);
    item.updated_at = item.copied_at.clone();
    fixture.db.upsert_pasteboard_item(&item).unwrap();
    fixture.backend.snapshots.lock().push_back(snapshot(
        2,
        atools_core::utils::iso_days_ago(200),
        NativePasteboardRepresentation::Files(vec![pinned_path]),
    ));

    let outcome = fixture.runtime.capture_once().await.unwrap();
    assert_eq!(outcome.changed_item_id(), Some(item_id.as_str()));
    assert!(!outcome.plugin_history_projected());
    assert!(fixture.db.get_pasteboard_item(&item_id).unwrap().is_some());
    assert_eq!(assert_history_contains(&fixture, "").total, 0);
}

#[tokio::test]
async fn self_write_media_is_not_projected_twice_and_item_delete_cascades() {
    let fixture = fixture();
    let bytes = image_bytes();
    fixture.backend.snapshots.lock().push_back(snapshot(
        1,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Image {
            bytes: bytes.clone(),
            media_type: "image/png".into(),
        },
    ));
    let first = fixture.runtime.capture_once().await.unwrap();
    let item_id = first.changed_item_id().unwrap().to_owned();
    fixture.runtime.copy_item(&item_id, false).await.unwrap();
    fixture.backend.snapshots.lock().push_back(snapshot(
        2,
        atools_core::utils::now_iso(),
        NativePasteboardRepresentation::Image {
            bytes,
            media_type: "image/png".into(),
        },
    ));

    let ignored = fixture.runtime.capture_once().await.unwrap();
    assert!(
        matches!(ignored, CaptureOutcome::Ignored { ref reason, .. } if reason == "self_write")
    );
    assert!(!ignored.plugin_history_projected());
    assert_eq!(assert_history_contains(&fixture, "").total, 1);

    let page = assert_history_contains(&fixture, "");
    let history_id = page.items[0].id.clone();
    fixture.db.delete_pasteboard_item(&item_id).unwrap();
    assert!(fixture
        .db
        .plugin_clipboard_history_content(&history_id)
        .unwrap()
        .is_none());
}
