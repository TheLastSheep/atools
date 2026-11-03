//! Native-only final-effect gate for bound application launches.
use crate::launcher_app_catalog_source::LauncherAppCatalogSource;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Default, Clone)]
pub(crate) struct AppLaunchFence(Arc<Mutex<FenceState>>);
#[derive(Default)]
struct FenceState {
    stopping: bool,
    bindings: HashMap<String, (u64, String)>,
}

/// Deliberately neither serializable nor cloneable. The lease travels with the
/// actual blocking operation, and the owned launch task holds it to terminal.
pub(crate) struct AppLaunchGrant {
    fence: AppLaunchFence,
    id: String,
    generation: u64,
    path: String,
    catalog: Arc<LauncherAppCatalogSource>,
    _lease: Arc<dyn Send + Sync>,
    effect_started: Arc<AtomicBool>,
    consumed: AtomicBool,
}

impl AppLaunchFence {
    pub(crate) fn publish(&self, id: String, generation: u64, path: String) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "App launch fence poisoned")?;
        if state.stopping {
            return Err("App launch is stopping".into());
        }
        state.bindings.insert(id, (generation, path));
        Ok(())
    }
    pub(crate) fn revoke(&self, id: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "App launch fence poisoned")?
            .bindings
            .remove(id);
        Ok(())
    }
    pub(crate) fn stop(&self) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "App launch fence poisoned")?;
        state.stopping = true;
        state.bindings.clear();
        Ok(())
    }
    pub(crate) fn grant(
        &self,
        id: String,
        generation: u64,
        path: String,
        catalog: Arc<LauncherAppCatalogSource>,
        lease: Box<dyn Send + Sync>,
    ) -> AppLaunchGrant {
        AppLaunchGrant {
            fence: self.clone(),
            id,
            generation,
            path,
            catalog,
            _lease: Arc::from(lease),
            effect_started: Arc::new(AtomicBool::new(false)),
            consumed: AtomicBool::new(false),
        }
    }
}
impl AppLaunchGrant {
    pub(crate) fn effect_started(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.effect_started)
    }
    pub(crate) fn lease(&self) -> Arc<dyn Send + Sync> {
        Arc::clone(&self._lease)
    }
    pub(crate) fn path(&self) -> &str {
        &self.path
    }
    pub(crate) fn check_catalog(&self) -> Result<(), String> {
        if self
            .catalog
            .snapshot()?
            .iter()
            .any(|app| app.path() == self.path)
        {
            Ok(())
        } else {
            Err("Application is no longer in the native launcher catalog".into())
        }
    }
    pub(crate) fn spawn<T>(&self, spawn: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        if self.consumed.swap(true, Ordering::AcqRel) {
            return Err("Application launch grant already consumed".into());
        }
        let state = self
            .fence
            .0
            .lock()
            .map_err(|_| "App launch fence poisoned")?;
        if state.stopping
            || state.bindings.get(&self.id) != Some(&(self.generation, self.path.clone()))
        {
            return Err("Application launch binding is no longer current".into());
        }
        let result = spawn();
        if result.is_ok() {
            self.effect_started.store(true, Ordering::Release);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn grant(fence: &AppLaunchFence, generation: u64) -> AppLaunchGrant {
        fence.grant(
            "row".into(),
            generation,
            "/A.app".into(),
            Arc::new(LauncherAppCatalogSource::default()),
            Box::new(()),
        )
    }
    #[test]
    fn stale_reused_and_stopped_grants_cannot_spawn() {
        let fence = AppLaunchFence::default();
        fence.publish("row".into(), 2, "/A.app".into()).unwrap();
        assert!(grant(&fence, 1).spawn(|| Ok(())).is_err());
        let current = grant(&fence, 2);
        assert!(current.spawn(|| Ok(())).is_ok());
        assert!(current.spawn::<()>(|| panic!("grant reused")).is_err());
        fence.stop().unwrap();
        assert!(grant(&fence, 2)
            .spawn::<()>(|| panic!("spawn after stop"))
            .is_err());
    }
    #[test]
    fn spawn_and_stop_are_linearized() {
        let fence = AppLaunchFence::default();
        fence.publish("row".into(), 1, "/A.app".into()).unwrap();
        let current = grant(&fence, 1);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            current.spawn(|| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv().unwrap();
        let other = fence.clone();
        let stopper = std::thread::spawn(move || other.stop());
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_ok());
        stopper.join().unwrap().unwrap();
        assert!(grant(&fence, 1).spawn::<()>(|| panic!("stop won")).is_err());
    }
    #[tokio::test]
    async fn dropped_awaiter_does_not_release_blocking_owner() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Lease(Arc<AtomicBool>);
        impl Drop for Lease {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let released = Arc::new(AtomicBool::new(false));
        let fence = AppLaunchFence::default();
        fence.publish("row".into(), 1, "/A.app".into()).unwrap();
        let grant = fence.grant(
            "row".into(),
            1,
            "/A.app".into(),
            Arc::new(LauncherAppCatalogSource::default()),
            Box::new(Lease(Arc::clone(&released))),
        );
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let waiter = tokio::task::spawn_blocking(move || {
            let result = grant.spawn(|| {
                entered_tx.send(()).unwrap();
                Ok(())
            });
            release_rx.recv().unwrap();
            drop(grant);
            done_tx.send(()).unwrap();
            result
        });
        entered_rx.recv().unwrap();
        drop(waiter);
        assert!(!released.load(Ordering::SeqCst));
        release_tx.send(()).unwrap();
        done_rx.recv().unwrap();
        assert!(released.load(Ordering::SeqCst));
    }
}
