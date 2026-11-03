use super::run_with_pool;
use std::{
    sync::{mpsc, Arc},
    time::Duration,
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn timed_out_blocking_work_keeps_its_shared_permit_until_completion() {
    let permits = Arc::new(Semaphore::new(1));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (worker_exit_tx, worker_exit_rx) = mpsc::channel();
    let task = tokio::spawn({
        let permits = Arc::clone(&permits);
        async move {
            run_with_pool(
                move |guard| {
                    let _worker_exit = WorkerExit(worker_exit_tx);
                    guard.ensure_current()?;
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    guard.ensure_current()
                },
                Duration::from_millis(100),
                permits,
            )
            .await
        }
    });
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(1)).unwrap())
        .await
        .unwrap();
    let result = task.await.unwrap();

    assert_eq!(result.unwrap_err(), "ERR_ATOOLS_NATIVE_FS:ETIMEDOUT");
    assert_eq!(permits.available_permits(), 0);
    release_tx.send(()).unwrap();
    tokio::task::spawn_blocking(move || {
        worker_exit_rx.recv_timeout(Duration::from_secs(1)).unwrap()
    })
    .await
    .unwrap();
    let released = tokio::time::timeout(Duration::from_secs(1), permits.clone().acquire_owned())
        .await
        .unwrap()
        .unwrap();
    drop(released);
    assert_eq!(permits.available_permits(), 1);
}

struct WorkerExit(mpsc::Sender<()>);

impl Drop for WorkerExit {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}
