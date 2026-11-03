use super::super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeBackend {
    update: Arc<Mutex<Option<UpdateMetadata>>>,
    check_calls: Arc<AtomicUsize>,
    install_calls: Arc<AtomicUsize>,
    restart_calls: Arc<AtomicUsize>,
    fail_check: Arc<AtomicBool>,
    fail_install: Arc<AtomicBool>,
}

impl FakeBackend {
    fn with_versions(current: &str, available: &str) -> Self {
        Self {
            update: Arc::new(Mutex::new(Some(UpdateMetadata {
                candidate_id: "0".repeat(32),
                prepared: None,
                current_version: current.into(),
                version: available.into(),
                date: Some("2026-07-15T00:00:00Z".into()),
                body: Some("Security and reliability fixes".into()),
            }))),
            check_calls: Arc::new(AtomicUsize::new(0)),
            install_calls: Arc::new(AtomicUsize::new(0)),
            restart_calls: Arc::new(AtomicUsize::new(0)),
            fail_check: Arc::new(AtomicBool::new(false)),
            fail_install: Arc::new(AtomicBool::new(false)),
        }
    }

    fn check_calls(&self) -> usize {
        self.check_calls.load(Ordering::SeqCst)
    }

    fn install_calls(&self) -> usize {
        self.install_calls.load(Ordering::SeqCst)
    }

