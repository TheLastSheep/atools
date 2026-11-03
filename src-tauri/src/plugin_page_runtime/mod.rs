//! Opt-in page documents for the isolated native dialog fixture only.
//!
//! Ordinary UI stays opaque. The native app remains the parent; no parent HTML,
//! invoke key, bridge endpoint, preload or action configuration is served by GET.
//! Top-level window URL checks constrain the fixture but do not authenticate a
//! caller frame. Existing main-frame-only Tauri invoke credentials remain the
//! command boundary; they must never be copied into the child document.
mod binding;
pub(crate) mod commands;
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) mod navigation_observer;
#[cfg(any(test, feature = "legacy-node-smoke"))]
mod navigation_policy;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) mod navigation_probe;
mod protocol;
mod registry;
#[cfg(test)]
mod tests;

use crate::{plugin_asset_protocol::authorization, state::AppState};
#[cfg(test)]
pub(crate) use binding::test_binding;
pub(crate) use binding::DocumentBinding;
pub(crate) use protocol::register;
use registry::Registry;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

const PARENT_ORIGIN: &str = "atools-panel://localhost";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedPage {
    page_document_id: String,
    bootstrap_url: String,
    expected_origin: String,
    parent_origin: String,
    resource_base_url: String,
}

pub(crate) fn enabled(app: &AppHandle) -> bool {
    #[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
    {
        std::env::args().any(|arg| arg == "--atools-plugin-page-document-smoke")
            && app
                .try_state::<crate::legacy_node_desktop_smoke::panel_dialog::DialogFixture>()
                .is_some()
    }
    #[cfg(not(all(feature = "legacy-node-smoke", target_os = "macos")))]
    {
        let _ = app;
        false
    }
}

fn require_enabled(app: &AppHandle) -> Result<(), String> {
    if enabled(app) {
        Ok(())
    } else {
        Err(
            "Plugin page documents are unsupported outside the dedicated macOS native fixture"
                .into(),
        )
    }
}

pub(super) fn parent_origin(app: &AppHandle, window: &str) -> Result<&'static str, String> {
    let window = app
        .get_webview_window(window)
        .ok_or("Plugin page window is closed")?;
    let url = window
        .url()
        .map_err(|_| "Plugin page parent URL unavailable")?;
    if url.as_str() != "atools-panel://localhost/" {
        return Err("Plugin page parent is not the dedicated native fixture".into());
    }
    Ok(PARENT_ORIGIN)
}

fn registry(app: &AppHandle) -> Arc<Registry> {
    if app.try_state::<Arc<Registry>>().is_none() {
        app.manage(Arc::new(Registry::default()));
    }
    app.state::<Arc<Registry>>().inner().clone()
}

/// None preserves the old opaque route without creating or consulting a manager.
pub(crate) fn resolve_binding(
    app: &AppHandle,
    window: &str,
    plugin: &str,
    page_document_id: Option<&str>,
) -> Result<Option<DocumentBinding>, String> {
    let Some(id) = page_document_id else {
        return Ok(None);
    };
    require_enabled(app)?;
    parent_origin(app, window)?;
    let registry = app
        .try_state::<Arc<Registry>>()
        .ok_or("Plugin page is unavailable")?;
    let document = registry
        .get(id, window, plugin)
        .ok_or("Plugin page owner is unavailable")?;
    let db = &app.state::<AppState>().db;
    match authorization(db, plugin) {
        Ok(current) if current == document.authorization && document.binding.is_active() => {
            Ok(Some(document.binding))
        }
        _ => {
            document.binding.revoke();
            Err("Plugin page code is no longer current".into())
        }
    }
}

pub(crate) fn invalidate_plugin(app: &AppHandle, plugin: &str) {
    if let Some(registry) = app.try_state::<Arc<Registry>>() {
        registry.invalidate_plugin(plugin);
    }
}
pub(crate) fn close_window(app: &AppHandle, window: &str) {
    if let Some(registry) = app.try_state::<Arc<Registry>>() {
        registry.close_window(window);
    }
}
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn document_count(app: &AppHandle) -> usize {
    app.try_state::<Arc<Registry>>()
        .map(|registry| registry.count())
        .unwrap_or(0)
}
