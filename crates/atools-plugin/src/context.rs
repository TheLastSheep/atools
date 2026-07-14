//! Plugin execution context.
//!
//! A [`PluginContext`] is a lightweight handle returned to the caller after a
//! plugin's `preload.js` has been evaluated. It holds metadata about the
//! plugin (ID, creation time) and provides information about whether the
//! plugin has a preload script.
//!
//! The actual `rquickjs::Context` lives exclusively on the dedicated JS
//! worker thread managed by [`crate::runtime::JsRuntime`].

use std::path::PathBuf;
use std::time::Instant;

/// Metadata about a loaded plugin context.
///
/// Returned by [`crate::runtime::JsRuntime::load_plugin`] after the plugin's
/// `preload.js` has been successfully evaluated.
#[derive(Debug, Clone)]
pub struct PluginContext {
    /// Unique identifier for this plugin.
    pub plugin_id: String,

    /// Path to the preload script, if one exists.
    pub preload_path: Option<PathBuf>,

    /// Wall-clock time when the plugin was loaded.
    pub loaded_at: Instant,

    /// Whether the plugin has a preload script that was successfully executed.
    pub has_preload: bool,
}

impl PluginContext {
    /// Creates a new plugin context handle.
    ///
    /// # Arguments
    ///
    /// * `plugin_id` — Unique identifier for the plugin.
    /// * `preload_path` — Path to the preload script, if one exists.
    /// * `has_preload` — Whether a preload script was successfully executed.
    pub fn new(plugin_id: String, preload_path: Option<PathBuf>, has_preload: bool) -> Self {
        Self {
            plugin_id,
            preload_path,
            loaded_at: Instant::now(),
            has_preload,
        }
    }
}
