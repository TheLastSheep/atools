use super::{binding::DocumentBinding, PreparedPage, PARENT_ORIGIN};
use crate::plugin_asset_protocol::{Authorization, Owner};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};

#[derive(Clone)]
pub(super) struct Document {
    pub binding: DocumentBinding,
    pub owner: Owner,
    pub authorization: Authorization,
    pub prepared: PreparedPage,
    pub ticket_path: String,
    consumed: bool,
    claimed: bool,
}

#[derive(Default)]
struct Store {
    documents: HashMap<String, Document>,
    pending: HashMap<String, Owner>,
}

#[derive(Default)]
pub(super) struct Registry {
    store: Mutex<Store>,
}

pub(super) struct Preparation {
    id: String,
    pub owner: Owner,
    registry: Weak<Registry>,
}
impl Drop for Preparation {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            registry.store.lock().pending.remove(&self.id);
        }
    }
}

impl Registry {
    pub fn begin(self: &Arc<Self>, owner: Owner) -> Result<Preparation, String> {
        let mut store = self.store.lock();
        if store.pending.len() >= 64 {
            return Err("Too many pending plugin pages".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        store.pending.insert(id.clone(), owner.clone());
        Ok(Preparation {
            id,
            owner,
            registry: Arc::downgrade(self),
        })
    }

    pub fn commit(
        &self,
        pending: Preparation,
        authorization: Authorization,
    ) -> Result<(PreparedPage, Vec<String>), String> {
        let mut store = self.store.lock();
        if store.pending.remove(&pending.id).as_ref() != Some(&pending.owner) {
            return Err("Plugin page preparation was cancelled".into());
        }
        let owner = pending.owner.clone();
        // Retain the existing resource lease's stricter per-window budget.
        let remaining: Vec<_> = store
            .documents
            .values()
            .filter(|document| document.binding.is_active() && document.owner != owner)
            .collect();
        if remaining.len() >= 32
            || remaining
                .iter()
                .filter(|document| document.owner.window == owner.window)
                .count()
                >= 4
        {
            return Err("Too many active plugin pages".into());
        }
        let retired = Self::remove(&mut store, |document| {
            !document.binding.is_active() || document.owner == owner
        });
        let id = uuid::Uuid::new_v4();
        let page_document_id = id.to_string();
        let expected_origin = format!("atools-page://{}.localhost", id.simple());
        let ticket_path = format!("/{}/bootstrap.html", uuid::Uuid::new_v4().simple());
        let prepared = PreparedPage {
            page_document_id: page_document_id.clone(),
            bootstrap_url: format!("{expected_origin}{ticket_path}"),
            resource_base_url: format!("{expected_origin}/assets/"),
            expected_origin: expected_origin.clone(),
            parent_origin: PARENT_ORIGIN.into(),
        };
        let binding = DocumentBinding::new(&page_document_id, &expected_origin)?;
        store.documents.insert(
            page_document_id,
            Document {
                binding,
                owner,
                authorization,
                prepared: prepared.clone(),
                ticket_path,
                consumed: false,
                claimed: false,
            },
        );
        Ok((prepared, retired))
    }

    pub fn get(&self, id: &str, window: &str, plugin: &str) -> Option<Document> {
        self.store
            .lock()
            .documents
            .get(id)
            .filter(|document| {
                document.owner.window == window
                    && document.owner.plugin == plugin
                    && document.binding.is_active()
            })
            .cloned()
    }

    pub fn for_origin(&self, origin: &str, window: &str) -> Option<Document> {
        self.store
            .lock()
            .documents
            .values()
            .find(|document| {
                document.prepared.expected_origin == origin
                    && document.owner.window == window
                    && document.binding.is_active()
            })
            .cloned()
    }

    /// Atomic ticket consumption; request headers never take part in the lookup.
    pub fn consume(&self, binding: &DocumentBinding, path: &str) -> bool {
        let mut store = self.store.lock();
        let Some(document) = store.documents.get_mut(binding.id()) else {
            return false;
        };
        if !document.binding.same(binding)
            || !document.binding.is_active()
            || document.ticket_path != path
            || document.consumed
        {
            return false;
        }
        document.consumed = true;
        document.binding.begin_handoff();
        true
    }

    pub fn claim(
        &self,
        owner: &Owner,
        id: &str,
        authorization: &Authorization,
    ) -> Result<(), String> {
        let mut store = self.store.lock();
        let document = store
            .documents
            .get_mut(id)
            .ok_or("Plugin page is unavailable")?;
        if &document.owner != owner {
            return Err("Plugin page owner mismatch".into());
        }
        if &document.authorization != authorization {
            document.binding.revoke();
            return Err("Plugin page code changed".into());
        }
        if !document.binding.is_active() || !document.consumed || document.claimed {
            return Err("Plugin page cannot be claimed".into());
        }
        document.claimed = true;
        document.binding.finish_handoff();
        Ok(())
    }

    /// Close and response handoff share one lock. No byte handoff can occur after
    /// close returns, even when its blocking filesystem read completed earlier.
    pub fn if_current<T>(
        &self,
        binding: &DocumentBinding,
        action: impl FnOnce() -> T,
    ) -> Option<T> {
        let store = self.store.lock();
        store
            .documents
            .get(binding.id())
            .filter(|document| document.binding.same(binding) && document.binding.is_active())
            .map(|_| action())
    }

    pub fn close_owner(&self, owner: &Owner, id: Option<&str>) -> Vec<String> {
        let mut store = self.store.lock();
        if id.is_none() {
            store.pending.retain(|_, pending| pending != owner);
        }
        Self::remove(&mut store, |document| {
            &document.owner == owner && id.is_none_or(|id| document.binding.id() == id)
        })
    }
    #[cfg(feature = "legacy-node-smoke")]
    pub(super) fn close_native_frame(&self, window: &str, origin: &str) -> Vec<String> {
        Self::remove(&mut self.store.lock(), |document| {
            document.owner.window == window && document.prepared.expected_origin == origin
        })
    }
    pub fn invalidate_plugin(&self, plugin: &str) {
        let mut store = self.store.lock();
        store.pending.retain(|_, owner| owner.plugin != plugin);
        Self::remove(&mut store, |document| document.owner.plugin == plugin);
    }
    pub fn close_window(&self, window: &str) {
        let mut store = self.store.lock();
        store.pending.retain(|_, owner| owner.window != window);
        Self::remove(&mut store, |document| document.owner.window == window);
    }
    fn remove(store: &mut Store, matches: impl Fn(&Document) -> bool) -> Vec<String> {
        let mut removed = Vec::new();
        store.documents.retain(|id, document| {
            if matches(document) {
                document.binding.revoke();
                removed.push(id.clone());
                false
            } else {
                true
            }
        });
        removed
    }
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub fn count(&self) -> usize {
        self.store
            .lock()
            .documents
            .values()
            .filter(|document| document.binding.is_active())
            .count()
    }
}
