use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Semaphore;

#[derive(Clone)]
struct Deferred {
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
    active: Arc<AtomicUsize>,
    panic: bool,
}
impl Deferred {
    fn new(panic: bool) -> Self {
        Self {
            started: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            active: Arc::new(AtomicUsize::new(0)),
            panic,
        }
    }
    async fn entered(&self) {
        tokio::time::timeout(Duration::from_secs(1), self.started.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
}
struct Resource(Arc<AtomicUsize>);
impl Drop for Resource {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
#[async_trait::async_trait]
impl UpdateBackend for Deferred {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        Ok(Some(UpdateMetadata {
            candidate_id: String::new(),
            prepared: None,
            current_version: "1.0.0".into(),
            version: "1.0.1".into(),
            date: None,
            body: None,
        }))
    }
    async fn install(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        panic!("unused legacy backend method")
    }
    async fn download_archive(
        &self,
        _: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        self.active.fetch_add(1, Ordering::AcqRel);
        let _resource = Resource(self.active.clone());
        self.started.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        progress(UpdateProgress {
            event: "downloading".into(),
            downloaded: 50,
            total: Some(100),
        });
        if self.panic {
            panic!("actual test worker unwind");
        }
        Err(failure("download_failed"))
    }
    async fn apply_archive(&self, _: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        panic!("failed download must never install")
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        panic!("failed download must never restart")
    }
}

#[tokio::test]
async fn dropped_ipc_awaiter_keeps_real_worker_identity_and_resource_until_terminal() {
    let coordinator = UpdateCoordinator::default();
    let backend = Deferred::new(false);
    let candidate = coordinator.check(&backend).await.unwrap().unwrap();
    let c = coordinator.clone();
    let b = backend.clone();
    let caller = tokio::spawn(async move {
        c.install(&b, &candidate.version, &candidate.candidate_id, |_| {})
            .await
    });
    backend.entered().await;
    let owned = coordinator.view().unwrap().operation_id.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(coordinator.operation_busy());
    assert_eq!(
        coordinator.view().unwrap().operation_id.as_deref(),
        Some(owned.as_str())
    );
    assert_eq!(backend.active.load(Ordering::Acquire), 1);
    backend.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(1), async {
        while coordinator.operation_busy() || coordinator.view().unwrap().operation_id.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(backend.active.load(Ordering::Acquire), 0);
    assert!(coordinator.reserve_window_close().is_ok());
    assert_eq!(coordinator.view().unwrap().phase, Phase::Error);
}

#[tokio::test]
async fn actual_worker_unwind_retires_identity_and_publishes_interrupted_terminal() {
    let coordinator = UpdateCoordinator::default();
    let backend = Deferred::new(true);
    let candidate = coordinator.check(&backend).await.unwrap().unwrap();
    let c = coordinator.clone();
    let b = backend.clone();
    let worker = tokio::spawn(async move {
        c.confirm(
            &b,
            &candidate.version,
            &candidate.candidate_id,
            false,
            || true,
            |_| {},
        )
        .await
    });
    backend.entered().await;
    assert!(coordinator.operation_busy());
    backend.release.add_permits(1);
    assert!(worker.await.unwrap_err().is_panic());
    let terminal = coordinator.view().unwrap();
    assert!(terminal.operation_id.is_none());
    assert_eq!(terminal.phase, Phase::Error);
    assert_eq!(terminal.error.unwrap().code, "operation_interrupted");
    assert_eq!(backend.active.load(Ordering::Acquire), 0);
    assert!(coordinator.reserve_window_close().is_ok());
}

#[tokio::test]
async fn owner_comparison_and_late_progress_cannot_rewrite_a_later_operation() {
    let c = UpdateCoordinator::default();
    let permit = c.operation_gate.try_lock().unwrap();
    let first = Confirmation::begin(&c, permit, false).unwrap();
    c.phase(Phase::Downloading).unwrap();
    let (invalid, late) = progress(c.clone(), first.id().into(), |_| {});
    late(UpdateProgress {
        event: "downloading".into(),
        downloaded: 50,
        total: Some(100),
    });
    first.finish();
    let second = Confirmation::begin(&c, c.operation_gate.try_lock().unwrap(), false).unwrap();
    c.phase(Phase::Downloading).unwrap();
    let before = c.view().unwrap();
    late(UpdateProgress {
        event: "downloading".into(),
        downloaded: MAX_SEQUENCE + 1,
        total: None,
    });
    late(UpdateProgress {
        event: "downloading".into(),
        downloaded: 999,
        total: None,
    });
    let after = c.view().unwrap();
    assert_eq!(after.operation_id, before.operation_id);
    assert_eq!(after.sequence, before.sequence);
    assert_eq!(after.progress.downloaded, before.progress.downloaded);
    assert!(!invalid.load(std::sync::atomic::Ordering::Acquire));
    // A displaced old owner must never clear someone else's identity or publish a release.
    let current = "f".repeat(32);
    c.lock_snapshot().unwrap().operation_id = Some(current.clone());
    drop(second);
    assert_eq!(c.view().unwrap().operation_id, Some(current));
}

#[tokio::test]
async fn terminal_notification_runs_after_actual_permit_release_and_shutdown_does_not_revive() {
    let c = UpdateCoordinator::default();
    let backend = Deferred::new(false);
    let candidate = c.check(&backend).await.unwrap().unwrap();
    let gate_free = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let seen = gate_free.clone();
    let observer = c.clone();
    c.bind_notifier(Arc::new(move |snapshot, _| {
        if snapshot.operation_id.is_none() {
            seen.store(
                observer.reserve_window_close().is_ok(),
                std::sync::atomic::Ordering::Release,
            );
        }
    }));
    backend.release.add_permits(1);
    c.confirm(
        &backend,
        &candidate.version,
        &candidate.candidate_id,
        false,
        || true,
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(gate_free.load(std::sync::atomic::Ordering::Acquire));
    c.shutdown();
    let c = UpdateCoordinator::default();
    let backend = Deferred::new(false);
    let candidate = c.check(&backend).await.unwrap().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    c.bind_notifier(Arc::new(move |_, _| {
        count.fetch_add(1, Ordering::AcqRel);
    }));
    let worker_state = c.clone();
    let worker_backend = backend.clone();
    let worker = tokio::spawn(async move {
        worker_state
            .confirm(
                &worker_backend,
                &candidate.version,
                &candidate.candidate_id,
                false,
                || true,
                |_| {},
            )
            .await
    });
    backend.entered().await;
    c.shutdown();
    let before = calls.load(Ordering::Acquire);
    backend.release.add_permits(1);
    worker.await.unwrap().unwrap_err();
    assert_eq!(calls.load(Ordering::Acquire), before);
    let terminal = c.view().unwrap();
    assert!(terminal.operation_id.is_none());
    assert!(terminal.candidate.is_none());
    assert!(c.lock_snapshot().unwrap().archive.is_none());
    assert!(c.notifier.lock().unwrap().is_none());
}

#[tokio::test]
async fn active_owner_reserves_a_final_sequence_even_when_progress_exhausts_the_rest() {
    let c = UpdateCoordinator::default();
    let backend = Deferred::new(false);
    let candidate = c.check(&backend).await.unwrap().unwrap();
    c.lock_snapshot().unwrap().sequence = MAX_SEQUENCE - 2;
    backend.release.add_permits(1);
    c.confirm(
        &backend,
        &candidate.version,
        &candidate.candidate_id,
        false,
        || true,
        |_| {},
    )
    .await
    .unwrap_err();
    let terminal = c.view().unwrap();
    assert_eq!(terminal.sequence, MAX_SEQUENCE);
    assert!(terminal.operation_id.is_none());
    assert_eq!(terminal.phase, Phase::Error);
    assert_eq!(terminal.error.unwrap().code, "download_failed");
    assert!(c.reserve_window_close().is_ok());
}

#[derive(Clone)]
struct Blocking {
    base: Deferred,
    gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
}
#[async_trait::async_trait]
impl UpdateBackend for Blocking {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.base.check().await
    }
    async fn install(
        &self,
        m: &UpdateMetadata,
        p: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        self.base.install(m, p).await
    }
    async fn download_archive(
        &self,
        _: &UpdateMetadata,
        _: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<VerifiedArchive, UpdateCommandError> {
        let base = self.base.clone();
        let gate = self.gate.clone();
        tokio::task::spawn_blocking(move || {
            base.active.fetch_add(1, Ordering::AcqRel);
            let _resource = Resource(base.active.clone());
            base.started.add_permits(1);
            let (lock, changed) = &*gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = changed.wait(released).unwrap();
            }
            Err(failure("download_failed"))
        })
        .await
        .unwrap()
    }
    async fn apply_archive(&self, a: Arc<VerifiedArchive>) -> Result<(), UpdateCommandError> {
        self.base.apply_archive(a).await
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        self.base.restart()
    }
}

#[tokio::test]
async fn dropped_ipc_awaiter_does_not_retire_an_actual_blocking_worker() {
    let c = UpdateCoordinator::default();
    let backend = Blocking {
        base: Deferred::new(false),
        gate: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
    };
    let candidate = c.check(&backend).await.unwrap().unwrap();
    let worker_state = c.clone();
    let worker_backend = backend.clone();
    let caller = tokio::spawn(async move {
        worker_state
            .install(
                &worker_backend,
                &candidate.version,
                &candidate.candidate_id,
                |_| {},
            )
            .await
    });
    backend.base.entered().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(c.operation_busy());
    assert!(c.view().unwrap().operation_id.is_some());
    assert_eq!(backend.base.active.load(Ordering::Acquire), 1);
    {
        let (lock, changed) = &*backend.gate;
        *lock.lock().unwrap() = true;
        changed.notify_all();
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        while c.operation_busy() || c.view().unwrap().operation_id.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(backend.base.active.load(Ordering::Acquire), 0);
    assert!(c.reserve_window_close().is_ok());
}
