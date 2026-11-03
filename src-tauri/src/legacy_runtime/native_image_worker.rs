//! Bounded blocking image work: permits stay inside the worker closure until it exits.
use super::native_image::{
    NativeImageCancellation, NativeImageEngine, NativeImageError, NativeImageSession, WorkerPermit,
};
use super::native_image_session::ImageSessionStore;
use std::{sync::Arc, time::Duration};

pub(super) const WORKER_DEADLINE: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub(super) enum WorkerFailure {
    Engine(NativeImageError),
    OpenTimedOut,
    TimedOut,
    Join,
}

struct CancellationGuard {
    token: NativeImageCancellation,
    armed: bool,
}

impl CancellationGuard {
    fn new(token: NativeImageCancellation) -> Self {
        Self { token, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn cancel(&mut self) {
        if self.armed {
            self.token.cancel();
            self.armed = false;
        }
    }
}

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct OpenWaitGuard<'a, F: Fn() -> bool> {
    cancellation: CancellationGuard,
    slot: &'a ImageSessionStore,
    store: &'a Arc<NativeImageSession>,
    engine: &'a NativeImageEngine,
    node_is_running: F,
    armed: bool,
}

impl<'a, F: Fn() -> bool> OpenWaitGuard<'a, F> {
    fn disarm(&mut self) {
        self.cancellation.disarm();
        self.armed = false;
    }

    fn cancel_and_retire(&mut self) {
        if self.armed {
            self.cancellation.cancel();
            self.slot
                .retire_timed_out_open(self.store, self.engine, (self.node_is_running)());
            self.armed = false;
        }
    }
}

impl<'a, F: Fn() -> bool> Drop for OpenWaitGuard<'a, F> {
    fn drop(&mut self) {
        self.cancel_and_retire();
    }
}

pub(super) fn worker_error(error: WorkerFailure) -> String {
    match error {
        WorkerFailure::Engine(error) => {
            format!("{}: {}", error.code(), error.message())
        }
        WorkerFailure::OpenTimedOut => "ERR_ATOOLS_NATIVE_IMAGE_TIMEOUT: Image open timed out; previous image handles were invalidated; reopen explicitly".into(),
        WorkerFailure::TimedOut => {
            "ERR_ATOOLS_NATIVE_IMAGE_TIMEOUT: Image operation timed out".into()
        }
        WorkerFailure::Join => "ERR_ATOOLS_NATIVE_IMAGE_WORKER: Image operation failed".into(),
    }
}

pub(super) async fn run_open_worker<T, F>(
    slot: &ImageSessionStore,
    store: &Arc<NativeImageSession>,
    engine: &NativeImageEngine,
    node_is_running: impl Fn() -> bool + Send + Sync,
    permit: WorkerPermit,
    work: F,
    deadline: Duration,
) -> Result<T, WorkerFailure>
where
    T: Send + 'static,
    F: FnOnce((NativeImageCancellation, WorkerPermit)) -> Result<T, NativeImageError>
        + Send
        + 'static,
{
    let token = NativeImageCancellation::default();
    let worker_token = token.clone();
    let mut guard = OpenWaitGuard {
        cancellation: CancellationGuard::new(token),
        slot,
        store,
        engine,
        node_is_running,
        armed: true,
    };
    let join = tokio::task::spawn_blocking(move || {
        let _worker_lease = permit.retain();
        work((worker_token, permit))
    });
    match tokio::time::timeout(deadline, join).await {
        Ok(Ok(result)) => {
            guard.disarm();
            result.map_err(WorkerFailure::Engine)
        }
        Ok(Err(_)) => {
            // A panicking worker could have committed immediately before the panic.
            // Retire the store so an unreturned handle cannot remain addressable.
            guard.cancel_and_retire();
            Err(WorkerFailure::Join)
        }
        Err(_) => {
            guard.cancel_and_retire();
            Err(WorkerFailure::OpenTimedOut)
        }
    }
}

pub(super) async fn run_worker<T, F>(
    permit: WorkerPermit,
    work: F,
    deadline: Duration,
    token: NativeImageCancellation,
) -> Result<T, WorkerFailure>
where
    T: Send + 'static,
    F: FnOnce(NativeImageCancellation, WorkerPermit) -> Result<T, NativeImageError>
        + Send
        + 'static,
{
    let worker_token = token.clone();
    let mut cancellation = CancellationGuard::new(token);
    let join = tokio::task::spawn_blocking(move || {
        let _worker_lease = permit.retain();
        work(worker_token, permit)
    });
    match tokio::time::timeout(deadline, join).await {
        Ok(Ok(result)) => {
            cancellation.disarm();
            result.map_err(WorkerFailure::Engine)
        }
        Ok(Err(_)) => {
            cancellation.disarm();
            Err(WorkerFailure::Join)
        }
        Err(_) => {
            cancellation.cancel();
            Err(WorkerFailure::TimedOut)
        }
    }
}
