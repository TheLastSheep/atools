use super::{NodeRuntimeSelector, SidecarError, SidecarLaunchSpec, SidecarProcess, SidecarStatus};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Weak};
use tokio::sync::{oneshot, Mutex, RwLock};

#[derive(Default)]
pub struct SidecarSupervisor {
    processes: RwLock<HashMap<String, Arc<SidecarProcess>>>,
    operation_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    lifecycle_gate: RwLock<()>,
    node_runtime_selector: NodeRuntimeSelector,
}

impl SidecarSupervisor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a supervisor that uses a host-provided Node runtime selector.
    pub fn new_with_node_runtime_selector(node_runtime_selector: NodeRuntimeSelector) -> Self {
        Self {
            processes: RwLock::new(HashMap::new()),
            operation_locks: Mutex::new(HashMap::new()),
            lifecycle_gate: RwLock::new(()),
            node_runtime_selector,
        }
    }

    pub async fn start(
        &self,
        spec: SidecarLaunchSpec,
    ) -> Result<Arc<SidecarProcess>, SidecarError> {
        self.start_with_cancellation(spec, Arc::new(AtomicBool::new(false)))
            .await
    }

    /// Start with an operation-owned cancellation flag for blocking Node preparation.
    pub async fn start_with_cancellation(
        &self,
        spec: SidecarLaunchSpec,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Arc<SidecarProcess>, SidecarError> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let operation_lock = self.operation_lock(&spec.plugin_id).await;
        let _operation = operation_lock.lock().await;

        let plugin_id = spec.plugin_id.clone();
        let existing = { self.processes.read().await.get(&plugin_id).cloned() };
        if let Some(existing) = existing {
            match existing.status() {
                SidecarStatus::Starting | SidecarStatus::Running => return Ok(existing),
                SidecarStatus::Stopped | SidecarStatus::Crashed => {
                    // A terminal status alone is not proof that all owned resources
                    // were cleaned. SidecarProcess returns its sticky cleanup error;
                    // preserve that record and refuse to spawn over it.
                    existing.shutdown().await?;
                    self.remove_if_same(&plugin_id, &existing).await;
                }
            }
        }
        let process = SidecarProcess::spawn_with_node_runtime_selector(
            spec,
            self.node_runtime_selector.clone(),
            cancelled,
        )
        .await?;
        self.processes
            .write()
            .await
            .insert(plugin_id, process.clone());
        Ok(process)
    }

    pub async fn get(&self, plugin_id: &str) -> Option<Arc<SidecarProcess>> {
        self.processes.read().await.get(plugin_id).cloned()
    }

    pub async fn stop(&self, plugin_id: &str) -> Result<(), SidecarError> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let operation_lock = self.operation_lock(plugin_id).await;
        let _operation = operation_lock.lock().await;
        let process = self.processes.read().await.get(plugin_id).cloned();
        if let Some(process) = process {
            process.shutdown().await?;
            self.remove_if_same(plugin_id, &process).await;
        }
        Ok(())
    }

    /// Stop every owner present at the beginning of this operation.
    ///
    /// This is a lifecycle barrier: it waits for in-flight starts/stops, prevents
    /// new starts/stops until every captured owner has been attempted, and does
    /// not hold the process-map lock while awaiting shutdown. Failed owners stay
    /// registered and are returned with their plugin IDs. SidecarProcess cleanup
    /// errors are sticky, so retaining a failed owner makes it observable and
    /// prevents an unsafe replacement; this API does not claim that retrying its
    /// shutdown can recover a terminal cleanup failure.
    pub async fn stop_all_strict(&self) -> Result<(), Vec<(String, SidecarError)>> {
        let _lifecycle = self.lifecycle_gate.write().await;
        let processes: Vec<_> = self
            .processes
            .read()
            .await
            .iter()
            .map(|(plugin_id, process)| (plugin_id.clone(), process.clone()))
            .collect();
        let mut failures = Vec::new();

        for (plugin_id, process) in processes {
            match process.shutdown().await {
                Ok(()) => self.remove_if_same(&plugin_id, &process).await,
                Err(error) => failures.push((plugin_id, error)),
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures)
        }
    }

    /// Compatibility wrapper for existing fire-and-forget shutdown paths.
    /// Callers that need to act on cleanup results should use `stop_all_strict`.
    pub async fn stop_all(&self) {
        if let Err(failures) = self.stop_all_strict().await {
            tracing::error!(?failures, "one or more plugin sidecars failed to stop");
        }
    }

    async fn operation_lock(&self, plugin_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.operation_locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(plugin_id).and_then(Weak::upgrade) {
            return lock;
        }

        let lock = Arc::new(Mutex::new(()));
        locks.insert(plugin_id.to_string(), Arc::downgrade(&lock));
        lock
    }

    async fn remove_if_same(&self, plugin_id: &str, process: &Arc<SidecarProcess>) {
        let mut processes = self.processes.write().await;
        if processes
            .get(plugin_id)
            .is_some_and(|current| Arc::ptr_eq(current, process))
        {
            processes.remove(plugin_id);
        }
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        if let Ok(mut processes) = self.processes.try_write() {
            for process in processes.values() {
                let (response, _) = oneshot::channel();
                let _ = process
                    .command_tx
                    .try_send(super::supervisor::ProcessCommand::Shutdown { response });
            }
            processes.clear();
        }
    }
}

#[cfg(all(test, unix))]
#[path = "registry_tests.rs"]
mod tests;
