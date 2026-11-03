//! Private identity of one explicitly selected child preload. Never serialized.
use super::node_entry::SelectedEntry;
use atools_core::{Database, Plugin};
use atools_plugin::package_resolution::{self, page_requirements};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SelectedPreload {
    plugin_id: String,
    plugin_path: String,
    version: String,
    revision: Option<String>,
    relative: String,
    package_root: PathBuf,
    source_digest: Vec<u8>,
}

impl SelectedPreload {
    pub fn capture(
        plugin: &Plugin,
        relative: &str,
        revision: Option<String>,
    ) -> Result<Self, String> {
        if !plugin.enabled {
            return Err("Plugin is disabled".into());
        }
        let normalized = package_resolution::normalize_package_asset_path(relative)
            .map_err(|_| "Selected preload must stay inside its package")?;
        // The IPC contract accepts only a normalized, portable package anchor.
        if normalized.to_str() != Some(relative)
            || relative.len() > 4096
            || relative.chars().any(char::is_control)
        {
            return Err("Selected preload must be a normalized package-relative file".into());
        }
        let package = package_resolution::resolve_plugin_package(Path::new(&plugin.path))
            .map_err(|_| "Plugin package is unavailable")?;
        if package.package_root != Path::new(&plugin.path) {
            return Err("Installed plugin package root changed; reopen the plugin".into());
        }
        if package.manifest.name != plugin.name || package.manifest.version != plugin.version {
            return Err("Installed plugin identity changed; reopen the plugin".into());
        }
        let inspection =
            page_requirements::inspect_selected_preload(&package.package_root, relative).map_err(
                |_| "Selected preload graph is unsafe, missing or exceeds its inspection budget",
            )?;
        if inspection.requirements.node_usage != page_requirements::Usage::Detected {
            return Err("Selected preload has no detected Node module requirement".into());
        }
        let mut digest = Sha256::new();
        digest.update(
            serde_json::to_vec(&package.raw_manifest).map_err(|_| "Invalid plugin manifest")?,
        );
        let mut sources = inspection.sources;
        sources.sort_by(|left, right| left.0.cmp(&right.0));
        for (path, source) in sources {
            let path = path
                .to_str()
                .ok_or("Selected preload path is not portable")?;
            digest.update((path.len() as u64).to_le_bytes());
            digest.update(path.as_bytes());
            digest.update((source.len() as u64).to_le_bytes());
            digest.update(source);
        }
        Ok(Self {
            plugin_id: plugin.id.clone(),
            plugin_path: plugin.path.clone(),
            version: plugin.version.clone(),
            revision,
            relative: relative.into(),
            package_root: package.package_root,
            source_digest: digest.finalize().to_vec(),
        })
    }

    pub fn validate_revision(&self, db: &Database, plugin: &Plugin) -> Result<(), String> {
        if self.revision != crate::plugin_code_revision::current(db, &plugin.id)? {
            return Err("Selected plugin code changed during authorization; reopen it".into());
        }
        Ok(())
    }

    pub fn revalidate(&self, plugin: &Plugin) -> Result<SelectedEntry, String> {
        let current = Self::capture(plugin, &self.relative, self.revision.clone())?;
        if current != *self {
            return Err("Selected preload changed during authorization; reopen the plugin".into());
        }
        Ok(SelectedEntry {
            package_root: self.package_root.clone(),
            entry: self.package_root.join(&self.relative),
        })
    }
}
