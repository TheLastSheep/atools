use anyhow::Result;
use atools_core::db::Database;
use atools_plugin::loader::load_plugin_from_disk;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tracing::{info, warn};

/// Load all builtin plugins from the resources/plugins/builtin directory.
///
/// For each builtin plugin:
/// 1. Load manifest from disk
/// 2. Save plugin record to the database
/// 3. Index features for search
/// Plugin code is loaded only by an actual UI/Agent invocation. Registration
/// must not run preload hooks, launch Node, or perform plugin side effects.
pub async fn load_builtin_plugins(
    db: Arc<Database>,
    resource_builtin_dir: Option<PathBuf>,
) -> Result<()> {
    let builtin_dir = get_builtin_plugins_dir(resource_builtin_dir);
    load_builtin_plugins_from_dir(db, &builtin_dir).await
}

async fn load_builtin_plugins_from_dir(db: Arc<Database>, builtin_dir: &Path) -> Result<()> {
    if !builtin_dir.exists() {
        warn!("Builtin plugins directory not found: {:?}", builtin_dir);
        anyhow::bail!(
            "Builtin plugins directory not found: {}",
            builtin_dir.display()
        );
    }

    let mut entries = fs::read_dir(builtin_dir).await?;
    let mut loaded_count = 0;
    let mut failure_count = 0;
    let mut active_plugin_ids = BTreeSet::new();

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        match fs::metadata(&path).await {
            Ok(metadata) if metadata.is_dir() => {
                match load_single_builtin_plugin(&db, &path).await {
                    Ok(plugin_id) => {
                        active_plugin_ids.insert(plugin_id);
                        loaded_count += 1;
                        info!("Loaded builtin plugin: {:?}", path);
                    }
                    Err(e) => {
                        warn!("Failed to load builtin plugin {:?}: {}", path, e);
                        failure_count += 1;
                    }
                }
            }
            // Preserve the existing behavior for files and non-directory links.
            Ok(_) => {}
            Err(error) => {
                warn!(
                    "Failed to inspect builtin plugin entry {:?}: {}",
                    path, error
                );
                failure_count += 1;
            }
        }
    }

    if failure_count > 0 {
        anyhow::bail!("Failed to register {failure_count} builtin plugin(s)");
    }

    remove_stale_builtin_plugins(&db, &active_plugin_ids)?;

    info!("Loaded {} builtin plugins", loaded_count);
    Ok(())
}

async fn load_single_builtin_plugin(db: &Arc<Database>, plugin_dir: &PathBuf) -> Result<String> {
    let plugin_dir = plugin_dir.canonicalize()?;
    // Load plugin metadata from disk
    let plugin = load_plugin_from_disk(&plugin_dir)?;
    let plugin_id = plugin.id.clone();

    // Refresh manifest metadata without overwriting the persisted enabled state.
    db.refresh_builtin_plugin_metadata_with_features(&plugin, &plugin.manifest.features)
        .map_err(|e| anyhow::anyhow!("DB refresh failed: {}", e))?;

    info!(
        "Installed builtin plugin: {} ({}) with {} features",
        plugin.name,
        plugin.id,
        plugin.manifest.features.len()
    );
    Ok(plugin_id)
}

#[cfg(test)]
#[path = "builtin_plugins_startup_tests.rs"]
mod startup_tests;

#[cfg(test)]
#[path = "builtin_plugins_state_tests.rs"]
mod state_tests;

fn remove_stale_builtin_plugins(db: &Database, active_plugin_ids: &BTreeSet<String>) -> Result<()> {
    for plugin in db.list_plugins()? {
        if active_plugin_ids.contains(&plugin.id) || !is_builtin_plugin_path(&plugin.path) {
            continue;
        }
        db.delete_plugin(&plugin.id)?;
        info!(
            "Removed stale builtin plugin: {} ({}) from {}",
            plugin.name, plugin.id, plugin.path
        );
    }
    Ok(())
}

pub(crate) fn is_builtin_plugin_path(value: &str) -> bool {
    value
        .replace('\\', "/")
        .to_lowercase()
        .contains("resources/plugins/builtin/")
}

fn get_builtin_plugins_dir(resource_builtin_dir: Option<PathBuf>) -> PathBuf {
    // Prefer Tauri's resource directory. tauri-build copies the configured
    // bundle resources into the Cargo target directory for development and
    // into the application resource directory for packaged builds.
    let mut candidates = Vec::new();
    if let Some(resource_builtin_dir) = resource_builtin_dir {
        candidates.push(resource_builtin_dir);
    }

    // Keep source-tree fallbacks for direct Rust tests and unusual developer
    // invocations that do not run through the Tauri build pipeline.
    if let Some(root_builtin_dir) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join("resources/plugins/builtin"))
    {
        candidates.push(root_builtin_dir);
    }
    candidates.push(PathBuf::from("resources/plugins/builtin"));
    candidates.push(PathBuf::from("src-tauri/resources/plugins/builtin"));

    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }

    // Try relative to executable (production builds)
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_dir = exe_path.parent().unwrap();
        // macOS: .app/Contents/Resources/plugins/builtin
        let macos_path = exe_dir.join("../Resources/plugins/builtin");
        if macos_path.exists() {
            return macos_path;
        }

        // Windows/Linux: resources/plugins/builtin
        let win_linux_path = exe_dir.join("resources/plugins/builtin");
        if win_linux_path.exists() {
            return win_linux_path;
        }
    }

    // Fallback
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("resources/plugins/builtin"))
}

#[cfg(test)]
mod tests {
    use super::is_builtin_plugin_path;

    #[test]
    fn identifies_absolute_and_relative_builtin_plugin_paths() {
        assert!(is_builtin_plugin_path(
            "/Applications/ATools.app/Contents/Resources/plugins/builtin/calc"
        ));
        assert!(is_builtin_plugin_path(
            "resources/plugins/builtin/calculator"
        ));
        assert!(is_builtin_plugin_path(
            r"C:\ATools\resources\plugins\builtin\calculator"
        ));
        assert!(!is_builtin_plugin_path(
            "/Users/example/.atools/plugins/calculator"
        ));
    }
}
