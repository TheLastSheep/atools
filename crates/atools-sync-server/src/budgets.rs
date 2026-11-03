use std::sync::Arc;

use thiserror::Error;
use tokio::sync::Semaphore;

pub(crate) const MAX_WEBSOCKET_CONNECTIONS: usize = 16;
pub(crate) const MAX_AUTH_WORK: usize = 4;
pub(crate) const MAX_CONCURRENT_PUSHES: usize = 1;
pub(crate) const MAX_CONCURRENT_PULLS: usize = 4;
pub(crate) const MAX_AUXILIARY_DB_WORK: usize = 8;

pub(crate) struct SyncBudgets {
    pub websocket_connections: Arc<Semaphore>,
    pub auth_work: Arc<Semaphore>,
    pub pushes: Arc<Semaphore>,
    pub pulls: Arc<Semaphore>,
    pub auxiliary_db: Arc<Semaphore>,
}

impl SyncBudgets {
    pub(crate) fn new(
        websocket_connections: usize,
        auth_work: usize,
        pushes: usize,
        pulls: usize,
        auxiliary_db: usize,
    ) -> Self {
        Self {
            websocket_connections: Arc::new(Semaphore::new(websocket_connections)),
            auth_work: Arc::new(Semaphore::new(auth_work)),
            pushes: Arc::new(Semaphore::new(pushes)),
            pulls: Arc::new(Semaphore::new(pulls)),
            auxiliary_db: Arc::new(Semaphore::new(auxiliary_db)),
        }
    }
}

impl Default for SyncBudgets {
    fn default() -> Self {
        Self::new(
            MAX_WEBSOCKET_CONNECTIONS,
            MAX_AUTH_WORK,
            MAX_CONCURRENT_PUSHES,
            MAX_CONCURRENT_PULLS,
            MAX_AUXILIARY_DB_WORK,
        )
    }
}

#[derive(Debug, Error)]
pub(crate) enum BoundedTaskError {
    #[error("work capacity is full")]
    Busy,
    #[error("blocking worker failed")]
    Worker,
}

/// Keep admission charged until blocking work really finishes, even if the
/// async caller is cancelled while SQLite or bcrypt is still running.
pub(crate) async fn run_bounded<T, F>(
    budget: Arc<Semaphore>,
    operation: F,
) -> Result<T, BoundedTaskError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let permit = budget
        .try_acquire_owned()
        .map_err(|_| BoundedTaskError::Busy)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| BoundedTaskError::Worker)
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, time::Duration};

    use super::*;

    #[test]
    fn each_work_class_rejects_over_budget_and_releases_on_drop() {
        let budgets = SyncBudgets::new(2, 1, 1, 2, 3);
        assert_capacity(&budgets.websocket_connections, 2);
        assert_capacity(&budgets.auth_work, 1);
        assert_capacity(&budgets.pushes, 1);
        assert_capacity(&budgets.pulls, 2);
        assert_capacity(&budgets.auxiliary_db, 3);
    }

    #[test]
    fn production_limits_are_explicit_and_match_the_sync_contract() {
        let budgets = SyncBudgets::default();
        assert_eq!(
            budgets.websocket_connections.available_permits(),
            MAX_WEBSOCKET_CONNECTIONS
        );
        assert_eq!(budgets.auth_work.available_permits(), MAX_AUTH_WORK);
        assert_eq!(budgets.pushes.available_permits(), MAX_CONCURRENT_PUSHES);
        assert_eq!(budgets.pulls.available_permits(), MAX_CONCURRENT_PULLS);
        assert_eq!(
            budgets.auxiliary_db.available_permits(),
            MAX_AUXILIARY_DB_WORK
        );
    }

    fn assert_capacity(semaphore: &Arc<Semaphore>, capacity: usize) {
        let permits = (0..capacity)
            .map(|_| Arc::clone(semaphore).try_acquire_owned().unwrap())
            .collect::<Vec<_>>();
        assert!(Arc::clone(semaphore).try_acquire_owned().is_err());
        drop(permits);
        assert!(Arc::clone(semaphore).try_acquire_owned().is_ok());
    }

    #[tokio::test]
    async fn cancelled_waiter_keeps_its_slot_until_blocking_work_finishes() {
        let budget = Arc::new(Semaphore::new(1));
        let (started, started_rx) = mpsc::sync_channel(1);
        let (release, release_rx) = mpsc::sync_channel(1);
        let worker_budget = Arc::clone(&budget);
        let task = tokio::spawn(async move {
            run_bounded(worker_budget, move || {
                started.send(()).unwrap();
                let _ = release_rx.recv();
            })
            .await
        });
        let observed =
            tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(2)))
                .await
                .unwrap();
        if observed.is_err() {
            task.abort();
            let _ = release.send(());
            panic!("blocking operation did not start within the test deadline");
        }
        task.abort();
        let _ = task.await;
        let stayed_reserved = matches!(
            run_bounded(Arc::clone(&budget), || ()).await,
            Err(BoundedTaskError::Busy)
        );
        let _ = release.send(());
        assert!(
            stayed_reserved,
            "cancelled caller released a live worker slot"
        );

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if Arc::clone(&budget).try_acquire_owned().is_ok() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking work should release its slot after completion");
    }
}
