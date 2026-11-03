//! Actual coordinator/retention callers; Fake provider is not signature-verification evidence.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[derive(Clone)]
struct Port {
    metadata: Arc<Mutex<UpdateMetadata>>,
    corrupt: Arc<AtomicBool>,
    installs: Arc<AtomicUsize>,
    progress: Option<UpdateProgress>,
    gate: Option<Arc<Mutex<std::sync::mpsc::Receiver<()>>>>,
    started: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}
impl Port {
    fn new() -> Self {
        Self {
            corrupt: Arc::new(AtomicBool::new(false)),
            metadata: Arc::new(Mutex::new(UpdateMetadata {
                candidate_id: String::new(),
                prepared: None,
                current_version: "1.0.0".into(),
                version: "1.0.1".into(),
                date: None,
                body: Some("notes".into()),
            })),
            installs: Arc::new(AtomicUsize::new(0)),
            progress: None,
            gate: None,
            started: Arc::new(Mutex::new(None)),
        }
    }
}
#[async_trait::async_trait]
impl UpdateBackend for Port {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        Ok(Some(self.metadata.lock().unwrap().clone()))
    }
    async fn install(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        panic!("unbound legacy backend install must not be used")
    }
    async fn download_archive(
        &self,
        m: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        if let Some(p) = &self.progress {
            progress(UpdateProgress {
                event: p.event.clone(),
                downloaded: p.downloaded,
                total: p.total,
            });
        }
        Ok(VerifiedArchive::test_verified(m))
    }
    async fn apply_archive(&self, a: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        let this = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if this.corrupt.load(Ordering::SeqCst) {
                a.test_corrupt();
            }
            a.read_verified()?;
            this.installs.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = this.started.lock().unwrap().take() {
                let _ = tx.send(());
            }
            if let Some(g) = this.gate {
                g.lock().unwrap().recv().unwrap();
            }
            Ok(())
        })
        .await
        .unwrap()
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        Ok(())
    }
}
#[tokio::test]
async fn same_version_new_candidate_cannot_consume_old_confirmation() {
    let mut coordinator = UpdateCoordinator::default();
    coordinator.cache_ttl = Duration::ZERO;
    let port = Port::new();
    let first = coordinator.check(&port).await.unwrap().unwrap();
    port.metadata.lock().unwrap().body = Some("new notes".into());
    let second = coordinator.check(&port).await.unwrap().unwrap();
    assert_ne!(first.candidate_id, second.candidate_id);
    assert_eq!(
        coordinator
            .install(&port, &first.version, &first.candidate_id, |_| {})
            .await
            .unwrap_err()
            .code,
        "stale_candidate"
    );
    assert_eq!(port.installs.load(Ordering::SeqCst), 0);
    assert_eq!(
        coordinator
            .confirm(
                &port,
                &second.version,
                &second.candidate_id,
                false,
                || false,
                |_| {}
            )
            .await
            .unwrap_err()
            .code,
        "forbidden_window"
    );
    assert_eq!(
        coordinator
            .confirm(
                &port,
                &second.version,
                &second.candidate_id,
                true,
                || true,
                |_| {}
            )
            .await
            .unwrap_err()
            .code,
        "not_downloaded"
    );
    assert_eq!(
        coordinator.status().await.unwrap().operation,
        UpdateOperation::Idle
    );
}
#[tokio::test]
async fn actual_blocking_worker_retains_permit_when_install_caller_disappears() {
    let c = UpdateCoordinator::default();
    let mut p = Port::new();
    let (tx, rx) = std::sync::mpsc::channel();
    p.gate = Some(Arc::new(Mutex::new(rx)));
    let (started, ready) = tokio::sync::oneshot::channel();
    *p.started.lock().unwrap() = Some(started);
    let m = c.check(&p).await.unwrap().unwrap();
    let call = {
        let c = c.clone();
        let p = p.clone();
        let m = m.clone();
        tokio::spawn(async move { c.install(&p, &m.version, &m.candidate_id, |_| {}).await })
    };
    ready.await.unwrap();
    call.abort();
    let _ = call.await;
    assert_eq!(
        c.install(&p, &m.version, &m.candidate_id, |_| {})
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    assert_eq!(p.installs.load(Ordering::SeqCst), 1);
    tx.send(()).unwrap();
    c.check(&p).await.unwrap();
    assert_eq!(p.installs.load(Ordering::SeqCst), 1);
}

// Preserve the original coordinator's lock-poison regression after the state refactor.
#[tokio::test]
async fn status_rejects_a_poisoned_snapshot_lock() {
    let coordinator = UpdateCoordinator::default();
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _snapshot = coordinator.snapshot.lock().expect("snapshot lock");
        panic!("poison the updater snapshot lock");
    }));
    assert!(poisoned.is_err());
    assert_eq!(
        coordinator.status().await.unwrap_err().code,
        "state_unavailable"
    );
}

#[tokio::test]
async fn first_candidate_reserves_worst_snapshot_error_and_operation_fields() {
    let c = UpdateCoordinator::default();
    let p = Port::new();
    {
        let mut m = p.metadata.lock().unwrap();
        m.current_version = "3.0.0".into();
        m.version = "3.0.1".into();
        m.date = Some("2026-10-27T00:00:00Z".into());
        m.body = Some("\0".repeat(10880));
    }
    let result = c.check(&p).await;
    assert!(
        result.is_err(),
        "legacy-sized candidate must not cache before complete Snapshot admission"
    );
    assert!(c.status().await.unwrap().update.is_none());
}
#[tokio::test]
async fn preinstall_integrity_failure_never_becomes_unknown_install_or_reusable_cache() {
    let c = UpdateCoordinator::default();
    let p = Port::new();
    p.corrupt.store(true, Ordering::SeqCst);
    let m = c.check(&p).await.unwrap().unwrap();
    let error = c
        .install(&p, &m.version, &m.candidate_id, |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, "archive_integrity");
    assert_eq!(p.installs.load(Ordering::SeqCst), 0);
    assert_eq!(c.view().unwrap().phase, Phase::Error);
    assert_eq!(
        c.confirm(&p, &m.version, &m.candidate_id, true, || true, |_| {})
            .await
            .unwrap_err()
            .code,
        "not_downloaded"
    );
}

