use super::documents::WindowDocument;
use super::{renderer::RendererGrant, SourceBinding};
use crate::plugin_asset_protocol::Owner;
use std::collections::HashMap;
use std::sync::Weak;

#[cfg_attr(not(test), allow(dead_code))]
const MAX_SOURCE_KEYS: usize = 256;

#[derive(Clone, Hash, PartialEq, Eq)]
struct Key {
    owner: Owner,
    frame_id: String,
}

impl Key {
    fn of(binding: &SourceBinding) -> Self {
        Self {
            owner: binding.owner().clone(),
            frame_id: binding.frame_id().to_owned(),
        }
    }
    fn new(owner: &Owner, frame_id: &str) -> Self {
        Self {
            owner: owner.clone(),
            frame_id: frame_id.to_owned(),
        }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
struct Watermark {
    generation: u64,
    document_nonce: String,
}

#[derive(Default)]
pub(super) struct Registry {
    current: HashMap<Key, String>,
    watermarks: HashMap<Key, Watermark>,
    by_id: HashMap<String, SourceBinding>,
    pub(super) renderers: HashMap<String, RendererGrant>,
    pub(super) document_refs: Vec<Weak<WindowDocument>>,
}

impl Registry {
    pub(super) fn by_id(&self, id: &str) -> Option<SourceBinding> {
        self.by_id.get(id).cloned()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn bind(
        &mut self,
        binding: SourceBinding,
    ) -> Result<(SourceBinding, Vec<String>), String> {
        let key = Key::of(&binding);
        if let Some(watermark) = self.watermarks.get(&key) {
            if binding.generation() < watermark.generation {
                return Err("Plugin frame generation is stale".into());
            }
            if binding.generation() == watermark.generation {
                if binding.document_nonce() != watermark.document_nonce {
                    return Err("Plugin document nonce changed without a new generation".into());
                }
                let Some(id) = self.current.get(&key) else {
                    return Err("Plugin source for this document has already been closed".into());
                };
                let Some(current) = self.by_id.get(id) else {
                    return Err("Plugin source for this document is unavailable".into());
                };
                if current.is_active()
                    && current.resource_session_id() == binding.resource_session_id()
                    && current.authorization() == binding.authorization()
                {
                    return Ok((current.clone(), Vec::new()));
                }
                return Err("Plugin source for this document is no longer active".into());
            }
        } else if self.watermarks.len() >= MAX_SOURCE_KEYS {
            return Err("Plugin source identity limit reached".into());
        }
        if self.by_id.contains_key(binding.id()) {
            return Err("Plugin source id collision".into());
        }

        let mut retired = Vec::new();
        if let Some(previous) = self.current.get(&key).cloned() {
            if self.remove_binding(&previous) {
                retired.push(previous);
            }
        }
        self.watermarks.insert(
            key.clone(),
            Watermark {
                generation: binding.generation(),
                document_nonce: binding.document_nonce().to_owned(),
            },
        );
        self.current.insert(key, binding.id().to_owned());
        self.by_id.insert(binding.id().to_owned(), binding.clone());
        Ok((binding, retired))
    }

    pub(super) fn is_current(&self, binding: &SourceBinding) -> bool {
        self.by_id.get(binding.id()).is_some_and(|current| {
            current.is_active()
                && current.owner() == binding.owner()
                && current.frame_id() == binding.frame_id()
                && current.generation() == binding.generation()
                && current.document_nonce() == binding.document_nonce()
                && current.resource_session_id() == binding.resource_session_id()
                && current.authorization() == binding.authorization()
        })
    }

    pub(super) fn add_renderer(
        &mut self,
        renderer: &str,
        binding: &SourceBinding,
    ) -> Result<(), String> {
        if !self.is_current(binding) || !binding.is_active() {
            return Err("Plugin window source is no longer active".into());
        }
        if self.renderers.contains_key(renderer) {
            return Err("Native renderer label is already authorized".into());
        }
        if self.renderers.len() >= super::renderer::MAX_RENDERER_GRANTS {
            return Err("Native plugin renderer limit reached".into());
        }
        self.renderers
            .insert(renderer.to_owned(), RendererGrant::new(binding));
        Ok(())
    }

    pub(super) fn revoke_id(&mut self, id: &str) -> Vec<String> {
        if self.remove_binding(id) {
            vec![id.to_owned()]
        } else {
            Vec::new()
        }
    }

    pub(super) fn revoke_frame(&mut self, owner: &Owner, frame_id: &str) -> Vec<String> {
        let key = Key::new(owner, frame_id);
        self.current
            .get(&key)
            .cloned()
            .map(|id| self.revoke_id(&id))
            .unwrap_or_default()
    }

    pub(super) fn revoke_owner(&mut self, owner: &Owner) -> Vec<String> {
        self.revoke_matching(|key| &key.owner == owner, true)
    }

    pub(super) fn revoke_plugin(&mut self, plugin: &str) -> Vec<String> {
        self.revoke_matching(|key| key.owner.plugin == plugin, true)
    }

    pub(super) fn revoke_window(&mut self, window: &str) -> Vec<String> {
        self.revoke_matching(|key| key.owner.window == window, true)
    }

    pub(super) fn clear(&mut self) -> Vec<String> {
        self.revoke_matching(|_| true, true)
    }

    fn revoke_matching(
        &mut self,
        matches: impl Fn(&Key) -> bool,
        clear_watermarks: bool,
    ) -> Vec<String> {
        let keys: Vec<Key> = self
            .current
            .keys()
            .filter(|key| matches(key))
            .cloned()
            .collect();
        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(id) = self.current.get(&key).cloned() {
                if self.remove_binding(&id) {
                    removed.push(id);
                }
            }
        }
        if clear_watermarks {
            self.watermarks.retain(|key, _| !matches(key));
        }
        removed
    }

    fn remove_binding(&mut self, id: &str) -> bool {
        let Some(binding) = self.by_id.remove(id) else {
            return false;
        };
        binding
            .active_guard()
            .store(false, std::sync::atomic::Ordering::Release);
        let key = Key::of(&binding);
        if self.current.get(&key).is_some_and(|current| current == id) {
            self.current.remove(&key);
        }
        self.renderers.retain(|_, grant| {
            if grant.source_id == id {
                grant.deactivate();
                false
            } else {
                true
            }
        });
        true
    }
}
