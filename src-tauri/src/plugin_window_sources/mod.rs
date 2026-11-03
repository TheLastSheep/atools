//! Host-only source bindings for authenticated opaque plugin frames.
//! Binding identifiers are capabilities kept in native memory and never injected
//! into plugin documents.
pub(crate) mod commands;
mod documents;
mod identity;
mod registry;
mod renderer;
#[cfg(test)]
mod tests;

use crate::{plugin_asset_protocol, state::AppState};
use atools_core::Database;
use parking_lot::Mutex;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager};

pub(crate) use commands::{
    bind_plugin_window_source, close_plugin_window_source, prepare_plugin_window_document,
};
pub(crate) use documents::WindowDocument;
use registry::Registry;
pub(crate) use renderer::{
    authorize_renderer, resolve_renderer_access, resolve_renderer_document_access, revoke_renderer,
    RendererPermit,
};

type SharedRegistry = Arc<Mutex<Registry>>;

#[derive(Clone)]
pub(crate) struct SourceBinding {
    id: String,
    owner: plugin_asset_protocol::Owner,
    resource_session_id: String,
    authorization: plugin_asset_protocol::Authorization,
    frame_id: String,
    generation: u64,
    document_nonce: String,
    active: Arc<AtomicBool>,
}

impl SourceBinding {
    fn new(
        owner: plugin_asset_protocol::Owner,
        resource_session_id: String,
        authorization: plugin_asset_protocol::Authorization,
        frame_id: String,
        generation: u64,
        document_nonce: String,
    ) -> Self {
        let id = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        Self {
            id,
            owner,
            resource_session_id,
            authorization,
            frame_id,
            generation,
            document_nonce,
            active: Arc::new(AtomicBool::new(true)),
        }
    }

    /// Host-only opaque identifier. Never serialize or log this value.
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn owner(&self) -> &plugin_asset_protocol::Owner {
        &self.owner
    }
    pub(crate) fn frame_id(&self) -> &str {
        &self.frame_id
    }
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
    pub(crate) fn document_nonce(&self) -> &str {
        &self.document_nonce
    }
    pub(crate) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub(crate) fn validate(&self, app: &AppHandle, db: &Database) -> Result<(), String> {
        if !self.is_active() {
            return Err("Plugin window source is no longer active".into());
        }
        if crate::plugin_browser_window_runtime::validate_source_frame(
            app,
            &self.owner,
            &self.frame_id,
        )
        .is_err()
        {
            retire_binding(app, &self.id);
            return Err("Plugin source native window is no longer active".into());
        }
        let current = plugin_asset_protocol::validate_source_resources(
            app,
            db,
            &self.owner,
            &self.resource_session_id,
        );
        match current {
            Ok(authorization) if authorization == self.authorization && self.is_active() => Ok(()),
            _ => {
                retire_binding(app, &self.id);
                Err("Plugin window source authorization is no longer current".into())
            }
        }
    }

    pub(super) fn resource_session_id(&self) -> &str {
        &self.resource_session_id
    }
    pub(super) fn authorization(&self) -> &plugin_asset_protocol::Authorization {
        &self.authorization
    }
    pub(super) fn active_guard(&self) -> Arc<AtomicBool> {
        self.active.clone()
    }
}

fn registry(app: &AppHandle) -> Option<SharedRegistry> {
    app.try_state::<SharedRegistry>()
        .map(|state| state.inner().clone())
}

fn registry_or_create(app: &AppHandle) -> SharedRegistry {
    if app.try_state::<SharedRegistry>().is_none() {
        app.manage(Arc::new(Mutex::new(Registry::default())));
    }
    app.state::<SharedRegistry>().inner().clone()
}

/// Resolve an opaque host-held source id and recheck its exact resource lease,
/// package root and code revision before returning the clone to native runtime.
pub(crate) fn resolve(app: &AppHandle, window: &str, id: &str) -> Result<SourceBinding, String> {
    let registry = registry(app).ok_or("Plugin window source is unavailable")?;
    let binding = registry
        .lock()
        .by_id(id)
        .ok_or("Plugin window source is unavailable")?;
    if binding.owner.window != window {
        return Err("Plugin window source owner mismatch".into());
    }
    let state = app
        .try_state::<AppState>()
        .ok_or("Plugin application state is unavailable")?;
    binding.validate(app, &state.db)?;
    if !binding.is_active() {
        return Err("Plugin window source is no longer active".into());
    }
    Ok(binding)
}

pub(crate) fn finish_revocations(app: &AppHandle, ids: Vec<String>) {
    if !ids.is_empty() {
        crate::plugin_browser_window_runtime::close_sources(app, &ids);
    }
}

pub(crate) fn revoke_owner_bindings(
    app: &AppHandle,
    owner: &plugin_asset_protocol::Owner,
) -> Vec<String> {
    registry(app)
        .map(|registry| registry.lock().revoke_owner(owner))
        .unwrap_or_default()
}

pub(crate) fn revoke_plugin_bindings(app: &AppHandle, plugin: &str) -> Vec<String> {
    registry(app)
        .map(|registry| registry.lock().revoke_plugin(plugin))
        .unwrap_or_default()
}

pub(crate) fn revoke_window_bindings(app: &AppHandle, window: &str) -> Vec<String> {
    registry(app)
        .map(|registry| registry.lock().revoke_window(window))
        .unwrap_or_default()
}

pub(crate) fn revoke_owner(app: &AppHandle, owner: &plugin_asset_protocol::Owner) {
    finish_revocations(app, revoke_owner_bindings(app, owner));
}

pub(crate) fn revoke_plugin(app: &AppHandle, plugin: &str) {
    finish_revocations(app, revoke_plugin_bindings(app, plugin));
}

pub(crate) fn revoke_window(app: &AppHandle, window: &str) {
    finish_revocations(app, revoke_window_bindings(app, window));
}

pub(crate) fn clear(app: &AppHandle) {
    if let Some(registry) = registry(app) {
        let ids = registry.lock().clear();
        finish_revocations(app, ids);
    }
}

pub(crate) fn revoke_frame(app: &AppHandle, owner: &plugin_asset_protocol::Owner, frame_id: &str) {
    if let Some(registry) = registry(app) {
        let ids = registry.lock().revoke_frame(owner, frame_id);
        finish_revocations(app, ids);
    }
}

fn retire_binding(app: &AppHandle, id: &str) {
    if let Some(registry) = registry(app) {
        let ids = registry.lock().revoke_id(id);
        finish_revocations(app, ids);
    }
}
