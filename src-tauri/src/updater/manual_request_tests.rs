//! Actual typed owner and About kernel callee; no App, provider grant, archive or installer.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Port {
    result: Option<UpdateMetadata>,
    calls: Arc<AtomicUsize>,
    started: Option<Arc<tokio::sync::Notify>>,
    release: Option<Arc<tokio::sync::Notify>>,
}
impl Port {
    fn immediate(result: Option<UpdateMetadata>) -> Self {
        Self {
            result,
            calls: Arc::new(AtomicUsize::new(0)),
            started: None,
            release: None,
        }
    }
}
#[async_trait::async_trait]
impl UpdateBackend for Port {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(started) = &self.started {
            started.notify_one();
        }
        if let Some(release) = &self.release {
            release.notified().await;
        }
        Ok(self.result.clone())
    }
    async fn install(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
    async fn download_archive(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        panic!("check only")
    }
    async fn apply_archive(&self, _: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        panic!("check only")
    }
}
#[tokio::test]
async fn r79_review_manual_singleflight_is_app_wide_and_drop_ipc_keeps_real_worker_owned() {
    let c = UpdateCoordinator::default();
    let owner = c.reserve_manual_request().unwrap();
    assert!(c.reserve_manual_request().is_err());
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let mut port = Port::immediate(Some(UpdateMetadata::test_candidate()));
    port.started = Some(started.clone());
    port.release = Some(release.clone());
    let calls = port.calls.clone();
    let state = c.clone();
    let worker = tokio::spawn(owner.hold(async move { state.check_about(&port, || true).await }));
    started.notified().await;
    let ipc = tokio::spawn(async move { worker.await });
    ipc.abort();
    let _ = ipc.await;
    assert!(c.reserve_manual_request().is_err());
    assert!(c.operation_busy());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(1), async {
        while c.manual_request.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(c.reserve_manual_request().is_ok());
    assert!(!c.operation_busy());
}
#[tokio::test]
async fn r79_review_revoked_before_admission_does_not_start_backend_and_releases_request() {
    let c = UpdateCoordinator::default();
    let owner = c.reserve_manual_request().unwrap();
    let port = Port::immediate(Some(UpdateMetadata::test_candidate()));
    let result = owner.hold(c.check_about(&port, || false)).await;
    assert_eq!(result.err().unwrap().code, "forbidden_window");
    assert_eq!(port.calls.load(Ordering::SeqCst), 0);
    assert!(c.reserve_manual_request().is_ok());
}
#[tokio::test]
async fn r79_review_no_update_result_remains_not_available_after_another_check_finds_b() {
    let mut c = UpdateCoordinator::default();
    c.cache_ttl = Duration::ZERO;
    let none = Port::immediate(None);
    let captured = c.check_about(&none, || true).await.unwrap();
    let next = Port::immediate(Some(UpdateMetadata::test_candidate()));
    let b = c.check(&next).await.unwrap().unwrap();
    assert_eq!(captured.phase, Phase::NotAvailable);
    assert!(captured.candidate.is_none());
    assert_eq!(
        c.view().unwrap().candidate.unwrap().candidate_id,
        b.candidate_id
    );
}
