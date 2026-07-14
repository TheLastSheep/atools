//! Plugin loader for reading manifests and preload scripts from disk.
//!
//! This module provides utilities to:
//! - Parse `plugin.json` manifest files
//! - Read `preload.js` scripts
//! - Generate stable plugin IDs from plugin names

use std::path::Path;

use anyhow::{Context, Result};
use atools_core::models::{Plugin, PluginManifest};

/// Loads a plugin manifest from a directory on disk.
///
/// Reads and parses the `plugin.json` file in the given directory and returns
/// the parsed manifest.
///
/// # Arguments
///
/// * `plugin_dir` — Path to the plugin's root directory.
///
/// # Returns
///
/// The parsed `PluginManifest`.
///
/// # Errors
///
/// Returns an error if the manifest file cannot be read or parsed.
pub fn load_manifest(plugin_dir: &Path) -> Result<PluginManifest> {
    let manifest_path = plugin_dir.join("plugin.json");

    let manifest_content = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("Failed to read manifest at {:?}", manifest_path))?;

    let manifest: PluginManifest = serde_json::from_str(&manifest_content)
        .with_context(|| format!("Failed to parse manifest at {:?}", manifest_path))?;

    Ok(manifest)
}

/// Loads a plugin from a directory on disk.
///
/// Reads the `plugin.json` manifest and constructs a `Plugin` record. This
/// function does not execute the preload script — that is handled separately
/// by the runtime.
///
/// # Arguments
///
/// * `plugin_dir` — Path to the plugin's root directory.
///
/// # Returns
///
/// A `Plugin` record with metadata from the manifest.
///
/// # Errors
///
/// Returns an error if the manifest cannot be read or parsed.
pub fn load_plugin_from_disk(plugin_dir: &Path) -> Result<Plugin> {
    let manifest = load_manifest(plugin_dir)?;

    // Generate a stable plugin ID from the name
    let plugin_id = plugin_id_from_name(&manifest.name);

    Ok(Plugin {
        id: plugin_id,
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: plugin_dir.to_string_lossy().to_string(),
        enabled: true,
        manifest,
        created_at: atools_core::utils::now_iso(),
        updated_at: atools_core::utils::now_iso(),
    })
}

/// Reads the content of a plugin's preload script.
///
/// # Arguments
///
/// * `plugin_dir` — Path to the plugin's root directory.
/// * `preload` — Relative path to the preload script (from the manifest).
///
/// # Returns
///
/// The preload script content as a string.
///
/// # Errors
///
/// Returns an error if the file cannot be read.
pub fn read_preload_js(plugin_dir: &Path, preload: &str) -> Result<String> {
    let preload_path = plugin_dir.join(preload);
    std::fs::read_to_string(&preload_path)
        .with_context(|| format!("Failed to read preload script at {:?}", preload_path))
}

/// Generates a stable plugin ID from the plugin name.
///
/// Uses a hash of the name to produce a deterministic ID. The same name will
/// always produce the same ID, but different names will (with high probability)
/// produce different IDs.
fn plugin_id_from_name(name: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    let hash = hasher.finish();

    format!("plugin_{:x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_id_generation() {
        let id1 = plugin_id_from_name("test-plugin");
        let id2 = plugin_id_from_name("test-plugin");
        let id3 = plugin_id_from_name("different-plugin");

        assert_eq!(id1, id2); // Same name -> same ID
        assert_ne!(id1, id3); // Different name -> different ID
        assert!(id1.starts_with("plugin_"));
    }
}
