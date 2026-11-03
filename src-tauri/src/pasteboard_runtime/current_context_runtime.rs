//! Serialized blocking adapters for live clipboard snapshots and their request projection.
use super::current_context::{
    now_epoch_ms, parse_timestamp_ms, project_snapshot, sleep_until_recheck, validate_time_limit,
    within_time_limit, LastCopiedContent, INVALID_TIMESTAMP, SNAPSHOT_WAIT,
};
use super::model::{NativePasteboardSnapshot, PasteboardBackend};
use super::runtime_ops::PasteboardRuntime;
use parking_lot::Mutex;
use std::{future::Future, sync::Arc};

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct CurrentContextObservation {
    pub(super) change_count: Option<i64>,
    pub(super) timestamp_ms: Option<u64>,
}

#[derive(Clone, Debug)]
pub(super) struct ObservedSnapshot {
    pub(super) snapshot: NativePasteboardSnapshot,
    pub(super) timestamp_ms: Option<u64>,
}

const SNAPSHOT_WORKER_FAILED: &str = "CLIPBOARD_CONTEXT_UNAVAILABLE: clipboard worker failed";

impl PasteboardRuntime {
    pub(crate) async fn read_current_context(
        &self,
        time_limit_ms: Option<f64>,
    ) -> Result<Option<LastCopiedContent>, String> {
        let time_limit = validate_time_limit(time_limit_ms).map_err(str::to_string)?;
        let deadline = tokio::time::Instant::now() + SNAPSHOT_WAIT;
        let mut known_change_count = None;
        let mut read_snapshot = true;

        loop {
            if !read_snapshot {
                let Some(change_count) = self.read_current_change_count(deadline).await? else {
                    return Ok(None);
                };
                if change_count == known_change_count {
                    if tokio::time::Instant::now() >= deadline {
                        return Ok(None);
                    }
                    sleep_until_recheck(deadline).await;
                    continue;
                }
            }
            read_snapshot = false;

            if let Some(observed) = self.read_current_snapshot(deadline).await? {
                known_change_count = Some(observed.snapshot.change_count);
                let timestamp = observed
                    .timestamp_ms
                    .ok_or_else(|| INVALID_TIMESTAMP.to_string())?;
                if within_time_limit(timestamp, time_limit, now_epoch_ms()?) {
                    if let Some(content) = self
                        .project_current_snapshot(observed.snapshot, timestamp)
                        .await?
                    {
                        return Ok(Some(content));
                    }
                }
            } else {
                known_change_count = None;
                read_snapshot = true;
            }

            if tokio::time::Instant::now() >= deadline {
                return Ok(None);
            }
            sleep_until_recheck(deadline).await;
        }
    }

    pub(super) async fn snapshot_if_changed_observed(
        &self,
        previous_change_count: i64,
    ) -> Result<Option<ObservedSnapshot>, String> {
        let snapshot_guard = self.snapshot_gate.clone().lock_owned().await;
        self.run_with_snapshot_gate(snapshot_guard, move |backend, observation| async move {
            Ok(backend
                .snapshot_if_changed(previous_change_count)
                .await?
                .map(|snapshot| observe_snapshot(&observation, snapshot)))
        })
        .await
    }

    async fn read_current_snapshot(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<Option<ObservedSnapshot>, String> {
        let Some(snapshot_guard) = self.lock_snapshot_gate_until(deadline).await else {
            return Ok(None);
        };
        self.run_with_snapshot_gate(snapshot_guard, |backend, observation| async move {
            Ok(backend
                .current_context_snapshot()
                .await?
                .map(|snapshot| observe_snapshot(&observation, snapshot)))
        })
        .await
    }

    async fn read_current_change_count(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<Option<Option<i64>>, String> {
        let Some(snapshot_guard) = self.lock_snapshot_gate_until(deadline).await else {
            return Ok(None);
        };
        let count = self
            .run_with_snapshot_gate(snapshot_guard, |backend, _observation| async move {
                backend.current_change_count().await
            })
            .await?;
        Ok(Some(count))
    }

    async fn lock_snapshot_gate_until(
        &self,
        deadline: tokio::time::Instant,
    ) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        tokio::time::timeout(remaining, self.snapshot_gate.clone().lock_owned())
            .await
            .ok()
    }

    pub(super) async fn project_current_snapshot(
        &self,
        snapshot: NativePasteboardSnapshot,
        timestamp: u64,
    ) -> Result<Option<LastCopiedContent>, String> {
        tokio::task::spawn_blocking(move || project_snapshot(snapshot, timestamp))
            .await
            .map_err(|_| SNAPSHOT_WORKER_FAILED.to_string())?
    }

    async fn run_with_snapshot_gate<T, F, Fut>(
        &self,
        snapshot_guard: tokio::sync::OwnedMutexGuard<()>,
        operation: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(Arc<dyn PasteboardBackend>, Arc<Mutex<CurrentContextObservation>>) -> Fut
            + Send
            + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        let backend = Arc::clone(&self.backend);
        let observation = Arc::clone(&self.current_context_observation);
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let _snapshot_guard = snapshot_guard;
            runtime.block_on(operation(backend, observation))
        })
        .await
        .map_err(|_| SNAPSHOT_WORKER_FAILED.to_string())?
    }
}

pub(super) fn observe_snapshot(
    observation: &Mutex<CurrentContextObservation>,
    snapshot: NativePasteboardSnapshot,
) -> ObservedSnapshot {
    let timestamp_ms = {
        let mut observation = observation.lock();
        if observation.change_count == Some(snapshot.change_count) {
            observation.timestamp_ms
        } else {
            observation.change_count = Some(snapshot.change_count);
            observation.timestamp_ms = parse_timestamp_ms(&snapshot.copied_at).ok();
            observation.timestamp_ms
        }
    };
    ObservedSnapshot {
        snapshot,
        timestamp_ms,
    }
}