    fn restart_calls(&self) -> usize {
        self.restart_calls.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl UpdateBackend for FakeBackend {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.check_calls.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        if self.fail_check.load(Ordering::SeqCst) {
            return Err(UpdateCommandError::new("network", "检查更新失败"));
        }
        Ok(self.update.lock().expect("update mutex").clone())
    }

    async fn install(
        &self,
        _metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        self.install_calls.fetch_add(1, Ordering::SeqCst);
        progress(UpdateProgress {
            event: "downloading".into(),
            downloaded: 50,
            total: Some(100),
        });
        tokio::task::yield_now().await;
        if self.fail_install.load(Ordering::SeqCst) {
            return Err(UpdateCommandError::new("install_unknown", "更新安装失败"));
        }
        Ok(())
    }

    async fn download_archive(
        &self,
        m: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<crate::updater::archive::VerifiedArchive, UpdateCommandError> {
        progress(UpdateProgress {
            event: "downloading".into(),
            downloaded: 50,
            total: Some(100),
        });
        Ok(crate::updater::archive::VerifiedArchive::test_verified(m))
    }
    async fn apply_archive(
        &self,
        _a: Arc<crate::updater::archive::VerifiedArchive>,
    ) -> Result<(), UpdateCommandError> {
        let m = self.update.lock().unwrap().clone().unwrap();
        self.install(&m, Box::new(|_| {})).await
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        self.restart_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn concurrent_and_fresh_checks_share_one_backend_result() {
    let coordinator = Arc::new(UpdateCoordinator::default());
    let backend = Arc::new(FakeBackend::with_versions("3.0.0", "3.0.1"));
    let first = {
        let coordinator = Arc::clone(&coordinator);
        let backend = Arc::clone(&backend);
        tokio::spawn(async move { coordinator.check(backend.as_ref()).await })
    };
    let second = {
        let coordinator = Arc::clone(&coordinator);
        let backend = Arc::clone(&backend);
        tokio::spawn(async move { coordinator.check(backend.as_ref()).await })
    };

    let first = first.await.expect("first join").expect("first check");
    let second = second.await.expect("second join").expect("second check");
    let third = coordinator
        .check(backend.as_ref())
        .await
        .expect("cached check");

    assert_eq!(
        backend.check_calls(),
        1,
        "concurrent/fresh checks must share one result"
    );
    assert_eq!(first, second);
    assert_eq!(second, third);
    assert_eq!(
        first.as_ref().map(|item| item.version.as_str()),
        Some("3.0.1")
    );
}

#[tokio::test]
async fn same_or_lower_version_is_not_an_update() {
    for available in ["3.0.0", "2.9.9"] {
        let coordinator = UpdateCoordinator::default();
        let backend = FakeBackend::with_versions("3.0.0", available);
        assert_eq!(coordinator.check(&backend).await.expect("check"), None);
    }
}

#[tokio::test]
async fn install_rejects_a_version_other_than_the_cached_update() {
    let coordinator = UpdateCoordinator::default();
    let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
    coordinator.check(&backend).await.expect("check");

    let error = coordinator
        .install(
            &backend,
            "3.0.0",
            &coordinator
                .status()
                .await
                .unwrap()
                .update
                .map(|m| m.candidate_id)
                .unwrap_or_default(),
            |_| {},
        )
        .await
        .expect_err("version mismatch");

    assert_eq!(error.code, "version_mismatch");
    assert_eq!(backend.install_calls(), 0);
}

#[tokio::test]
async fn failed_install_never_restarts() {
    let coordinator = UpdateCoordinator::default();
    let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
    backend.fail_install.store(true, Ordering::SeqCst);
    coordinator.check(&backend).await.expect("check");

    let error = coordinator
        .install(
            &backend,
            "3.0.1",
            &coordinator
                .status()
                .await
                .unwrap()
                .update
                .map(|m| m.candidate_id)
                .unwrap_or_default(),
            |_| {},
        )
        .await
        .expect_err("install failure");

    assert_eq!(error.code, "install_unknown");
    let status = coordinator.status().await.expect("install failure status");
    assert_eq!(status.operation, UpdateOperation::Idle);
    assert!(
        status.checked,
        "failed install keeps the checked observation"
    );
    assert_eq!(
        status.update.as_ref().map(|item| item.version.as_str()),
        Some("3.0.1")
    );
    assert_eq!(
        status.last_error.as_ref().map(|item| item.code.as_str()),
        Some("install_unknown")
    );
    assert_eq!(
        backend.restart_calls(),
        0,
        "failed installation must not restart"
    );
}

#[tokio::test]
async fn cached_check_cannot_hide_unknown_install_outcome() {
    let coordinator = UpdateCoordinator::default();
    let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
    backend.fail_install.store(true, Ordering::SeqCst);
    coordinator.check(&backend).await.expect("check");
    coordinator
        .install(
            &backend,
            "3.0.1",
            &coordinator
                .status()
                .await
                .unwrap()
                .update
                .map(|m| m.candidate_id)
                .unwrap_or_default(),
            |_| {},
        )
        .await
        .expect_err("install failure");
    assert_eq!(
        coordinator
            .status()
            .await
            .expect("failed install status")
            .last_error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("install_unknown")
    );

    coordinator.check(&backend).await.expect("cached check");
    assert_eq!(
        coordinator.view().unwrap().phase,
        crate::updater::snapshot::Phase::InstallUnknown
    );
    assert_eq!(
        coordinator.status().await.unwrap().last_error.unwrap().code,
        "install_unknown"
    );
}

#[tokio::test]
async fn successful_install_forwards_progress_and_restarts_once() {
    let coordinator = UpdateCoordinator::default();
    let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
    let progress = Arc::new(Mutex::new(Vec::new()));
    coordinator.check(&backend).await.expect("check");

    coordinator
        .install(
            &backend,
            "3.0.1",
            &coordinator
                .status()
                .await
                .unwrap()
                .update
                .map(|m| m.candidate_id)
                .unwrap_or_default(),
            {
                let progress = Arc::clone(&progress);
                move |item| progress.lock().expect("progress mutex").push(item)
            },
        )
        .await
        .expect("install");

    assert_eq!(backend.install_calls(), 1);
    assert_eq!(
        backend.restart_calls(),
        1,
        "successful installation restarts exactly once"
    );
    assert_eq!(progress.lock().expect("progress mutex")[0].downloaded, 50);
}

#[tokio::test]
async fn concurrent_installs_are_serialized_and_only_one_reaches_backend() {
    let coordinator = Arc::new(UpdateCoordinator::default());
    let backend = Arc::new(FakeBackend::with_versions("3.0.0", "3.0.1"));
    coordinator.check(backend.as_ref()).await.expect("check");

    let first = {
        let coordinator = Arc::clone(&coordinator);
        let backend = Arc::clone(&backend);
        tokio::spawn(async move {
            coordinator
                .install(
                    backend.as_ref(),
                    "3.0.1",
                    &coordinator
                        .status()
                        .await
                        .unwrap()
                        .update
                        .map(|m| m.candidate_id)
                        .unwrap_or_default(),
                    |_| {},
                )
                .await
        })
    };
    let second = {
        let coordinator = Arc::clone(&coordinator);
        let backend = Arc::clone(&backend);
        tokio::spawn(async move {
            coordinator
                .install(
                    backend.as_ref(),
                    "3.0.1",
                    &coordinator
                        .status()
                        .await
                        .unwrap()
                        .update
                        .map(|m| m.candidate_id)
                        .unwrap_or_default(),
                    |_| {},
                )
                .await
        })
    };

    let results = [
        first.await.expect("first join"),
        second.await.expect("second join"),
    ];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(backend.install_calls(), 1);
}

#[tokio::test]
async fn failed_check_clears_observation_and_retains_fixed_native_error() {
    let coordinator = UpdateCoordinator::default();
    let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
    backend.fail_check.store(true, Ordering::SeqCst);

    let error = coordinator
        .check(&backend)
        .await
        .expect_err("backend check failure");
    let status = coordinator.status().await.expect("check failure status");

    assert_eq!(error.code, "network");
    assert_eq!(status.operation, UpdateOperation::Idle);
    assert!(!status.checked);
    assert!(status.update.is_none());
    assert_eq!(status.last_error, Some(error));
}