#[tokio::test]
async fn full_ascii_notes_survive_all_phases_and_maximum_legal_utf8_error_envelope() {
    let c = UpdateCoordinator::default();
    let p = Port::new();
    p.metadata.lock().unwrap().body = Some("n".repeat(48 * 1024));
    c.check(&p)
        .await
        .expect("normal full 48KiB ASCII changelog remains supported");
    for phase in [
        Phase::Idle,
        Phase::Checking,
        Phase::NotAvailable,
        Phase::Available,
        Phase::Downloading,
        Phase::Downloaded,
        Phase::Installing,
        Phase::InstallUnknown,
        Phase::RestartPending,
        Phase::Restarting,
        Phase::Error,
    ] {
        for code in super::super::errors::CODES {
            // The real storage ingress canonicalizes even maximum UTF8/control provider messages.
            c.error(UpdateCommandError::new(*code, "错\0".repeat(2048)), phase);
            {
                let mut s = c.snapshot.lock().unwrap();
                s.sequence = 9_007_199_254_740_991;
                s.operation_id = Some("f".repeat(32));
                s.progress = Progress {
                    downloaded: 9_007_199_254_740_991,
                    total: Some(9_007_199_254_740_991),
                };
            }
            let actual = c.view().unwrap();
            assert!(
                serde_json::to_vec(actual.error.as_ref().unwrap())
                    .unwrap()
                    .len()
                    <= super::super::errors::MAX_ENCODED_ERROR
            );
            assert!(
                serde_json::to_vec(
                    &serde_json::json!({"windowId":"f".repeat(32),"snapshot":actual})
                )
                .unwrap()
                .len()
                    <= 64 * 1024
            );
            c.snapshot.lock().unwrap().sequence = 0;
        }
    }
}

#[tokio::test]
async fn operation_close_guard_and_progress_follow_actual_permit_not_downloaded_phase() {
    let c = UpdateCoordinator::default();
    let mut p = Port::new();
    p.progress = Some(UpdateProgress {
        event: "downloading".into(),
        downloaded: 1024,
        total: Some(u64::MAX),
    });
    let selected = c.check(&p).await.unwrap().unwrap();
    let downloaded_seen = Arc::new(AtomicBool::new(false));
    let seen = downloaded_seen.clone();
    let owner = c.clone();
    c.bind_notifier(Arc::new(move |snapshot, _| {
        if snapshot.phase == Phase::Downloaded {
            assert!(owner.operation_busy());
            assert!(owner.reserve_window_close().is_err());
            seen.store(true, Ordering::SeqCst);
        }
        assert!(snapshot.sequence <= 9_007_199_254_740_991);
    }));
    let wire = Arc::new(Mutex::new(Vec::new()));
    let captured = wire.clone();
    c.install(
        &p,
        &selected.version,
        &selected.candidate_id,
        move |progress| captured.lock().unwrap().push(progress),
    )
    .await
    .unwrap();
    assert!(downloaded_seen.load(Ordering::SeqCst));
    let progress = wire.lock().unwrap();
    assert_eq!(progress.len(), 1);
    assert_eq!(progress[0].downloaded, 1024);
    assert_eq!(progress[0].total, None);
    assert_eq!(progress[0].event, "downloading");
    c.shutdown();
}
#[tokio::test]
async fn exit_fence_rejects_new_work_without_releasing_actual_blocking_worker() {
    let c = UpdateCoordinator::default();
    let mut p = Port::new();
    let (tx, rx) = std::sync::mpsc::channel();
    p.gate = Some(Arc::new(Mutex::new(rx)));
    let (started, ready) = tokio::sync::oneshot::channel();
    *p.started.lock().unwrap() = Some(started);
    let selected = c.check(&p).await.unwrap().unwrap();
    let task = {
        let c = c.clone();
        let p = p.clone();
        tokio::spawn(async move {
            c.install(&p, &selected.version, &selected.candidate_id, |_| {})
                .await
        })
    };
    ready.await.unwrap();
    c.shutdown();
    assert!(c.operation_busy());
    assert_eq!(
        c.confirm(&p, "1.0.1", &"a".repeat(32), false, || true, |_| {})
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    tx.send(()).unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().code,
        "operation_interrupted"
    );
    assert_eq!(c.check(&p).await.unwrap_err().code, "operation_interrupted");
    assert!(c.view().unwrap().candidate.is_none());
    assert_eq!(p.installs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unrepresentable_download_count_is_rejected_not_misreported_as_clamped_bytes() {
    let c = UpdateCoordinator::default();
    let mut p = Port::new();
    p.progress = Some(UpdateProgress {
        event: "downloading".into(),
        downloaded: u64::MAX,
        total: Some(u64::MAX),
    });
    let m = c.check(&p).await.unwrap().unwrap();
    let events = Arc::new(AtomicUsize::new(0));
    let seen = events.clone();
    let result = c
        .install(&p, &m.version, &m.candidate_id, move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .await;
    assert_eq!(result.unwrap_err().code, "download_failed");
    assert_eq!(events.load(Ordering::SeqCst), 0);
    assert_eq!(p.installs.load(Ordering::SeqCst), 0);
    assert!(c.lock_snapshot().unwrap().archive.is_none());
}
