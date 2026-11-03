//! Per-plugin async read/write gates for coordinating execution with lifecycle
//! mutations. This module is independent of Tauri so callers can share one
//! registry without holding application-state locks across an await.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

const WEAK_REGISTRY_CLEANUP_THRESHOLD: usize = 256;

/// Coordinates concurrent executions and mutations for each plugin identity.
///
/// Read guards represent executions. Write guards represent operations such as
/// update, disable, uninstall, or replacement. Different plugin IDs have
/// independent locks. The registry keeps only weak references; any active
/// operation owns the lock strongly through its returned guard.
#[derive(Default)]
pub(crate) struct PluginExecutionGates {
    locks: Mutex<HashMap<String, Weak<RwLock<()>>>>,
}

impl PluginExecutionGates {
    /// Acquires a shared execution gate for `plugin_id`.
    pub(crate) async fn read(&self, plugin_id: &str) -> OwnedRwLockReadGuard<()> {
        self.lock_for(plugin_id).read_owned().await
    }

    /// Acquires an exclusive lifecycle gate for `plugin_id`.
    pub(crate) async fn write(&self, plugin_id: &str) -> OwnedRwLockWriteGuard<()> {
        self.lock_for(plugin_id).write_owned().await
    }

    fn lock_for(&self, plugin_id: &str) -> Arc<RwLock<()>> {
        let mut locks = self.locks.lock();

        if locks.len() > WEAK_REGISTRY_CLEANUP_THRESHOLD {
            locks.retain(|_, weak| weak.strong_count() > 0);
        }

        if let Some(lock) = locks.get(plugin_id).and_then(Weak::upgrade) {
            return lock;
        }

        let lock = Arc::new(RwLock::new(()));
        locks.insert(plugin_id.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

#[cfg(test)]
#[path = "plugin_execution_gates_tests.rs"]
mod tests;
