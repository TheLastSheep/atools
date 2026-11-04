use atools_core::Database;
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Weak},
};

const MAX_WINDOW_LEASES: usize = 4;
const MAX_ACTIVE_READS: usize = 8;
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_PENDING_PREPARATIONS: usize = 64;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct Owner {
    pub window: String,
    pub plugin: String,
    pub instance: String,
}

impl Owner {
    pub fn new(window: &str, plugin: &str, instance: &str) -> Result<Self, String> {
        if plugin.is_empty()
            || plugin.len() > 256
            || plugin.trim() != plugin
            || plugin.chars().any(char::is_control)
        {
            return Err("Invalid plugin identity".into());
        }
        let instance = uuid::Uuid::parse_str(instance)
            .map_err(|_| "Invalid plugin resource instance")?
            .to_string();
        Ok(Self {
            window: window.into(),
            plugin: plugin.into(),
            instance,
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Authorization {
    pub root: PathBuf,
    pub revision: Option<String>,
}

pub(crate) fn authorization(db: &Database, plugin_id: &str) -> Result<Authorization, String> {
    let plugin = db
        .get_plugin(plugin_id)
        .map_err(|_| "Plugin resource package not found")?;
    if !plugin.enabled {
        return Err("Plugin resource package is disabled".into());
    }
    let revision = crate::plugin_code_revision::current(db, plugin_id)?;
    let root =
        std::fs::canonicalize(&plugin.path).map_err(|_| "Plugin resource root is unavailable")?;
    if !root.is_dir() {
        return Err("Plugin resource root is not a directory".into());
    }
    Ok(Authorization { root, revision })
}

#[derive(Clone)]
pub(crate) struct Lease {
    pub id: String,
    pub owner: Owner,
    pub authorization: Authorization,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedResources {
    pub(super) session_id: String,
    pub(super) plugin_root: String,
}

#[derive(Default)]
struct Store {
    leases: HashMap<String, Lease>,
    preparations: HashMap<String, Owner>,
}

pub(crate) struct Preparation {
    id: String,
    pub owner: Owner,
    resources: Weak<Resources>,
}
impl Drop for Preparation {
    fn drop(&mut self) {
        if let Some(resources) = self.resources.upgrade() {
            resources.store.lock().preparations.remove(&self.id);
        }
    }
}

pub(crate) struct Resources {
    store: Mutex<Store>,
    pub reads: Arc<tokio::sync::Semaphore>,
    pub pending: Arc<tokio::sync::Semaphore>,
}

impl Default for Resources {
    fn default() -> Self {
        Self {
            store: Mutex::new(Store::default()),
            reads: Arc::new(tokio::sync::Semaphore::new(MAX_ACTIVE_READS)),
            pending: Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_REQUESTS)),
        }
    }
}

impl Resources {
    pub fn begin(self: &Arc<Self>, owner: Owner) -> Result<Preparation, String> {
        let mut store = self.store.lock();
        if store.preparations.len() >= MAX_PENDING_PREPARATIONS {
            return Err("Too many pending plugin resource preparations".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        store.preparations.insert(id.clone(), owner.clone());
        Ok(Preparation {
            id,
            owner,
            resources: Arc::downgrade(self),
        })
    }

    #[cfg(test)]
    pub fn commit(
        &self,
        preparation: Preparation,
        authorization: Authorization,
    ) -> Result<PreparedResources, String> {
        self.commit_with_source_revoke(preparation, authorization, |_| Vec::new())
            .map(|(prepared, _)| prepared)
    }

    /// Commit a resource session and invalidate source bindings before releasing the
    /// resource-store lock when the owner's authorization changes. The caller must
    /// finish native-window closure after this method returns so no callback runs
    /// while either store lock is held.
    pub fn commit_with_source_revoke(
        &self,
        preparation: Preparation,
        authorization: Authorization,
        revoke: impl FnOnce(&Owner) -> Vec<String>,
    ) -> Result<(PreparedResources, Vec<String>), String> {
        let mut store = self.store.lock();
        let owner = preparation.owner.clone();
        if store.preparations.remove(&preparation.id).as_ref() != Some(&owner) {
            return Err("Plugin resource preparation was cancelled".into());
        }
        let leases = &mut store.leases;
        if let Some(lease) = leases.values().find(|lease| {
            lease.owner == owner
                && lease.authorization.root == authorization.root
                && lease.authorization.revision == authorization.revision
        }) {
            return Ok((
                PreparedResources {
                    session_id: lease.id.clone(),
                    plugin_root: authorization.root.to_string_lossy().into(),
                },
                Vec::new(),
            ));
        }
        let replaced = leases.values().any(|lease| lease.owner == owner);
        let retired = if replaced { revoke(&owner) } else { Vec::new() };
        leases.retain(|_, lease| lease.owner != owner);
        if leases.len() >= 32
            || leases
                .values()
                .filter(|lease| lease.owner.window == owner.window)
                .count()
                >= MAX_WINDOW_LEASES
        {
            return Err("Too many active plugin resource leases".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        leases.insert(
            id.clone(),
            Lease {
                id: id.clone(),
                owner,
                authorization: authorization.clone(),
            },
        );
        Ok((
            PreparedResources {
                session_id: id,
                plugin_root: authorization.root.to_string_lossy().into(),
            },
            retired,
        ))
    }

    pub fn get(&self, id: &str, window: &str) -> Option<Lease> {
        self.store
            .lock()
            .leases
            .get(id)
            .filter(|lease| lease.owner.window == window)
            .cloned()
    }

    /// Look up a session only when its complete owner identity matches.
    pub fn get_for_owner(&self, id: &str, owner: &Owner) -> Option<Lease> {
        self.store
            .lock()
            .leases
            .get(id)
            .filter(|lease| &lease.owner == owner)
            .cloned()
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub fn sessions_for_package(
        &self,
        window: &str,
        plugin_id: &str,
        authorization: &Authorization,
    ) -> Result<Vec<String>, String> {
        let store = self.store.lock();
        let window_leases = store
            .leases
            .values()
            .filter(|lease| lease.owner.window == window)
            .count();
        if window_leases > MAX_WINDOW_LEASES {
            return Err("Plugin resource window exceeds its active lease limit".into());
        }
        let mut sessions = store
            .leases
            .values()
            .filter(|lease| {
                lease.owner.window == window
                    && lease.owner.plugin == plugin_id
                    && lease.authorization == *authorization
            })
            .map(|lease| lease.id.clone())
            .collect::<Vec<_>>();
        sessions.sort();
        Ok(sessions)
    }

    /// Keep close/reset mutually exclusive with the final check and response handoff.
    pub fn if_current<T>(&self, lease: &Lease, action: impl FnOnce() -> T) -> Option<T> {
        let store = self.store.lock();
        store
            .leases
            .get(&lease.id)
            .filter(|current| {
                current.owner == lease.owner
                    && current.authorization.root == lease.authorization.root
                    && current.authorization.revision == lease.authorization.revision
            })
            .map(|_| action())
    }

    #[cfg(test)]
    pub fn close(&self, owner: &Owner) {
        let mut store = self.store.lock();
        store.leases.retain(|_, lease| &lease.owner != owner);
        store.preparations.retain(|_, pending| pending != owner);
    }
    pub fn close_with_source_revoke(
        &self,
        owner: &Owner,
        revoke: impl FnOnce(&Owner) -> Vec<String>,
    ) -> Vec<String> {
        let mut store = self.store.lock();
        store.leases.retain(|_, lease| &lease.owner != owner);
        store.preparations.retain(|_, pending| pending != owner);
        revoke(owner)
    }
    #[cfg(test)]
    pub fn invalidate_plugin(&self, plugin: &str) {
        let mut store = self.store.lock();
        store.leases.retain(|_, lease| lease.owner.plugin != plugin);
        store
            .preparations
            .retain(|_, pending| pending.plugin != plugin);
    }
    pub fn invalidate_plugin_with_source_revoke(
        &self,
        plugin: &str,
        revoke: impl FnOnce(&str) -> Vec<String>,
    ) -> Vec<String> {
        let mut store = self.store.lock();
        store.leases.retain(|_, lease| lease.owner.plugin != plugin);
        store
            .preparations
            .retain(|_, pending| pending.plugin != plugin);
        revoke(plugin)
    }
    #[cfg(test)]
    pub fn close_window(&self, window: &str) {
        let mut store = self.store.lock();
        store.leases.retain(|_, lease| lease.owner.window != window);
        store
            .preparations
            .retain(|_, pending| pending.window != window);
    }
    pub fn close_window_with_source_revoke(
        &self,
        window: &str,
        revoke: impl FnOnce(&str) -> Vec<String>,
    ) -> Vec<String> {
        let mut store = self.store.lock();
        store.leases.retain(|_, lease| lease.owner.window != window);
        store
            .preparations
            .retain(|_, pending| pending.window != window);
        revoke(window)
    }

    #[cfg(test)]
    pub fn prepare(
        self: &Arc<Self>,
        owner: Owner,
        authorization: Authorization,
    ) -> Result<PreparedResources, String> {
        self.commit(self.begin(owner)?, authorization)
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub fn count(&self) -> usize {
        self.store.lock().leases.len()
    }

    /// Include queued responses whose owner lease may already have been closed.
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub fn runtime_state(&self) -> serde_json::Value {
        let store = self.store.lock();
        serde_json::json!({"available":true,"leases":store.leases.len(),
            "preparations":store.preparations.len(),
            "activeReads":MAX_ACTIVE_READS.saturating_sub(self.reads.available_permits()),
            "pendingRequests":MAX_PENDING_REQUESTS.saturating_sub(self.pending.available_permits())})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_code_revision::CodeRevision;
    use atools_core::Plugin;

    fn fixture() -> (tempfile::TempDir, Database, Arc<Resources>, Authorization) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("index.html"), "<p>fixture</p>").unwrap();
        let database = Database::in_memory().unwrap();
        let plugin: Plugin = serde_json::from_value(serde_json::json!({
            "id":"lease-query-fixture", "name":"lease-query-fixture", "version":"1.0.0",
            "path":directory.path(), "enabled":true,
            "manifest":{"name":"lease-query-fixture","version":"1.0.0","main":"index.html"},
            "created_at":"now", "updated_at":"now"
        }))
        .unwrap();
        database.save_plugin(&plugin).unwrap();
        let authorization = authorization(&database, &plugin.id).unwrap();
        (
            directory,
            database,
            Arc::new(Resources::default()),
            authorization,
        )
    }

    fn owner(window: &str, instance: &str) -> Owner {
        Owner::new(window, "lease-query-fixture", instance).unwrap()
    }

    #[test]
    fn fixture_session_query_filters_window_plugin_and_current_authorization() {
        let (_directory, database, resources, auth) = fixture();
        let first = resources
            .prepare(
                owner("fixture-window", &uuid::Uuid::new_v4().to_string()),
                auth.clone(),
            )
            .unwrap();
        let second = resources
            .prepare(
                owner("fixture-window", &uuid::Uuid::new_v4().to_string()),
                auth.clone(),
            )
            .unwrap();
        resources
            .prepare(
                owner("other-window", &uuid::Uuid::new_v4().to_string()),
                auth.clone(),
            )
            .unwrap();

        let sessions = resources
            .sessions_for_package("fixture-window", "lease-query-fixture", &auth)
            .unwrap();
        let mut expected = vec![first.session_id, second.session_id];
        expected.sort();
        assert_eq!(sessions, expected);
        assert!(resources
            .sessions_for_package("fixture-window", "different-plugin", &auth)
            .unwrap()
            .is_empty());
        assert!(resources
            .sessions_for_package("missing-window", "lease-query-fixture", &auth)
            .unwrap()
            .is_empty());

        CodeRevision::begin(&database, "lease-query-fixture")
            .unwrap()
            .finish(&database)
            .unwrap();
        let current = authorization(&database, "lease-query-fixture").unwrap();
        assert!(resources
            .sessions_for_package("fixture-window", "lease-query-fixture", &current)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn fixture_session_query_respects_the_existing_per_window_limit() {
        let (_directory, _database, resources, auth) = fixture();
        for _ in 0..MAX_WINDOW_LEASES {
            resources
                .prepare(
                    owner("fixture-window", &uuid::Uuid::new_v4().to_string()),
                    auth.clone(),
                )
                .unwrap();
        }
        let sessions = resources
            .sessions_for_package("fixture-window", "lease-query-fixture", &auth)
            .unwrap();
        assert_eq!(sessions.len(), MAX_WINDOW_LEASES);
        assert!(resources
            .prepare(
                owner("fixture-window", &uuid::Uuid::new_v4().to_string()),
                auth.clone()
            )
            .is_err());
    }
}
