use super::types::{FrameBinding, Owner, Request, Tombstone, MAX_REQUESTS};
const MAX_TOMBSTONES: usize = 16;
use parking_lot::Mutex;
use std::{collections::HashMap, sync::Arc, time::Instant};
use tokio::sync::Semaphore;

#[derive(Default)]
pub(super) struct Store {
    pub requests: HashMap<String, Arc<Request>>,
    pub by_client: HashMap<(Owner, String), String>,
    pub tombstones: HashMap<(Owner, String), Tombstone>,
    pub timers: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    pub stopped: bool,
}
pub(crate) struct Runtime {
    pub(super) store: Mutex<Store>,
    pub(super) running: Arc<Semaphore>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            store: Mutex::new(Store::default()),
            running: Arc::new(Semaphore::new(super::types::MAX_RUNNING)),
        }
    }
}
impl Runtime {
    pub(super) fn insert(&self, request: Arc<Request>) -> Result<(), String> {
        let mut store = self.store.lock();
        store.tombstones.retain(|_, t| t.expires > Instant::now());
        let key = (request.owner.clone(), request.client_id.clone());
        if store.stopped
            || store.requests.len() >= MAX_REQUESTS
            || store.by_client.contains_key(&key)
        {
            return Err("AI request capacity or client identity conflict".into());
        }
        if store.requests.values().any(|current| {
            current.owner.plugin == request.owner.plugin && !*current.task_terminal.lock()
        }) {
            return Err("A plugin AI request is already active for this plugin".into());
        }
        if store
            .tombstones
            .remove(&key)
            .is_some_and(|t| t.expires > Instant::now() && t.frame == request.frame)
        {
            return Err("AI request was cancelled before preparation completed".into());
        }
        store.by_client.insert(key, request.id.clone());
        store.requests.insert(request.id.clone(), request);
        Ok(())
    }
    pub(super) fn get(&self, id: &str) -> Result<Arc<Request>, String> {
        self.store
            .lock()
            .requests
            .get(id)
            .cloned()
            .ok_or_else(|| "AI request expired or unknown".into())
    }
    pub(super) fn get_optional(&self, id: &str) -> Option<Arc<Request>> {
        self.store.lock().requests.get(id).cloned()
    }
    pub(super) fn contains(&self, request: &Arc<Request>) -> bool {
        self.store
            .lock()
            .requests
            .get(&request.id)
            .is_some_and(|r| Arc::ptr_eq(r, request))
    }
    pub(super) fn is_current(&self, request: &Arc<Request>) -> bool {
        self.contains(request) && request.valid()
    }
    pub(super) fn remove(&self, id: &str) -> Option<Arc<Request>> {
        let mut s = self.store.lock();
        if let Some(t) = s.timers.remove(id) {
            t.abort()
        }
        let r = s.requests.remove(id)?;
        s.by_client.remove(&(r.owner.clone(), r.client_id.clone()));
        Some(r)
    }
    pub(super) fn cancel_client(
        &self,
        owner: &Owner,
        frame: &FrameBinding,
        client: &str,
    ) -> Result<Option<Arc<Request>>, String> {
        let mut s = self.store.lock();
        let key = (owner.clone(), client.to_owned());
        s.tombstones
            .retain(|_, tombstone| tombstone.expires > Instant::now());
        let Some(id) = s.by_client.get(&key).cloned() else {
            if s.tombstones.len() >= MAX_TOMBSTONES && !s.tombstones.contains_key(&key) {
                return Err("AI cancellation capacity is saturated".into());
            }
            s.tombstones.insert(
                key,
                Tombstone {
                    owner: owner.clone(),
                    frame: frame.clone(),
                    expires: Instant::now() + super::types::PREPARED_LEASE,
                },
            );
            return Ok(None);
        };
        let Some(current) = s.requests.get(&id) else {
            s.by_client.remove(&key);
            return Ok(None);
        };
        if current.frame != *frame {
            return Err("AI request identity mismatch".into());
        }
        if let Some(timer) = s.timers.remove(&id) {
            timer.abort()
        }
        let r = s.requests.remove(&id).ok_or("AI request disappeared")?;
        s.by_client.remove(&key);
        Ok(Some(r))
    }
    pub(super) fn close_matching(
        &self,
        plugin: Option<&str>,
        window: Option<&str>,
        document: Option<&str>,
        stop: bool,
    ) -> Vec<Arc<Request>> {
        let mut store = self.store.lock();
        if stop {
            store.stopped = true;
        }
        let ids = store
            .requests
            .iter()
            .filter_map(|(id, r)| {
                let matched = plugin.is_none_or(|p| r.owner.plugin == p)
                    && window.is_none_or(|w| r.owner.window == w)
                    && document
                        .is_none_or(|d| r.document.as_ref().is_some_and(|doc| doc.id() == d));
                matched.then_some(id.clone())
            })
            .collect::<Vec<_>>();
        let mut removed = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(timer) = store.timers.remove(&id) {
                timer.abort();
            }
            if let Some(request) = store.requests.remove(&id) {
                store
                    .by_client
                    .remove(&(request.owner.clone(), request.client_id.clone()));
                removed.push(request);
            }
        }
        if stop {
            store.tombstones.clear();
        } else {
            store.tombstones.retain(|_, t| {
                plugin.is_none_or(|p| t.owner.plugin != p)
                    && window.is_none_or(|w| t.owner.window != w)
                    && document.is_none_or(|d| t.frame.page_document_id.as_deref() != Some(d))
            });
        }
        removed
    }
    pub(super) fn counts(&self) -> (usize, usize, usize, usize, usize) {
        let store = self.store.lock();
        let acknowledgements = store
            .requests
            .values()
            .filter(|r| r.ack.lock().is_some())
            .count();
        (
            store.requests.len(),
            store.by_client.len(),
            store.timers.len(),
            acknowledgements,
            store.tombstones.len(),
        )
    }
    pub(super) fn tracks_run(&self, run_id: &str) -> bool {
        self.store
            .lock()
            .requests
            .values()
            .any(|request| request.run_id.lock().as_deref() == Some(run_id))
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
