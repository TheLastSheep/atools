use crate::updater::{
    UpdateBackend, UpdateCommandError, UpdateCoordinator, UpdateMetadata, UpdateOperation,
    UpdateProgress,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, Notify};

#[derive(Default)]
struct AsyncGate {
    started: Notify,
    released: Notify,
}

impl AsyncGate {
    async fn stop_until_released(&self) {
        self.started.notify_one();
        self.released.notified().await;
    }

    async fn wait_until_started(&self) {
        self.started.notified().await;
    }

    fn release(&self) {
        self.released.notify_one();
    }
}

struct BlockingRestart {
    started: Mutex<Option<oneshot::Sender<()>>>,
    released: Mutex<bool>,
    wake: Condvar,
}

impl BlockingRestart {
    fn new(started: oneshot::Sender<()>) -> Self {
        Self {
            started: Mutex::new(Some(started)),
            released: Mutex::new(false),
            wake: Condvar::new(),
        }
    }

    fn block_until_released(&self) -> Result<(), UpdateCommandError> {
        if let Ok(mut started) = self.started.lock() {
            if let Some(started) = started.take() {
                let _ = started.send(());
            }
        }

        let mut released = self
            .released
            .lock()
            .map_err(|_| UpdateCommandError::new("restart_pending", "restart gate poisoned"))?;
        while !*released {
            released = self
                .wake
                .wait(released)
                .map_err(|_| UpdateCommandError::new("restart_pending", "restart gate poisoned"))?;
        }
        Ok(())
    }

    fn release(&self) {
        if let Ok(mut released) = self.released.lock() {
            *released = true;
            self.wake.notify_all();
        }
    }
}

#[derive(Clone)]
pub(super) struct DeferredBackend {
    pub(super) update: Option<UpdateMetadata>,
    pub(super) check_error: Option<UpdateCommandError>,
    check_gate: Option<Arc<AsyncGate>>,
    install_gate: Option<Arc<AsyncGate>>,
    restart_gate: Option<Arc<BlockingRestart>>,
    fail_restart: bool,
    check_calls: Arc<AtomicUsize>,
    install_calls: Arc<AtomicUsize>,
    restart_calls: Arc<AtomicUsize>,
}

impl DeferredBackend {
    pub(super) fn unblocked() -> Self {
        Self::new(None, None, None)
    }

