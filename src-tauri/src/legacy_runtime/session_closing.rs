use super::{Session, Sessions};
use crate::plugin_page_runtime::DocumentBinding;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{atomic::Ordering, Arc};
use std::time::Instant;

#[derive(Default)]
pub(super) struct StopCompletion {
    result: tokio::sync::Mutex<Option<Result<(), String>>>,
}

impl StopCompletion {
    async fn stop_session(&self, session: &Session) -> Result<(), String> {
        self.run_once(|| async {
            session
                .runtime
                .stop()
                .await
                .map_err(|error| error.to_string())
        })
        .await
    }

    async fn run_once<F, Fut>(&self, stop: F) -> Result<(), String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        let mut result = self.result.lock().await;
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
        let stopped = stop().await;
        *result = Some(stopped.clone());
        stopped
    }
}

pub(crate) struct OwnerCloseReport {
    pub(crate) runs: Vec<String>,
    pub(crate) result: Result<(), String>,
}

impl Sessions {
    /// Stop before removing the session. Concurrent callers share one shutdown
    /// result; failed shutdowns remain tracked as closed and are reported again.
    pub async fn remove_strict(&self, id: &str) -> Result<(), String> {
        let session = { self.sessions.read().get(id).cloned() };
        let Some(session) = session else {
            self.maybe_idle_transport().await;
            return Ok(());
        };
        session.mark_closing();
        session.native_image_store.close();

        let completion = {
            let mut completions = self.stop_completions.lock();
            completions
                .entry(id.to_owned())
                .or_insert_with(|| Arc::new(StopCompletion::default()))
                .clone()
        };
        remove_after_stop(&self.sessions, id, &session, || {
            completion.stop_session(&session)
        })
        .await
        .map_err(|error| format!("Node session {id} did not stop cleanly: {error}"))?;
        self.stop_completions.lock().remove(id);
        self.maybe_idle_transport().await;
        Ok(())
    }

    /// Legacy cleanup callers retain their best-effort API. Permissioned close
    /// commands use `remove_strict` and surface its failure to the caller.
    pub async fn remove(&self, id: &str) {
        let _ = self.remove_strict(id).await;
    }

    #[cfg(test)]
    pub async fn close_owner(&self, owner: &str, plugin_id: Option<&str>) -> Vec<String> {
        self.close_owner_report(owner, plugin_id, None).await.runs
    }

    #[cfg(test)]
    pub async fn close_document_owner(
        &self,
        owner: &str,
        plugin: &str,
        page_id: &str,
    ) -> Vec<String> {
        self.close_owner_report(owner, Some(plugin), Some(page_id))
            .await
            .runs
    }

    pub(crate) async fn close_owner_report(
        &self,
        owner: &str,
        plugin_id: Option<&str>,
        page_id: Option<&str>,
    ) -> OwnerCloseReport {
        let matches = |candidate: &str, document: &Option<DocumentBinding>| {
            plugin_id.is_none_or(|id| id == candidate)
                && page_id.is_none_or(|id| document.as_ref().is_some_and(|d| d.id() == id))
        };
        for session in self.sessions.read().values().filter(|session| {
            session.owner == owner && matches(&session.plugin_id, &session.document)
        }) {
            session.mark_closing();
        }
        if page_id.is_none() {
            let mut cancelled = self.cancelled_owners.lock();
            cancelled.retain(|_, at| at.elapsed().as_secs() < 600);
            // UI instance identifiers are never reused. Keep a bounded cancellation
            // history to reject a delayed prepare that arrives after its close.
            if cancelled.len() >= 512 {
                if let Some(oldest) = cancelled
                    .iter()
                    .min_by_key(|(_, at)| **at)
                    .map(|(key, _)| key.clone())
                {
                    cancelled.remove(&oldest);
                }
            }
            cancelled.insert(owner.into(), Instant::now());
        }
        let mut runs = Vec::new();
        self.intents.lock().retain(|_, intent| {
            if intent.owner == owner && matches(&intent.plugin_id, &intent.document) {
                intent.cancelled.store(true, Ordering::Release);
                if let Some(id) = intent.run_id.lock().clone() {
                    runs.push(id);
                }
                false
            } else {
                true
            }
        });
        if let Some((id, cancel, document)) = self.openings.lock().get(owner) {
            if matches(id, document) {
                cancel.store(true, Ordering::Release);
            }
        }

        let _transition = self.transition.lock().await;
        let ids: Vec<_> = self
            .sessions
            .read()
            .values()
            .filter(|session| {
                session.owner == owner && matches(&session.plugin_id, &session.document)
            })
            .map(|session| session.id.clone())
            .collect();
        let result =
            close_ids_in_order(ids, |id| async move { self.remove_strict(&id).await }).await;
        self.maybe_idle_transport().await;
        OwnerCloseReport { runs, result }
    }
}

async fn remove_after_stop<T, F, Fut>(
    sessions: &RwLock<HashMap<String, Arc<T>>>,
    id: &str,
    expected: &Arc<T>,
    stop: F,
) -> Result<(), String>
where
    T: Send + Sync + 'static,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    stop().await?;
    let removed = {
        let mut sessions = sessions.write();
        match sessions.get(id) {
            Some(current) if Arc::ptr_eq(current, expected) => sessions.remove(id),
            Some(_) => return Err(format!("Node session identity changed while closing {id}")),
            None => None,
        }
    };
    drop(removed);
    Ok(())
}

async fn close_ids_in_order<F, Fut>(ids: Vec<String>, mut close: F) -> Result<(), String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut first_error = None;
    for id in ids {
        if let Err(error) = close(id).await {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
#[path = "session_close_state_tests.rs"]
mod tests;
