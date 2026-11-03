//! Actual blocking work remains charged until it really returns, including after timeout/cancel.
use super::*;
use std::time::Duration;
const BUDGET: Duration = Duration::from_secs(2);
pub(super) fn start(app: AppHandle, r: Arc<Runtime>, mut job: state::Job) {
    tauri::async_runtime::spawn(async move {
        loop {
            let check = r.clone();
            let expected = job.clone();
            let paths = job.paths.clone();
            let mut worker = tauri::async_runtime::spawn_blocking(move || {
                metadata::collect(&paths, || check.state.lock().matches(&expected))
            });
            if let Some(result) =
                await_actual(&mut worker, BUDGET, || publish(&app, &r, &job, vec![])).await
            {
                publish(&app, &r, &job, result.unwrap_or_default());
            }
            // Even an obsolete or timed-out task must reach this actual join before releasing its slot.
            let next = r.state.lock().finished();
            match next {
                Some(next) => job = next,
                None => break,
            }
        }
    });
}
fn publish(app: &AppHandle, r: &Arc<Runtime>, job: &state::Job, files: Vec<protocol::FileEntry>) {
    let app = app.clone();
    let scheduled = app.clone();
    let r = r.clone();
    let job = job.clone();
    let _ = scheduled.run_on_main_thread(move || {
        if !current(&app) || settings_present(&app) {
            return;
        }
        super::delivery::publish_result(&r, &job, files, |notice| emit(&app, notice));
    });
}

// Actual caller seam: timeout reports failure but cannot release the underlying worker slot.
async fn await_actual<F: std::future::Future + Unpin>(
    worker: &mut F,
    budget: Duration,
    timeout: impl FnOnce(),
) -> Option<F::Output> {
    match tokio::time::timeout(budget, &mut *worker).await {
        Ok(result) => Some(result),
        Err(_) => {
            timeout();
            let _ = worker.await;
            None
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn timed_out_actual_worker_must_join_before_caller_can_release_slot() {
        let (send, receive) = std::sync::mpsc::channel::<()>();
        let mut worker = tokio::task::spawn_blocking(move || receive.recv().unwrap());
        let (timed_out, signal) = tokio::sync::oneshot::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let result = await_actual(&mut worker, Duration::from_millis(1), || {
                let _ = timed_out.send(());
            })
            .await;
            let _ = finished.send(());
            result
        });
        signal.await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(5), done)
            .await
            .is_err());
        send.send(()).unwrap();
        assert!(task.await.unwrap().is_none());
    }
}
