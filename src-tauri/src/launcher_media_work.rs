//! At most two media reads/stat/validation jobs. Rejection has no waiting queue or retry poll.
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
pub(crate) type Permit = Arc<OwnedSemaphorePermit>;
static WORK: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));
pub(crate) fn try_permit() -> Result<Permit, String> {
    acquire(&WORK)
}
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn available_permits_for_smoke() -> usize {
    WORK.available_permits()
}
pub(crate) fn acquire(semaphore: &Arc<Semaphore>) -> Result<Permit, String> {
    semaphore
        .clone()
        .try_acquire_owned()
        .map(Arc::new)
        .map_err(|_| "MEDIA_INPUT_BUSY: 媒体处理繁忙，请稍后重试".into())
}
pub(crate) async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let permit = try_permit()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| "MEDIA_INPUT_UNAVAILABLE: media validation did not complete".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn two_slots_reject_the_whole_next_job_without_waiting_and_release_on_failure() {
        let semaphore = Arc::new(Semaphore::new(2));
        let first = acquire(&semaphore).unwrap();
        let second = acquire(&semaphore).unwrap();
        assert_eq!(semaphore.available_permits(), 0);
        assert!(acquire(&semaphore)
            .unwrap_err()
            .starts_with("MEDIA_INPUT_BUSY:"));
        let failed: Result<(), String> = {
            let _permit = first;
            Err("fixed error".into())
        };
        assert!(failed.is_err());
        assert_eq!(semaphore.available_permits(), 1);
        let recovered = acquire(&semaphore).unwrap();
        drop(second);
        drop(recovered);
        assert_eq!(semaphore.available_permits(), 2);
    }
    #[tokio::test]
    async fn cancelled_waiter_cannot_release_a_still_running_blocking_read_slot() {
        let semaphore = Arc::new(Semaphore::new(2));
        let permit = acquire(&semaphore).unwrap();
        let held = acquire(&semaphore).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || {
                let held = permit;
                let _ = started_tx.send(());
                let _ = stop_rx.recv();
                drop(held);
                let _ = finished_tx.send(());
            })
            .await;
        });
        started_rx.await.unwrap();
        task.abort();
        assert!(acquire(&semaphore).is_err());
        stop_tx.send(()).unwrap();
        drop(held);
        finished_rx.await.unwrap();
        assert_eq!(semaphore.available_permits(), 2);
    }
}
