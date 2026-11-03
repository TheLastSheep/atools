//! Real shared coordinator admission; test archives are not signature/provider evidence.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Port(AtomicUsize);
#[async_trait::async_trait]
impl UpdateBackend for Port {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Some(UpdateMetadata {
            candidate_id: String::new(),
            prepared: None,
            current_version: "1.0.0".into(),
            version: "1.0.1".into(),
            date: None,
            body: Some("notes".into()),
        }))
    }
    async fn install(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        panic!("must not install")
    }
    async fn download_archive(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        self.0.fetch_add(1000, Ordering::SeqCst);
        Err(failure("download_failed"))
    }
    async fn apply_archive(&self, _: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        self.0.fetch_add(1000, Ordering::SeqCst);
        Err(failure("install_unknown"))
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        panic!("must not restart")
    }
}
fn coordinator() -> UpdateCoordinator {
    let mut c = UpdateCoordinator::default();
    c.cache_ttl = Duration::ZERO;
    c
}
#[tokio::test]
async fn real_pin_prevents_candidate_rotation_and_old_release_cannot_unpin_new_window() {
    let c = coordinator();
    let p = Port(AtomicUsize::new(0));
    let first = c.check(&p).await.unwrap().unwrap();
    let pin = c
        .reserve_presentation("first", &first.candidate_id)
        .await
        .unwrap();
    assert_eq!(
        c.check(&p).await.unwrap().unwrap().candidate_id,
        first.candidate_id
    );
    assert_eq!(p.0.load(Ordering::SeqCst), 1);
    pin.release();
    let second = c.check(&p).await.unwrap().unwrap();
    assert_ne!(first.candidate_id, second.candidate_id);
    let next = c
        .reserve_presentation("second", &second.candidate_id)
        .await
        .unwrap();
    pin.release();
    drop(pin);
    assert!(c.lock_snapshot().unwrap().presentation.is_some());
    drop(next);
    assert!(c.lock_snapshot().unwrap().presentation.is_none());
}
#[tokio::test]
async fn recovery_states_and_verified_archive_survive_manual_and_silent_check_after_ttl() {
    let c = coordinator();
    let p = Port(AtomicUsize::new(0));
    let candidate = c.check(&p).await.unwrap().unwrap();
    for phase in [
        Phase::Downloaded,
        Phase::InstallUnknown,
        Phase::RestartPending,
        Phase::Restarting,
    ] {
        c.lock_snapshot().unwrap().phase = phase;
        assert_eq!(
            c.check(&p).await.unwrap().unwrap().candidate_id,
            candidate.candidate_id
        );
        assert_eq!(
            c.check_silent(&p, 1, || true)
                .await
                .unwrap()
                .unwrap()
                .candidate_id,
            candidate.candidate_id
        );
        assert_eq!(c.view().unwrap().phase, phase);
    }
    {
        let mut s = c.lock_snapshot().unwrap();
        s.phase = Phase::Error;
        s.archive = Some(Arc::new(VerifiedArchive::test_verified(&candidate)));
    }
    assert_eq!(
        c.check(&p).await.unwrap().unwrap().candidate_id,
        candidate.candidate_id
    );
    assert!(c.lock_snapshot().unwrap().archive.is_some());
    assert_eq!(p.0.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn silent_busy_and_revoked_generation_never_reach_backend_or_mutate_state() {
    let c = coordinator();
    let p = Port(AtomicUsize::new(0));
    let permit = c.operation_gate.lock().await;
    assert_eq!(
        c.check_silent(&p, 1, || true).await.unwrap_err().code,
        "busy"
    );
    drop(permit);
    assert_eq!(
        c.check_silent(&p, 1, || false).await.unwrap_err().code,
        "operation_interrupted"
    );
    assert_eq!(p.0.load(Ordering::SeqCst), 0);
    assert_eq!(c.view().unwrap().phase, Phase::Idle);
    let first = c.check(&p).await.unwrap().unwrap();
    assert!(c
        .reserve_presentation("wrong", "00000000000000000000000000000000")
        .await
        .is_err());
    assert!(c
        .reserve_presentation("right", &first.candidate_id)
        .await
        .is_ok());
}

#[tokio::test]
async fn r79_review_red_busy_about_callee_fails_fast_without_backend_work() {
    let c = coordinator();
    let p = Port(AtomicUsize::new(0));
    let permit = c.operation_gate.lock().await;
    // This is the actual dedicated About entry callee; legacy check keeps its queue semantics.
    let result = tokio::time::timeout(Duration::from_millis(20), c.check_about(&p, || true)).await;
    drop(permit);
    assert!(
        result.is_ok(),
        "About must reject busy instead of queueing Core check"
    );
    assert_eq!(result.unwrap().unwrap_err().code, "busy");
    assert_eq!(p.0.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn r79_review_red_check_a_cannot_select_later_b_for_the_same_request() {
    let c = coordinator();
    let p = Port(AtomicUsize::new(0));
    let a = c.check(&p).await.unwrap().unwrap();
    let b = c.check(&p).await.unwrap().unwrap();
    assert_ne!(a.candidate_id, b.candidate_id);
    let selected =
        crate::renderer_updater::expected_candidate(&c.view().unwrap(), Some(&a.candidate_id));
    assert!(
        selected.is_err(),
        "old About A must not show/reply with later B"
    );
}

struct BlockedDownload {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
#[async_trait::async_trait]
impl UpdateBackend for BlockedDownload {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        panic!("confirm only")
    }
    async fn install(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        panic!("confirm only")
    }
    async fn download_archive(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        self.started.notify_one();
        self.release.notified().await;
        Err(failure("download_failed"))
    }
    async fn apply_archive(&self, _: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        panic!("never downloaded")
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        panic!("never downloaded")
    }
}
#[tokio::test]
async fn r79_tail_red_installer_between_check_and_pin_cannot_queue_about_creation() {
    let c = coordinator();
    let p = Port(AtomicUsize::new(0));
    let captured = c.check_about(&p, || true).await.unwrap().candidate.unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let backend = BlockedDownload {
        started: started.clone(),
        release: release.clone(),
    };
    let worker = {
        let state = c.clone();
        let candidate = captured.clone();
        tokio::spawn(async move {
            state
                .confirm(
                    &backend,
                    &candidate.version,
                    &candidate.candidate_id,
                    false,
                    || true,
                    |_| {},
                )
                .await
        })
    };
    started.notified().await;
    assert_eq!(c.view().unwrap().phase, Phase::Downloading);
    assert!(c.operation_busy());
    let result = tokio::time::timeout(
        Duration::from_millis(20),
        c.reserve_about_presentation("about", &captured.candidate_id),
    )
    .await;
    release.notify_one();
    assert_eq!(worker.await.unwrap().err().unwrap().code, "download_failed");
    assert!(
        result.is_ok(),
        "new About pin must fail fast, not wait for installation"
    );
    assert_eq!(result.unwrap().err().unwrap().code, "busy");
    assert!(c.lock_snapshot().unwrap().presentation.is_none());
    let pin = c
        .reserve_about_presentation("retry", &captured.candidate_id)
        .await
        .unwrap();
    drop(pin);
}
