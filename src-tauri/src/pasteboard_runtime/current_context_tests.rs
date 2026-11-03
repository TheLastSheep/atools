use super::{
    NativePasteboardRepresentation, NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem};
use parking_lot::Mutex;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex as StdMutex,
    },
    time::Duration,
};

#[derive(Default)]
struct FakeBackend {
    current: Mutex<Option<NativePasteboardSnapshot>>,
    snapshot_reads: AtomicUsize,
    change_count_reads: AtomicUsize,
}

impl FakeBackend {
    fn set_current(&self, snapshot: Option<NativePasteboardSnapshot>) {
        *self.current.lock() = snapshot;
    }
}

#[async_trait]
impl PasteboardBackend for FakeBackend {
    async fn snapshot_if_changed(
        &self,
        previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        Ok(self
            .current
            .lock()
            .as_ref()
            .filter(|snapshot| snapshot.change_count != previous_change_count)
            .cloned())
    }

    async fn current_context_snapshot(&self) -> Result<Option<NativePasteboardSnapshot>, String> {
        self.snapshot_reads.fetch_add(1, Ordering::Relaxed);
        Ok(self.current.lock().clone())
    }

    async fn current_change_count(&self) -> Result<Option<i64>, String> {
        self.change_count_reads.fetch_add(1, Ordering::Relaxed);
        Ok(self
            .current
            .lock()
            .as_ref()
            .map(|snapshot| snapshot.change_count))
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
    let db = Arc::new(Database::in_memory().unwrap());
    let backend = Arc::new(FakeBackend::default());
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
    copied_at: &str,
    representations: Vec<NativePasteboardRepresentation>,
) -> NativePasteboardSnapshot {
    NativePasteboardSnapshot {
        change_count,
        copied_at: copied_at.to_string(),
        source_app: None,
        is_confidential: false,
        is_transient: false,
        representations,
    }
}

fn assert_no_persisted_history(db: &Database) {
    assert!(db
        .search_pasteboard_items("", None, &[], 20, 0)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn current_request_reads_without_persisting_and_never_returns_old_content_after_clear() {
    let fixture = fixture();
    fixture.backend.set_current(Some(snapshot(
        7,
        "2020-01-02T03:04:05.006Z",
        vec![NativePasteboardRepresentation::Text("request local".into())],
    )));

    let content = fixture
        .runtime
        .read_current_context(None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(content).unwrap()["data"],
        "request local"
    );
    assert_no_persisted_history(&fixture.db);

    fixture.backend.set_current(None);
    assert!(fixture
        .runtime
        .read_current_context(None)
        .await
        .unwrap()
        .is_none());
    assert_no_persisted_history(&fixture.db);
}

#[tokio::test]
async fn history_pause_and_filters_do_not_cache_or_block_explicit_context_reads() {
    let fixture = fixture();
    fixture
        .db
        .set_setting(
            "settings-general",
            &serde_json::json!({"pasteboardCapturePaused":true}).to_string(),
        )
        .unwrap();
    fixture.backend.set_current(Some(snapshot(
        10,
        "2020-01-02T03:04:05.006Z",
        vec![NativePasteboardRepresentation::Text("  paused  ".into())],
    )));
    assert!(matches!(
        fixture.runtime.capture_once().await.unwrap(),
        super::CaptureOutcome::Paused { change_count: 10 }
    ));

    fixture
        .db
        .set_setting(
            "settings-general",
            &serde_json::json!({"pasteboardCapturePaused":false}).to_string(),
        )
        .unwrap();
    fixture.backend.set_current(Some(snapshot(
        11,
        "2020-01-02T03:04:06.007Z",
        vec![NativePasteboardRepresentation::Text(
            "filtered but readable".into(),
        )],
    )));
    let mut filtered = snapshot(
        11,
        "2020-01-02T03:04:06.007Z",
        vec![NativePasteboardRepresentation::Text(
            "filtered but readable".into(),
        )],
    );
    filtered.is_confidential = true;
    fixture.backend.set_current(Some(filtered));
    assert!(matches!(
        fixture.runtime.capture_once().await.unwrap(),
        super::CaptureOutcome::Ignored {
            change_count: 11,
            ..
        }
    ));

    let content = fixture
        .runtime
        .read_current_context(None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(content).unwrap()["data"],
        "filtered but readable"
    );
    assert_no_persisted_history(&fixture.db);
}

#[tokio::test]
async fn same_change_count_keeps_first_observed_timestamp() {
    let fixture = fixture();
    let first = snapshot(
        21,
        "2020-01-02T03:04:05.006Z",
        vec![NativePasteboardRepresentation::Text("same copy".into())],
    );
    fixture.backend.set_current(Some(first.clone()));
    let first_result = fixture
        .runtime
        .read_current_context(None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(first_result).unwrap()["timestamp"],
        1_577_934_245_006u64
    );

    fixture.backend.set_current(Some(snapshot(
        21,
        "2026-10-29T12:00:00.000Z",
        vec![NativePasteboardRepresentation::Text("same copy".into())],
    )));
    let second_result = fixture
        .runtime
        .read_current_context(None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(second_result).unwrap()["timestamp"],
        1_577_934_245_006u64
    );
}

#[tokio::test]
async fn expired_same_count_checks_metadata_without_recopying_large_payload() {
    let fixture = fixture();
    fixture.backend.set_current(Some(snapshot(
        31,
        "2020-01-02T03:04:05.006Z",
        vec![NativePasteboardRepresentation::Text("stale".into())],
    )));
    let result = fixture
        .runtime
        .read_current_context(Some(1.0))
        .await
        .unwrap();
    assert!(result.is_none());
    assert_eq!(fixture.backend.snapshot_reads.load(Ordering::Relaxed), 1);
    assert!(fixture.backend.change_count_reads.load(Ordering::Relaxed) > 0);
}

#[tokio::test]
async fn missing_snapshot_waits_for_new_content_inside_the_single_call_deadline() {
    let fixture = fixture();
    let backend = fixture.backend.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(45)).await;
        backend.set_current(Some(snapshot(
            41,
            &atools_core::utils::now_iso(),
            vec![NativePasteboardRepresentation::Text("arrived".into())],
        )));
    });

