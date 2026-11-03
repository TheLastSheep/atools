use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub(super) struct NativeOperations(Arc<NativeOperationsInner>);

#[derive(Default)]
struct NativeOperationsInner {
    in_flight: AtomicUsize,
    finished: Notify,
}

struct OperationGuard(NativeOperations);

impl NativeOperations {
    pub(super) async fn run<T, F>(&self, operation: F) -> Result<T, ()>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let guard = self.begin();
        let task = tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            operation()
        });
        task.await.map_err(|_| ())
    }

    pub(super) async fn wait_until_idle(&self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let finished = self.0.finished.notified();
            tokio::pin!(finished);
            if self.0.in_flight.load(Ordering::Acquire) == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, finished).await.is_err() {
                return false;
            }
        }
    }

    fn begin(&self) -> OperationGuard {
        self.0.in_flight.fetch_add(1, Ordering::AcqRel);
        OperationGuard(self.clone())
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if self.0 .0.in_flight.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0 .0.finished.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::NativeOperations;
    use std::sync::mpsc;
    use std::time::Duration;

    #[tokio::test]
    async fn dropped_waiter_stays_nonterminal_until_blocking_work_finishes() {
        let operations = NativeOperations::default();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = mpsc::channel();
        let pending = operations.clone();
        let caller = tokio::spawn(async move {
            pending
                .run(move || {
                    let _ = started.send(());
                    let _ = release_rx.recv();
                })
                .await
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());

        assert!(!operations.wait_until_idle(Duration::from_millis(10)).await);
        release.send(()).unwrap();
        assert!(operations.wait_until_idle(Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn completed_blocking_work_is_terminal_even_if_the_result_was_an_error() {
        let operations = NativeOperations::default();
        let result = operations.run(|| Err::<(), _>("fixed failure")).await;
        assert_eq!(result.unwrap(), Err("fixed failure"));
        assert!(operations.wait_until_idle(Duration::from_millis(10)).await);
    }
}