    fn new(
        check_gate: Option<Arc<AsyncGate>>,
        install_gate: Option<Arc<AsyncGate>>,
        restart_gate: Option<Arc<BlockingRestart>>,
    ) -> Self {
        Self {
            update: Some(UpdateMetadata {
                candidate_id: "0".repeat(32),
                prepared: None,
                current_version: "3.0.0".into(),
                version: "3.0.1".into(),
                date: Some("2026-10-27T00:00:00Z".into()),
                body: Some("Deferred updater fixture".into()),
            }),
            check_error: None,
            check_gate,
            install_gate,
            restart_gate,
            fail_restart: false,
            check_calls: Arc::new(AtomicUsize::new(0)),
            install_calls: Arc::new(AtomicUsize::new(0)),
            restart_calls: Arc::new(AtomicUsize::new(0)),
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
impl UpdateBackend for DeferredBackend {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.check_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = self.check_error.clone() {
            return Err(error);
        }
        if let Some(gate) = &self.check_gate {
            gate.stop_until_released().await;
        }
        Ok(self.update.clone())
    }

    async fn install(
        &self,
        _metadata: &UpdateMetadata,
        _progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        self.install_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.install_gate {
            gate.stop_until_released().await;
        }
        Ok(())
    }

    async fn download_archive(
        &self,
        m: &UpdateMetadata,
        _p: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<crate::updater::archive::VerifiedArchive, UpdateCommandError> {
        Ok(crate::updater::archive::VerifiedArchive::test_verified(m))
    }
    async fn apply_archive(
        &self,
        _a: Arc<crate::updater::archive::VerifiedArchive>,
    ) -> Result<(), UpdateCommandError> {
        self.install(self.update.as_ref().unwrap(), Box::new(|_| {}))
            .await
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        self.restart_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.restart_gate {
            gate.block_until_released()?;
        }
        if self.fail_restart {
            return Err(UpdateCommandError::new(
                "restart_pending",
                "Restart could not be started",
            ));
        }
        Ok(())
    }
}

#[tokio::test]
async fn initial_status_has_exact_four_wire_keys() {
    let status = UpdateCoordinator::default()
        .status()
        .await
        .expect("initial status");
    let json = serde_json::to_value(status).expect("serialize status");
    let object = json.as_object().expect("status object");
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();

    assert_eq!(keys, ["checked", "lastError", "operation", "update"]);
    assert_eq!(json["operation"], "idle");
    assert_eq!(json["checked"], false);
    assert!(json["update"].is_null());
    assert!(json["lastError"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_reads_while_check_is_deferred_without_backend_work() {
    let coordinator = Arc::new(UpdateCoordinator::default());
    let gate = Arc::new(AsyncGate::default());
    let backend = Arc::new(DeferredBackend::new(Some(Arc::clone(&gate)), None, None));
    let check = {
        let coordinator = Arc::clone(&coordinator);
        let backend = Arc::clone(&backend);
        tokio::spawn(async move { coordinator.check(backend.as_ref()).await })
    };

    gate.wait_until_started().await;
    let status = tokio::time::timeout(Duration::from_secs(1), coordinator.status())
        .await
        .expect("status must not wait for check")
        .expect("status snapshot");
    assert_eq!(status.operation, UpdateOperation::Checking);
    assert_eq!(backend.check_calls(), 1);
    assert_eq!(backend.install_calls(), 0);
    assert_eq!(backend.restart_calls(), 0);

    gate.release();
    check.await.expect("check task").expect("check succeeds");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_reads_while_install_is_deferred_without_backend_work() {
    let coordinator = Arc::new(UpdateCoordinator::default());
    let gate = Arc::new(AsyncGate::default());
    let backend = Arc::new(DeferredBackend::new(None, Some(Arc::clone(&gate)), None));
    coordinator
        .check(backend.as_ref())
        .await
        .expect("seed available update");

    let install = {
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
    gate.wait_until_started().await;
    let status = tokio::time::timeout(Duration::from_secs(1), coordinator.status())
        .await
        .expect("status must not wait for install")
        .expect("status snapshot");

    assert_eq!(status.operation, UpdateOperation::Installing);
    assert_eq!(
        status.update.as_ref().map(|item| item.version.as_str()),
        Some("3.0.1")
    );
    assert!(status.checked);
    assert_eq!(backend.check_calls(), 1);
    assert_eq!(backend.install_calls(), 1);
    assert_eq!(backend.restart_calls(), 0);

    gate.release();
    install
        .await
        .expect("install task")
        .expect("install succeeds");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_reads_during_restart_and_success_keeps_restarting_observed() {
    let coordinator = Arc::new(UpdateCoordinator::default());
    let (started_sender, started_receiver) = oneshot::channel();
    let restart_gate = Arc::new(BlockingRestart::new(started_sender));
    let backend = Arc::new(DeferredBackend::new(
        None,
        None,
        Some(Arc::clone(&restart_gate)),
    ));
    coordinator
        .check(backend.as_ref())
        .await
        .expect("seed available update");

    let install = {
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
    started_receiver.await.expect("restart started");

    let status = tokio::time::timeout(Duration::from_secs(1), coordinator.status())
        .await
        .expect("status must not wait for restart")
        .expect("status snapshot");
    assert_eq!(status.operation, UpdateOperation::Restarting);
    assert!(status.update.is_some());
    assert!(status.checked);
    assert_eq!(backend.check_calls(), 1);
    assert_eq!(backend.install_calls(), 1);
    assert_eq!(backend.restart_calls(), 1);

    restart_gate.release();
    install
        .await
        .expect("install task")
        .expect("restart succeeds");
    assert_eq!(
        coordinator
            .status()
            .await
            .expect("finished status")
            .operation,
        UpdateOperation::Restarting
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_check_clears_stale_observation_and_records_unknown_result() {
    let coordinator = Arc::new(UpdateCoordinator::default());
    let gate = Arc::new(AsyncGate::default());
    let backend = Arc::new(DeferredBackend::new(Some(Arc::clone(&gate)), None, None));
    let check = {
        let coordinator = Arc::clone(&coordinator);
        let backend = Arc::clone(&backend);
        tokio::spawn(async move { coordinator.check(backend.as_ref()).await })
    };
    gate.wait_until_started().await;

    check.abort();
    assert!(check.await.expect_err("aborted check").is_cancelled());
    let status = coordinator.status().await.expect("status after cancel");
    assert_eq!(status.operation, UpdateOperation::Idle);
    assert!(!status.checked);
    assert!(status.update.is_none());
    assert_eq!(
        status.last_error.as_ref().map(|error| error.code.as_str()),
        Some("operation_interrupted")
    );

    gate.release();
    coordinator
        .check(backend.as_ref())
        .await
        .expect("new check after cancellation");
    assert_eq!(backend.check_calls(), 2);
    assert!(coordinator
        .status()
        .await
        .expect("recovered status")
        .last_error
        .is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_install_awaiter_retains_real_operation_until_terminal() {
    let coordinator = Arc::new(UpdateCoordinator::default());
    let gate = Arc::new(AsyncGate::default());
    let backend = Arc::new(DeferredBackend::new(None, Some(Arc::clone(&gate)), None));
    coordinator
        .check(backend.as_ref())
        .await
        .expect("seed available update");

    let install = {
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
    gate.wait_until_started().await;
    install.abort();
    assert!(install.await.expect_err("aborted install").is_cancelled());

    let status = coordinator.status().await.unwrap();
    assert_eq!(status.operation, UpdateOperation::Installing);
    let id = status.update.unwrap().candidate_id;
    let busy = coordinator
        .install(backend.as_ref(), "3.0.1", &id, |_| {})
        .await
        .unwrap_err();
    assert_eq!(busy.code, "busy");
    assert_eq!(backend.install_calls(), 1);
    gate.release();
    // A check acquires the same real permit and therefore joins the still-running operation.
    coordinator.check(backend.as_ref()).await.unwrap();
    assert_eq!(backend.install_calls(), 1);
    assert_eq!(backend.restart_calls(), 1);
}

#[tokio::test]
async fn restart_failure_is_not_reported_as_success() {
    let coordinator = UpdateCoordinator::default();
    let mut backend = DeferredBackend::new(None, None, None);
    backend.fail_restart = true;
    coordinator.check(&backend).await.expect("seed update");

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
        .expect_err("restart failure");
    let status = coordinator.status().await.expect("failure status");

    assert_eq!(error.code, "restart_pending");
    assert_eq!(status.operation, UpdateOperation::Idle);
    assert!(status.checked);
    assert!(status.update.is_some());
    assert_eq!(
        status.last_error.as_ref().map(|error| error.code.as_str()),
        Some("restart_pending")
    );
    let candidate = status.update.unwrap();
    backend.fail_restart = false;
    coordinator
        .install(
            &backend,
            &candidate.version,
            &candidate.candidate_id,
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(
        backend.install_calls(),
        1,
        "restart retry must not reinstall"
    );
    assert_eq!(backend.restart_calls(), 2);
}
