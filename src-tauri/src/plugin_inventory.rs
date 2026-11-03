//! Installed plugin inventory with source ownership derived from trusted roots.

use std::path::Path;
#[cfg(test)]
use std::time::Duration;
use std::{path::PathBuf, sync::Arc};

use atools_core::{db::Database, Plugin};
use readiness::PluginInventoryReadiness;
use serde::Serialize;

pub(crate) mod bootstrap;
pub(crate) mod events;
mod logo;
pub(crate) mod readiness;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PluginSourceKind {
    Builtin,
    Imported,
    External,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginInventoryRecord {
    #[serde(flatten)]
    pub plugin: Plugin,
    pub source_kind: PluginSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory_logo_path: Option<String>,
}

pub(crate) async fn list_plugins_when_ready(
    readiness: &PluginInventoryReadiness,
    db: Arc<Database>,
    imported_root: PathBuf,
    builtin_root: Option<PathBuf>,
) -> Result<Vec<PluginInventoryRecord>, String> {
    readiness.wait_ready().await?;
    list_plugins_on_blocking_pool(db, imported_root, builtin_root).await
}

#[cfg(test)]
async fn list_plugins_when_ready_with_timeout(
    readiness: &PluginInventoryReadiness,
    db: Arc<Database>,
    imported_root: PathBuf,
    builtin_root: Option<PathBuf>,
    timeout: Duration,
) -> Result<Vec<PluginInventoryRecord>, String> {
    readiness.wait_ready_with_timeout(timeout).await?;
    list_plugins_on_blocking_pool(db, imported_root, builtin_root).await
}

async fn list_plugins_on_blocking_pool(
    db: Arc<Database>,
    imported_root: PathBuf,
    builtin_root: Option<PathBuf>,
) -> Result<Vec<PluginInventoryRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_plugins(&db, &imported_root, builtin_root.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn list_plugins(
    db: &Database,
    imported_root: &Path,
    builtin_root: Option<&Path>,
) -> Result<Vec<PluginInventoryRecord>, String> {
    let imported_root = crate::plugin_packages::canonical_target(imported_root);
    let builtin_root = builtin_root.and_then(crate::plugin_packages::canonical_target);
    db.list_plugins()
        .map_err(|error| error.to_string())
        .map(|plugins| {
            plugins
                .into_iter()
                .map(|plugin| {
                    let canonical_plugin_path =
                        crate::plugin_packages::canonical_target(Path::new(&plugin.path));
                    let source_kind = classify_plugin_path(
                        canonical_plugin_path.as_deref(),
                        imported_root.as_deref(),
                        builtin_root.as_deref(),
                    );
                    let inventory_logo_path = logo::resolve_inventory_logo(
                        &plugin,
                        canonical_plugin_path.as_deref(),
                        source_kind,
                        imported_root.as_deref(),
                        builtin_root.as_deref(),
                    );
                    PluginInventoryRecord {
                        plugin,
                        source_kind,
                        inventory_logo_path,
                    }
                })
                .collect()
        })
}

fn classify_plugin_path(
    plugin_path: Option<&Path>,
    imported_root: Option<&Path>,
    builtin_root: Option<&Path>,
) -> PluginSourceKind {
    let Some(plugin_path) = plugin_path else {
        return PluginSourceKind::External;
    };
    if builtin_root.is_some_and(|root| is_child_path(plugin_path, root)) {
        return PluginSourceKind::Builtin;
    }
    if imported_root.is_some_and(|root| is_child_path(plugin_path, root)) {
        return PluginSourceKind::Imported;
    }
    PluginSourceKind::External
}

fn is_child_path(candidate: &Path, root: &Path) -> bool {
    candidate != root && candidate.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;

    fn plugin(id: &str, path: &Path) -> Plugin {
        Plugin {
            id: id.into(),
            name: id.into(),
            version: "1.0.0".into(),
            path: path.to_string_lossy().into_owned(),
            enabled: false,
            manifest: serde_json::from_value(json!({
                "name": id,
                "features": [{"code":"open","explain":"open fixture"}]
            }))
            .unwrap(),
            created_at: "2026-10-16T00:00:00Z".into(),
            updated_at: "2026-10-16T00:00:00Z".into(),
        }
    }

    fn save(db: &Database, plugin: &Plugin) {
        db.save_plugin_with_features(plugin, &plugin.manifest.features)
            .unwrap();
    }

    #[test]
    fn classifies_canonical_builtin_imported_and_external_children() {
        let temp = tempfile::tempdir().unwrap();
        let imported = temp.path().join("app-data/plugins");
        let builtin = temp.path().join("bundle/resources/plugins/builtin");
        let external = temp.path().join("other/plugins");
        for directory in [
            imported.join("ordinary"),
            imported.join("builtin-helper"),
            builtin.join("calculator"),
            external.join("manual"),
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        let db = Database::in_memory().unwrap();
        for (id, path) in [
            ("builtin", builtin.join("calculator")),
            ("imported", imported.join("ordinary")),
            ("builtin-helper", imported.join("builtin-helper")),
            ("external", external.join("manual")),
        ] {
            save(&db, &plugin(id, &path));
        }
        let listed = list_plugins(&db, &imported, Some(&builtin)).unwrap();
        let kinds: std::collections::HashMap<_, _> = listed
            .into_iter()
            .map(|item| (item.plugin.id, item.source_kind))
            .collect();
        assert_eq!(kinds["builtin"], PluginSourceKind::Builtin);
        assert_eq!(kinds["imported"], PluginSourceKind::Imported);
        assert_eq!(kinds["builtin-helper"], PluginSourceKind::Imported);
        assert_eq!(kinds["external"], PluginSourceKind::External);
    }

    #[test]
    fn component_boundary_rejects_similarly_prefixed_sibling_roots() {
        let temp = tempfile::tempdir().unwrap();
        let imported = temp.path().join("plugins");
        let sibling = temp.path().join("plugins-archive/old");
        fs::create_dir_all(&sibling).unwrap();
        let db = Database::in_memory().unwrap();
        save(&db, &plugin("sibling", &sibling));
        let listed = list_plugins(&db, &imported, None).unwrap();
        assert_eq!(listed[0].source_kind, PluginSourceKind::External);
    }

    #[cfg(unix)]
    #[test]
    fn canonical_path_rejects_symlink_escape_from_import_root() {
        let temp = tempfile::tempdir().unwrap();
        let imported = temp.path().join("plugins");
        let outside = temp.path().join("outside/real-plugin");
        fs::create_dir_all(&imported).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = imported.join("linked-plugin");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let db = Database::in_memory().unwrap();
        save(&db, &plugin("linked", &link));
        let listed = list_plugins(&db, &imported, None).unwrap();
        assert_eq!(listed[0].source_kind, PluginSourceKind::External);
    }

    #[test]
    fn serializes_source_kind_without_nesting_or_removing_plugin_fields() {
        let source = PluginInventoryRecord {
            plugin: plugin("color-helper", Path::new("/plugins/color-helper")),
            source_kind: PluginSourceKind::Imported,
            inventory_logo_path: None,
        };
        let value: Value = serde_json::to_value(source).unwrap();
        assert_eq!(value["id"], "color-helper");
        assert_eq!(value["path"], "/plugins/color-helper");
        assert_eq!(value["source_kind"], "imported");
        assert!(value.get("inventory_logo_path").is_none());
        assert!(value.get("plugin").is_none());
        assert_eq!(value["manifest"]["features"][0]["code"], "open");
    }

    #[test]
    fn projects_only_trusted_inventory_logos_in_the_existing_list_result() {
        let temp = tempfile::tempdir().unwrap();
        let imported_root = temp.path().join("data/plugins");
        let external_root = temp.path().join("external");
        let imported_path = imported_root.join("reader");
        let external_path = external_root.join("manual");
        fs::create_dir_all(&imported_path).unwrap();
        fs::create_dir_all(&external_path).unwrap();
        // A valid 1x1 RGBA PNG signature + IHDR (inventory reads only this fixed header).
        let ihdr = [
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
            0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
        ];
        fs::write(imported_path.join("logo.png"), ihdr).unwrap();
        fs::write(external_path.join("logo.png"), ihdr).unwrap();

        let mut imported = plugin("reader", &imported_path);
        imported.manifest.logo = Some("logo.png".into());
        let mut external = plugin("manual", &external_path);
        external.manifest.logo = Some("logo.png".into());
        let db = Database::in_memory().unwrap();
        save(&db, &imported);
        save(&db, &external);

        let listed = list_plugins(&db, &imported_root, None).unwrap();
        let imported_record = listed
            .iter()
            .find(|record| record.plugin.id == "reader")
            .unwrap();
        assert_eq!(imported_record.source_kind, PluginSourceKind::Imported);
        assert_eq!(
            imported_record.inventory_logo_path.as_deref(),
            Some(
                imported_path
                    .join("logo.png")
                    .canonicalize()
                    .unwrap()
                    .to_str()
                    .unwrap()
            )
        );
        let external_record = listed
            .iter()
            .find(|record| record.plugin.id == "manual")
            .unwrap();
        assert_eq!(external_record.source_kind, PluginSourceKind::External);
        assert!(external_record.inventory_logo_path.is_none());
    }
}

#[cfg(test)]
#[path = "plugin_inventory/readiness_tests.rs"]
mod readiness_tests;