    let content = fixture
        .runtime
        .read_current_context(Some(5_000.0))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_value(content).unwrap()["data"], "arrived");
    assert!(fixture.backend.snapshot_reads.load(Ordering::Relaxed) >= 2);
}

#[tokio::test]
async fn observed_projection_does_not_wait_for_the_live_snapshot_gate() {
    let fixture = fixture();
    let _live_read = fixture.runtime.snapshot_gate.clone().lock_owned().await;
    let observed = snapshot(
        47,
        "2026-10-29T12:00:00.000Z",
        vec![NativePasteboardRepresentation::Text("observed".into())],
    );
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        fixture.runtime.project_current_snapshot(observed, 1234),
    )
    .await
    .expect("projecting immutable data must not block on another live clipboard read")
    .unwrap();
    assert!(result.is_some());
}

struct BlockingSnapshotBackend {
    started: mpsc::Sender<()>,
    release: Arc<(StdMutex<bool>, Condvar)>,
    snapshot: NativePasteboardSnapshot,
}

#[async_trait]
impl PasteboardBackend for BlockingSnapshotBackend {
    async fn snapshot_if_changed(
        &self,
        previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        Ok((self.snapshot.change_count != previous_change_count).then(|| self.snapshot.clone()))
    }

    async fn current_context_snapshot(&self) -> Result<Option<NativePasteboardSnapshot>, String> {
        let _ = self.started.send(());
        let (lock, condition) = &*self.release;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = condition.wait(released).unwrap();
        }
        Ok(Some(self.snapshot.clone()))
    }

    async fn current_change_count(&self) -> Result<Option<i64>, String> {
        Ok(Some(self.snapshot.change_count))
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

#[tokio::test]
async fn cancelling_reader_does_not_release_snapshot_gate_before_blocking_worker_finishes() {
    let temp = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(temp.path().to_path_buf());
    let db = Arc::new(Database::in_memory().unwrap());
    let (started, started_rx) = mpsc::channel();
    let release = Arc::new((StdMutex::new(false), Condvar::new()));
    let backend = Arc::new(BlockingSnapshotBackend {
        started,
        release: release.clone(),
        snapshot: snapshot(
            90,
            "2026-10-29T12:00:00.000Z",
            vec![NativePasteboardRepresentation::Text("bounded".into())],
        ),
    });
    let runtime = Arc::new(PasteboardRuntime::new(backend, db, &config).unwrap());

    let reader_runtime = runtime.clone();
    let reader = tokio::spawn(async move { reader_runtime.read_current_context(None).await });
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(1)))
        .await
        .unwrap()
        .expect("blocking backend started");

    reader.abort();
    assert!(reader.await.unwrap_err().is_cancelled());
    assert!(runtime.snapshot_gate.try_lock().is_err());

    let (lock, condition) = &*release;
    *lock.lock().unwrap() = true;
    condition.notify_all();
    let gate = tokio::time::timeout(
        Duration::from_secs(1),
        runtime.snapshot_gate.clone().lock_owned(),
    )
    .await
    .expect("blocking worker released snapshot gate");
    drop(gate);
}
