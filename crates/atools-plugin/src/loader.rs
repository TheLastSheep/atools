//! Plugin loader for reading manifests and preload scripts from disk.
//!
//! This module provides utilities to:
//! - Parse `plugin.json` manifest files
//! - Read `preload.js` scripts
//! - Generate stable plugin IDs from plugin names

use std::path::Path;

use crate::package_resolution::{resolve_plugin_package, PackageReadiness};
use anyhow::Result;
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
    Ok(resolve_plugin_package(plugin_dir)?.manifest)
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
    let package = resolve_plugin_package(plugin_dir)?;
    let manifest = package.manifest;

    // Generate a stable plugin ID from the name
    let plugin_id = plugin_id_from_name(&manifest.name);

    Ok(Plugin {
        id: plugin_id,
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: package.package_root.to_string_lossy().to_string(),
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
pub fn resolve_manifest_path(plugin_dir: &Path) -> std::path::PathBuf {
    try_resolve_manifest_path(plugin_dir).unwrap_or_else(|_| plugin_dir.join("plugin.json"))
}

/// Fallible variant for callers that must preserve resolution/identity diagnostics.
pub fn try_resolve_manifest_path(plugin_dir: &Path) -> Result<std::path::PathBuf> {
    Ok(resolve_plugin_package(plugin_dir)?.manifest_path)
}

pub fn read_preload_js(plugin_dir: &Path, preload: &str) -> Result<String> {
    crate::package_resolution::read_package_preload(plugin_dir, preload)
}

/// Compatibility tier for running a ZTools/uTools plugin inside ATools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZToolsCompatibilityTier {
    /// Tier 1: Static UI + `window.ztools`/`window.utools` bridge shim — runs directly in WebView.
    Tier1DirectWebView,
    /// Tier 2: Uses `preload.js` with pure JS or Node/Electron CJS — runs via QuickJS preload or Node Sidecar shim.
    Tier2QuickJsOrNodeSidecar,
    /// Tier 3: Source-only repository requiring `npm run build` or native C++ `.node` addons.
    Tier3RequiresBuildOrNativeAddon,
}

/// Detailed compatibility diagnosis for a ZTools plugin directory.
#[derive(Debug, Clone)]
pub struct ZToolsCompatibilityReport {
    pub plugin_name: String,
    pub tier: ZToolsCompatibilityTier,
    pub main_entry_exists: bool,
    pub has_preload: bool,
    pub uses_node_builtins: bool,
    pub uses_electron_api: bool,
    pub page_node_usage: crate::package_resolution::page_requirements::Usage,
    pub requires_frontend_build: bool,
    pub adapter_recommendation: String,
}

/// Evaluates a ZTools plugin directory and classifies its runtime requirements and adapter tier.
pub fn assess_ztools_plugin_compatibility(plugin_dir: &Path) -> Result<ZToolsCompatibilityReport> {
    let package = resolve_plugin_package(plugin_dir)?;
    let manifest = &package.manifest;
    let main_entry_exists = manifest
        .main
        .as_deref()
        .is_some_and(|main| !main.trim().is_empty())
        && !package
            .diagnostics
            .iter()
            .any(|item| item.code == "missing_main");

    let preload_content = manifest
        .preload
        .as_deref()
        .and_then(|rel| read_preload_js(&package.package_root, rel).ok());
    let has_preload = manifest.preload.is_some();

    let (mut uses_node_builtins, mut uses_electron_api) = if let Some(ref code) = preload_content {
        let node = code.contains("require(")
            || code.contains("node:")
            || code.contains("child_process")
            || code.contains("process.");
        let electron = code.contains("require('electron')")
            || code.contains("require(\"electron\")")
            || code.contains("ipcRenderer");
        (node, electron)
    } else {
        (false, false)
    };
    let page_requirements =
        crate::package_resolution::page_requirements::inspect_plugin_page(&package.source_root)
            .unwrap_or(
                crate::package_resolution::page_requirements::PageRequirements {
                    node_usage: crate::package_resolution::page_requirements::Usage::Unknown,
                    electron_usage: crate::package_resolution::page_requirements::Usage::Unknown,
                },
            );
    uses_node_builtins |= page_requirements.node_usage
        == crate::package_resolution::page_requirements::Usage::Detected;
    uses_electron_api |= page_requirements.electron_usage
        == crate::package_resolution::page_requirements::Usage::Detected;
    let page_requires_node = preload_content.is_none() && uses_node_builtins;

    let requires_frontend_build = package.readiness == PackageReadiness::RequiresBuild;

    let (tier, adapter_recommendation) = if package.readiness == PackageReadiness::Incomplete {
        (
            ZToolsCompatibilityTier::Tier3RequiresBuildOrNativeAddon,
            "Selected package is incomplete; restore its declared entry/preload/script/stylesheet files before importing. Files are never borrowed from another package root.".to_string(),
        )
    } else if package.readiness == PackageReadiness::Remote {
        (
            ZToolsCompatibilityTier::Tier1DirectWebView,
            "Remote entry is metadata only: no network request or local/offline readiness verification was performed.".to_string(),
        )
    } else if requires_frontend_build {
        (
            ZToolsCompatibilityTier::Tier3RequiresBuildOrNativeAddon,
            "Run Vite/Webpack build pipeline (`npm install && npm run build`) before packaging into ATools.".to_string(),
        )
    } else if (has_preload || page_requires_node) && (uses_node_builtins || uses_electron_api) {
        (
            ZToolsCompatibilityTier::Tier2QuickJsOrNodeSidecar,
            if page_requires_node {
                "Prepare the audited ATools Node Sidecar for this page's detected Node module usage; execute page scripts only in the isolated WebView.".to_string()
            } else {
                "Route preload through ATools Node Sidecar CJS/Electron Shim (`window.services` RPC proxy + `electron.clipboard/shell` polyfill).".to_string()
            },
        )
    } else if has_preload {
        (
            ZToolsCompatibilityTier::Tier2QuickJsOrNodeSidecar,
            "Execute preload in embedded QuickJS sandbox (`atools-plugin` runtime) + `ztools-shim.js`.".to_string(),
        )
    } else {
        (
            ZToolsCompatibilityTier::Tier1DirectWebView,
            "Direct execution in Tauri WebView with `ztools-shim.js` (`window.ztools` / `window.utools`).".to_string(),
        )
    };

    Ok(ZToolsCompatibilityReport {
        plugin_name: manifest.name.clone(),
        tier,
        main_entry_exists,
        has_preload,
        uses_node_builtins,
        uses_electron_api,
        page_node_usage: page_requirements.node_usage,
        requires_frontend_build,
        adapter_recommendation,
    })
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
