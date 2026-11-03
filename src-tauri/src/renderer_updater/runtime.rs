//! One popup generation. Revocation keeps its quota until actual native destruction.
use super::bundle::Bundle;
use parking_lot::Mutex;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
#[derive(Clone)]
pub(super) struct Session {
    pub id: String,
    pub presentation: Option<crate::updater::PresentationLease>,
    pub presented: Arc<AtomicBool>,
    pub label: String,
    pub bundle: Arc<Bundle>,
    pub alive: Arc<AtomicBool>,
    pub closing: Arc<AtomicBool>,
    pub confirming: Arc<AtomicBool>,
    pub close_running: Arc<AtomicBool>,
    #[cfg(test)]
    close_wait_gap: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
    pub destroyed: Arc<AtomicBool>,
    pub destroy_queued: Arc<AtomicBool>,
    pub closed: Arc<tokio::sync::Notify>,
    pub ready: bool,
    pub candidate: Option<String>,
    pub index_served: bool,
    pub navigation_seen: bool,
    pub hidden: bool,
    pub last_sequence: u64,
    pub appearance_sequence: Arc<AtomicU64>,
    pub appearance_requested: Arc<AtomicU64>,
    pub appearance_gate: Arc<tokio::sync::Mutex<()>>,
    pub appearance_value: Arc<Mutex<Option<super::appearance::Appearance>>>,
    pub appearance_error: Arc<Mutex<Option<super::Error>>>,
    pub appearance_changed: Arc<tokio::sync::Notify>,
    pub appearance_config: Arc<Mutex<Option<super::appearance::Config>>>,
    pub material_owned: Arc<AtomicBool>,
}
impl Session {
    // Preserve the existing algorithm: Notify1.52.3 broadcasts cover already-created futures.
    pub async fn wait_closed(&self) {
        loop {
            let closed = self.closed.notified();
            if self.destroyed.load(Ordering::Acquire) {
                return;
            }
            #[cfg(test)]
            {
                let gap = self.close_wait_gap.lock().take();
                if let Some(gap) = gap {
                    gap();
                }
            }
            closed.await;
        }
    }
    pub fn new(id: String, bundle: Arc<Bundle>, hidden: bool, candidate: String) -> Self {
        Self {
            id: id.clone(),
            presentation: None,
            presented: Arc::new(AtomicBool::new(false)),
            label: format!("renderer-updater-{id}"),
            bundle,
            alive: Arc::new(AtomicBool::new(true)),
            closing: Arc::new(AtomicBool::new(false)),
            confirming: Arc::new(AtomicBool::new(false)),
            close_running: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            close_wait_gap: Arc::new(Mutex::new(None)),
            destroyed: Arc::new(AtomicBool::new(false)),
            destroy_queued: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(tokio::sync::Notify::new()),
            ready: false,
            candidate: Some(candidate),
            index_served: false,
            navigation_seen: false,
            hidden,
            last_sequence: 0,
            appearance_sequence: Arc::new(AtomicU64::new(0)),
            appearance_requested: Arc::new(AtomicU64::new(0)),
            appearance_gate: Arc::new(tokio::sync::Mutex::new(())),
            appearance_value: Arc::new(parking_lot::Mutex::new(None)),
            appearance_error: Arc::new(parking_lot::Mutex::new(None)),
            appearance_changed: Arc::new(tokio::sync::Notify::new()),
            appearance_config: Arc::new(parking_lot::Mutex::new(None)),
            material_owned: Arc::new(AtomicBool::new(false)),
        }
    }
}
#[derive(Default)]
pub(super) struct Runtime {
    pub session: Mutex<Option<Session>>,
    pub opening: AtomicBool,
    pub acl_installed: AtomicBool,
    pub publisher_bound: AtomicBool,
    pub delivery: Mutex<()>,
    pub stopped: AtomicBool,
    #[cfg(test)]
    revoke_attempt: Mutex<Option<std::sync::mpsc::Sender<bool>>>,
}
impl Runtime {
    pub fn reusable_session(&self) -> Result<Option<Session>, super::Error> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(super::error("operation_interrupted"));
        }
        if self.opening.load(Ordering::Acquire) {
            return Err(super::error("busy"));
        }
        let session = self.session.lock().clone();
        if session.as_ref().is_some_and(|s| {
            !s.presented.load(Ordering::Acquire)
                || !s.alive.load(Ordering::Acquire)
                || s.closing.load(Ordering::Acquire)
        }) {
            return Err(super::error("busy"));
        }
        Ok(session)
    }

    // delivery -> short state read, then emit without State; delivery covers the final enqueue.
    // Native close/navigation/Exit use the same gate and cannot overtake publication.
    pub fn enqueue_snapshot(
        &self,
        snapshot: &crate::updater::snapshot::Snapshot,
        emit: impl FnOnce(&Session, &crate::updater::snapshot::Snapshot) -> bool,
    ) {
        let _delivery = self.delivery.lock();
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let current = {
            self.session
                .lock()
                .as_ref()
                .filter(|s| {
                    s.ready
                        && s.alive.load(Ordering::Acquire)
                        && !s.closing.load(Ordering::Acquire)
                        && snapshot.sequence > s.last_sequence
                })
                .cloned()
        };
        if let Some(current) = current {
            if emit(&current, snapshot) {
                if let Some(s) = self.session.lock().as_mut().filter(|s| s.id == current.id) {
                    s.candidate = snapshot.candidate.as_ref().map(|m| m.candidate_id.clone());
                    s.last_sequence = snapshot.sequence;
                }
            }
        }
    }
    pub fn authorize_displayed(
        &self,
        id: &str,
        candidate: &str,
        current: impl FnOnce() -> Result<(String, String), super::Error>,
    ) -> Result<String, super::Error> {
        let _delivery = self.delivery.lock();
        let selected = current()?; // Core getter releases State before returning. No Native/window calls here.
        let sessions = self.session.lock();
        let valid = sessions.as_ref().is_some_and(|s| {
            s.id == id
                && s.ready
                && s.alive.load(Ordering::Acquire)
                && !s.closing.load(Ordering::Acquire)
                && s.candidate.as_deref() == Some(candidate)
        });
        if !valid || selected.0 != candidate {
            return Err(super::error("stale_candidate"));
        }
        Ok(selected.1)
    }
    pub fn reserve_confirmation(
        &self,
        id: &str,
        candidate: &str,
    ) -> Result<Confirmation, super::Error> {
        let _delivery = self.delivery.lock();
        let sessions = self.session.lock();
        let s = sessions
            .as_ref()
            .filter(|s| {
                s.id == id
                    && s.ready
                    && s.candidate.as_deref() == Some(candidate)
                    && s.alive.load(Ordering::Acquire)
                    && !s.closing.load(Ordering::Acquire)
            })
            .ok_or_else(|| super::error("stale_candidate"))?;
        if self.stopped.load(Ordering::Acquire) || s.confirming.swap(true, Ordering::AcqRel) {
            return Err(super::error("busy"));
        }
        Ok(Confirmation(s.confirming.clone()))
    }
    pub fn reserve_close_task(&self, id: &str) -> Result<(Session, Confirmation), super::Error> {
        let _delivery = self.delivery.lock();
        let sessions = self.session.lock();
        let s = sessions
            .as_ref()
            .filter(|s| {
                s.id == id
                    && !s.destroyed.load(Ordering::Acquire)
                    && (s.alive.load(Ordering::Acquire) || s.closing.load(Ordering::Acquire))
            })
            .ok_or_else(|| super::error("forbidden_window"))?;
        if s.confirming.load(Ordering::Acquire) || s.close_running.swap(true, Ordering::AcqRel) {
            return Err(super::error("busy"));
        }
        s.closing.store(true, Ordering::Release);
        s.alive.store(false, Ordering::Release);
        Ok((s.clone(), Confirmation(s.close_running.clone())))
    }
    // Only actual Destroyed (or build failure before a native window existed) frees the slot.
    pub fn destroyed(&self, id: &str) {
        let _delivery = self.delivery.lock();
        let mut sessions = self.session.lock();
        if let Some(old) = sessions.as_ref().filter(|s| s.id == id) {
            if let Some(pin) = &old.presentation {
                pin.release();
            }
            old.alive.store(false, Ordering::Release);
            // Flag publication precedes broadcast; wait_closed also covers a pre-poll broadcast.
            old.destroyed.store(true, Ordering::Release);
            old.closed.notify_waiters();
            sessions.take();
        }
    }
    pub fn invalidate(&self, id: &str) {
        let _delivery = self.revoke_delivery();
        if let Some(s) = self.session.lock().as_ref().filter(|s| s.id == id) {
            s.alive.store(false, Ordering::Release);
            s.closing.store(true, Ordering::Release);
        }
    }
    fn revoke_delivery(&self) -> parking_lot::MutexGuard<'_, ()> {
        #[cfg(test)]
        if let Some(observer) = self.revoke_attempt.lock().clone() {
            if let Some(guard) = self.delivery.try_lock() {
                let _ = observer.send(false);
                return guard;
            }
            let _ = observer.send(true);
        }
        self.delivery.lock()
    }
    pub fn navigation(&self, id: &str, url: &tauri::Url) -> bool {
        let _delivery = self.delivery.lock();
        let mut sessions = self.session.lock();
        let Some(s) = sessions
            .as_mut()
            .filter(|s| s.id == id && s.alive.load(Ordering::Acquire))
        else {
            return false;
        };
        if !s.navigation_seen && super::identity::trusted(url, id) {
            s.navigation_seen = true;
            true
        } else {
            s.alive.store(false, Ordering::Release);
            s.closing.store(true, Ordering::Release);
            false
        }
    }
    pub fn begin_close(&self, id: &str, busy: bool) -> Result<Session, super::Error> {
        let _delivery = self.delivery.lock();
        let sessions = self.session.lock();
        let s = sessions
            .as_ref()
            .filter(|s| s.id == id && s.alive.load(Ordering::Acquire))
            .ok_or_else(|| super::error("forbidden_window"))?;
        if busy || s.confirming.load(Ordering::Acquire) {
            return Err(super::error("busy"));
        }
        s.closing.store(true, Ordering::Release);
        s.alive.store(false, Ordering::Release);
        Ok(s.clone())
    }
}
pub(super) fn local_main(url: &tauri::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}

pub(super) struct Confirmation(Arc<AtomicBool>);
impl Drop for Confirmation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
