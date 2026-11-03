use super::{
    NativePasteboardRepresentation, NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

#[derive(Default)]
struct FakeBackend {
    snapshots: Mutex<VecDeque<NativePasteboardSnapshot>>,
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
    backend: Arc<FakeBackend>,
    runtime: PasteboardRuntime,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().to_path_buf());
    config.ensure_dirs().unwrap();
    let db = Arc::new(Database::open(&config.db_path()).unwrap());
    let backend = Arc::new(FakeBackend::default());
    let runtime = PasteboardRuntime::new(backend.clone(), db.clone(), &config).unwrap();
    Fixture {
        _temp: temp,
        db,
        backend,
        runtime,
    }
}

fn snapshot(change_count: i64, text: &str) -> NativePasteboardSnapshot {
    NativePasteboardSnapshot {
        change_count,
        copied_at: atools_core::utils::now_iso(),
        source_app: None,
        is_confidential: false,
        is_transient: false,
        representations: vec![NativePasteboardRepresentation::Text(text.into())],
    }
}

#[tokio::test]
async fn missing_settings_apply_180_day_prune_on_capture_and_preserve_pins() {
    let fixture = fixture();
    assert!(fixture
        .db
        .get_setting("settings-general")
        .unwrap()
        .is_none());

    fixture
        .backend
        .snapshots
        .lock()
        .push_back(snapshot(1, "seed capture"));
    let seed = fixture.runtime.capture_once().await.unwrap();
    let mut retained = fixture
        .db
        .get_pasteboard_item(seed.changed_item_id().unwrap())
        .unwrap()
        .unwrap();

    let mut expired = retained.clone();
    let mut pinned = retained.clone();
    retained.id = "retention-default-100d".into();
    retained.content_fingerprint = "retention-default-100d-fingerprint".into();
    retained.copied_at = atools_core::utils::iso_days_ago(100);
    retained.updated_at = retained.copied_at.clone();
    expired.id = "retention-default-181d".into();
    expired.content_fingerprint = "retention-default-181d-fingerprint".into();
    expired.copied_at = atools_core::utils::iso_days_ago(181);
    expired.updated_at = expired.copied_at.clone();
    pinned.id = "retention-default-pinned-181d".into();
    pinned.content_fingerprint = "retention-default-pinned-181d-fingerprint".into();
    pinned.copied_at = atools_core::utils::iso_days_ago(181);
    pinned.updated_at = pinned.copied_at.clone();
    pinned.pinned = true;
    for item in [&retained, &expired, &pinned] {
        fixture.db.upsert_pasteboard_item(item).unwrap();
    }
    assert!(fixture
        .db
        .get_setting("settings-general")
        .unwrap()
        .is_none());

    fixture
        .backend
        .snapshots
        .lock()
        .push_back(snapshot(2, "retention trigger"));
    fixture.runtime.capture_once().await.unwrap();

    assert!(fixture
        .db
        .get_pasteboard_item(&retained.id)
        .unwrap()
        .is_some());
    assert!(fixture
        .db
        .get_pasteboard_item(&expired.id)
        .unwrap()
        .is_none());
    assert!(fixture
        .db
        .get_pasteboard_item(&pinned.id)
        .unwrap()
        .is_some());
}
