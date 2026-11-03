//! Isolated package and input-tree setup for production Panel fixture scenarios.
use atools_core::Database;
use std::path::Path;

pub(super) struct InstalledPanelSources {
    pub imported: Vec<String>,
    pub dataset: super::super::catalog_fixture::CatalogDataset,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum OriginalPanelProfile {
    Standard,
    HeadFileTree,
    HeadDeveloperCodecTools,
}

pub(super) fn install(
    db: &Database,
    root: &Path,
    plugin_root: &Path,
    profile: OriginalPanelProfile,
) -> Result<InstalledPanelSources, String> {
    let ids: &[&str] = match profile {
        OriginalPanelProfile::Standard => &["char-transform", "file-tree"],
        OriginalPanelProfile::HeadFileTree => &["file-tree"],
        OriginalPanelProfile::HeadDeveloperCodecTools => &["developer-codec-tools"],
    };
    let sources: Vec<_> = ids
        .iter()
        .map(|id| plugin_root.join(id).to_string_lossy().into_owned())
        .collect();
    let result =
        crate::ztools_import::import_ztools_plugins(db, &root.join("plugins"), &sources, false)?;
    if result.imported.len() != ids.len() || !result.failed.is_empty() || !result.skipped.is_empty()
    {
        return Err(
            "Pinned Panel fixture package import did not match the selected source set".into(),
        );
    }
    let dataset = super::super::catalog_fixture::install(db, root, &result.imported)?;
    let tree = root.join("tree-data");
    if profile == OriginalPanelProfile::HeadFileTree {
        for (relative, content) in [
            ("readme.txt", "ATools FileTree fixture readme"),
            ("ignored.log", "ATools FileTree ignore recovery fixture"),
            ("src/index.ts", "export const fixture = true;"),
            ("components/Button.tsx", "export function Button() {}"),
            (".hidden/secret.txt", "hidden fixture"),
        ] {
            let path = tree.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(path, content).map_err(|error| error.to_string())?;
        }
    } else if profile == OriginalPanelProfile::Standard {
        std::fs::create_dir_all(tree.join("src")).map_err(|error| error.to_string())?;
        for name in ["readme.txt", "ignored.log", "src/index.ts"] {
            std::fs::write(tree.join(name), "isolated fixture")
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(InstalledPanelSources {
        imported: result.imported,
        dataset,
    })
}
