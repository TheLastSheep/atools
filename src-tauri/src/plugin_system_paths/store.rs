//! Private, bounded generation records. Paths deliberately do not implement Serialize.
use super::{registry::Access, resolver::Paths};
use atools_core::{Database, Plugin};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::Instant,
};

pub(super) const CAPACITY: usize = 64;
pub(super) const TTL_SECS: u64 = 60;
pub(super) fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Owner {
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
            return Err("Invalid path plugin identity".into());
        }
        Ok(Self {
            window: window.into(),
            plugin: plugin.into(),
            instance: uuid::Uuid::parse_str(instance)
                .map_err(|_| "Invalid path instance")?
                .to_string(),
        })
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Binding {
    path: String,
    version: String,
    revision: Option<String>,
}
impl Binding {
    pub fn current(db: &Database, plugin: &Plugin) -> Result<Self, String> {
        if !plugin.enabled {
            return Err("Plugin is disabled".into());
        }
        Ok(Self {
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            revision: crate::plugin_code_revision::current(db, &plugin.id)?,
        })
    }
    pub fn validate(&self, db: &Database, plugin: &str) -> Result<(), String> {
        let plugin = db.get_plugin(plugin).map_err(|_| "Plugin unavailable")?;
        if *self != Self::current(db, &plugin)? {
            return Err("Plugin changed; reopen it before reading paths".into());
        }
        Ok(())
    }
}
#[derive(Clone)]
pub(super) struct Intent {
    pub owner: Owner,
    pub binding: Binding,
    pub access: Access,
    pub created: Instant,
    pub run: Arc<Mutex<Option<String>>>,
}
pub(super) struct Snapshot {
    pub owner: Owner,
    pub binding: Binding,
    pub access: Access,
    pub paths: Paths,
    pub run: Arc<Mutex<Option<String>>>,
}
#[derive(Default)]
pub(super) struct Store {
    pub intents: HashMap<String, Intent>,
    pub snapshots: HashMap<String, Snapshot>,
    preparations: HashMap<String, Owner>,
    successors: Vec<(Owner, Owner)>,
    stopped: bool,
}
#[derive(Default)]
pub(crate) struct Runtime(pub(super) Mutex<Store>);
pub(super) struct Preparation {
    id: String,
    owner: Owner,
    runtime: Weak<Runtime>,
}
impl Drop for Preparation {
    fn drop(&mut self) {
        if let Some(r) = self.runtime.upgrade() {
            r.0.lock().preparations.remove(&self.id);
        }
    }
}
impl Runtime {
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub fn preparation_count(&self, store: &Store) -> usize {
        store.preparations.len()
    }
    pub fn begin(self: &Arc<Self>, owner: Owner) -> Result<Preparation, String> {
        let mut store = self.0.lock();
        if store.stopped
            || store.preparations.len() >= CAPACITY
            || store.successors.iter().any(|(old, _)| old == &owner)
        {
            return Err("Path preparation unavailable".into());
        }
        let id = id();
        store.preparations.insert(id.clone(), owner.clone());
        Ok(Preparation {
            id,
            owner,
            runtime: Arc::downgrade(self),
        })
    }
    pub fn intent(
        &self,
        preparation: Preparation,
        binding: Binding,
        access: Access,
    ) -> Result<String, String> {
        let mut store = self.0.lock();
        if store.stopped
            || store.preparations.remove(&preparation.id).as_ref() != Some(&preparation.owner)
        {
            return Err("Path preparation cancelled".into());
        }
        if store.intents.len() + store.snapshots.len() >= CAPACITY {
            return Err("Path snapshot capacity exceeded".into());
        }
        let id = id();
        store.intents.insert(
            id.clone(),
            Intent {
                owner: preparation.owner.clone(),
                binding,
                access,
                created: Instant::now(),
                run: Arc::new(Mutex::new(None)),
            },
        );
        Ok(id)
    }
    pub fn expire(&self) -> Vec<String> {
        let mut runs = Vec::new();
        self.0.lock().intents.retain(|_, i| {
            if i.created.elapsed().as_secs() < TTL_SECS {
                true
            } else {
                if let Some(run) = i.run.lock().clone() {
                    runs.push(run);
                }
                false
            }
        });
        runs
    }
    pub fn publish(
        &self,
        intent_id: &str,
        binding: &Binding,
        paths: Paths,
    ) -> Result<String, String> {
        let mut store = self.0.lock();
        let intent = store
            .intents
            .remove(intent_id)
            .ok_or("Path authorization closed")?;
        if store.stopped
            || &intent.binding != binding
            || intent.created.elapsed().as_secs() >= TTL_SECS
        {
            return Err("Path authorization expired or changed".into());
        }
        let id = id();
        store.snapshots.insert(
            id.clone(),
            Snapshot {
                owner: intent.owner,
                binding: binding.clone(),
                access: intent.access,
                paths,
                run: intent.run,
            },
        );
        Ok(id)
    }
    pub fn existing(&self, owner: &Owner, access: Access) -> Option<String> {
        self.0
            .lock()
            .snapshots
            .iter()
            .find(|(_, s)| &s.owner == owner && s.access == access)
            .map(|(id, _)| id.clone())
    }
    pub fn close(
        &self,
        owner: Option<&Owner>,
        plugin: Option<&str>,
        window: Option<&str>,
        stop: bool,
    ) -> Vec<String> {
        let mut store = self.0.lock();
        store.stopped |= stop;
        let mut owners = owner.cloned().into_iter().collect::<Vec<_>>();
        for _ in 0..=CAPACITY {
            let before = owners.len();
            for (old, next) in &store.successors {
                if owners.contains(old) || owners.contains(next) {
                    if !owners.contains(old) {
                        owners.push(old.clone());
                    }
                    if !owners.contains(next) {
                        owners.push(next.clone());
                    }
                }
            }
            if owners.len() == before {
                break;
            }
        }
        let matches = |o: &Owner| {
            (owner.is_none() || owners.contains(o))
                && plugin.is_none_or(|id| id == o.plugin)
                && window.is_none_or(|id| id == o.window)
        };
        let mut runs = Vec::new();
        store.preparations.retain(|_, o| !matches(o));
        store.intents.retain(|_, i| {
            if !matches(&i.owner) {
                return true;
            }
            if let Some(run) = i.run.lock().clone() {
                runs.push(run);
            }
            false
        });
        store.snapshots.retain(|_, s| {
            if !matches(&s.owner) {
                return true;
            }
            if let Some(run) = s.run.lock().clone() {
                runs.push(run);
            }
            false
        });
        store.successors.retain(|(a, b)| !matches(a) && !matches(b));
        runs
    }
    pub fn rotate(&self, old: &Owner, next: Owner) -> Result<(), String> {
        let mut store = self.0.lock();
        if store.stopped
            || old == &next
            || store.successors.len() >= CAPACITY
            || store.snapshots.values().any(|s| s.owner == next)
        {
            return Err("Path generation changed before reopen".into());
        }
        if store.intents.values().any(|i| &i.owner == old)
            || store.preparations.values().any(|o| o == old)
        {
            return Err("Path authorization is still pending".into());
        }
        for s in store.snapshots.values_mut().filter(|s| &s.owner == old) {
            s.owner = next.clone();
        }
        store.successors.push((old.clone(), next));
        Ok(())
    }
}
