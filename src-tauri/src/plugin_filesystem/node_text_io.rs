//! Bounded blocking worker shared by synchronous Node-compatible file calls.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const MAX_CONCURRENT_OPERATIONS: usize = 2;
const IO_DEADLINE: Duration = Duration::from_secs(5);
static OPERATIONS: OnceLock<Arc<Semaphore>> = OnceLock::new();

pub(super) async fn run<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(IoGuard) -> Result<T, String> + Send + 'static,
{
    run_with_deadline(operation, IO_DEADLINE).await
}

pub(super) async fn run_with_deadline<T, F>(operation: F, deadline: Duration) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(IoGuard) -> Result<T, String> + Send + 'static,
{
    let permits =
        Arc::clone(OPERATIONS.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_OPERATIONS))));
    run_with_pool(operation, deadline, permits).await
}

async fn run_with_pool<T, F>(
    operation: F,
    deadline: Duration,
    permits: Arc<Semaphore>,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(IoGuard) -> Result<T, String> + Send + 'static,
{
    let guard = IoGuard::new(Instant::now() + deadline);
    let cancel_on_drop = CancelOnDrop(guard.clone());
    let result = tokio::time::timeout(deadline, async move {
        let permit = permits
            .acquire_owned()
            .await
            .map_err(|_| native_error("EIO"))?;
        guard.ensure_current()?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            guard.ensure_current()?;
            operation(guard)
        })
        .await
        .map_err(|_| native_error("EIO"))?
    })
    .await
    .map_err(|_| native_error("ETIMEDOUT"))?;
    drop(cancel_on_drop);
    result
}

#[derive(Clone)]
pub(super) struct IoGuard(Arc<IoGuardState>);

struct IoGuardState {
    cancelled: AtomicBool,
    deadline: Instant,
}

impl IoGuard {
    fn new(deadline: Instant) -> Self {
        Self(Arc::new(IoGuardState {
            cancelled: AtomicBool::new(false),
            deadline,
        }))
    }

    pub(super) fn ensure_current(&self) -> Result<(), String> {
        if Instant::now() >= self.0.deadline {
            return Err(native_error("ETIMEDOUT"));
        }
        if self.0.cancelled.load(Ordering::Acquire) {
            return Err(native_error("EACCES"));
        }
        Ok(())
    }

    fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

struct CancelOnDrop(IoGuard);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

fn native_error(code: &str) -> String {
    format!("ERR_ATOOLS_NATIVE_FS:{code}")
}

#[cfg(test)]
#[path = "node_text_io_tests.rs"]
mod tests;
