use atools_core::models::PluginManifest;
use std::path::Path;

use super::manifest_selection::{self, ManifestSelection, ManifestSelectionInfo, SelectedManifest};
use super::{SourceBuildBlocker, SourceBuildInspection, SourceBuildStatus};

/// Preserve a resolver-ready package only when an explicit selection names that
/// same package. Legacy default resolution remains authoritative, but its
/// selected-manifest metadata is cleared if it describes another identity.
pub(super) fn inspect_ready_package(
    source_root: &Path,
    manifest: &PluginManifest,
    requested: Option<ManifestSelection>,
    selected: Option<&SelectedManifest>,
    info: &mut ManifestSelectionInfo,
) -> Option<SourceBuildInspection> {
    let resolved_identity = manifest_selection::identity(manifest);
    let selected_matches = selected.is_some_and(|candidate| {
        let Some(resolved_identity) = resolved_identity.as_ref() else {
            return false;
        };
        let Some(parsed) = candidate.parsed.as_ref().filter(|_| candidate.valid) else {
            return false;
        };
        let mut normalized = parsed.clone();
        crate::package_resolution::normalize_candidate_manifest_paths(
            source_root,
            &candidate.relative_path,
            &mut normalized,
        )
        .is_ok()
            && manifest_selection::identity(&normalized).as_ref() == Some(resolved_identity)
    });

    if requested.is_some() && !selected_matches {
        return None;
    }
    if requested.is_none() && !selected_matches {
        info.clear_resolved_manifest();
    }

    let plugin_id = super::policy::stable_installation_id(&manifest.name);
    if plugin_id.is_none() {
        return Some(SourceBuildInspection::from_parts_with_manifest(
            SourceBuildStatus::Blocked,
            None,
            Some(manifest.version.clone()),
            vec![SourceBuildBlocker::fixed(
                "plugin_id_invalid",
                "The plugin name cannot produce a stable installation ID",
            )],
            None,
            info.clone(),
        ));
    }
    Some(SourceBuildInspection::from_parts_with_manifest(
        SourceBuildStatus::AlreadyReady,
        plugin_id,
        Some(manifest.version.clone()),
        Vec::new(),
        None,
        info.clone(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_build::manifest_selection;
    use serde_json::json;

    fn write_manifest(root: &std::path::Path, relative: &str, value: &serde_json::Value) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn ready_root() -> tempfile::TempDir {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        write_manifest(
            root.path(),
            "plugin.json",
            &json!({
                "name":"ready-a", "version":"1.0.0", "main":"index.html"
            }),
        );
        std::fs::write(
            root.path().join("index.html"),
            "<html><body>ready</body></html>",
        )
        .unwrap();
        root
    }

    #[test]
    fn default_root_and_matching_explicit_public_keep_ready_identity() {
        let root = ready_root();
        write_manifest(
            root.path(),
            "public/plugin.json",
            &json!({
                "name":"public-b", "version":"2.0.0", "main":"public.html"
            }),
        );

        let default = crate::source_build::inspect_source_build(root.path()).unwrap();
        assert_eq!(default.status, SourceBuildStatus::AlreadyReady);
        assert_eq!(default.plugin_id.as_deref(), Some("ready-a"));
        assert_eq!(default.version.as_deref(), Some("1.0.0"));
        assert_eq!(
            default.manifest_selection.manifest_selection,
            Some(ManifestSelection::Root)
        );
        assert_eq!(
            default
                .manifest_selection
                .manifest_identity
                .as_ref()
                .unwrap()
                .id,
            "ready-a"
        );
        let default_json = serde_json::to_value(&default).unwrap();
        assert_eq!(
            default_json["manifestCandidates"].as_array().unwrap().len(),
            2
        );
        assert_eq!(
            default_json["manifestDifferences"],
            json!(["id", "version", "main"])
        );

        write_manifest(
            root.path(),
            "public/plugin.json",
            &json!({
                "name":"ready-a", "version":"1.0.0", "main":"index.html"
            }),
        );
        let explicit = crate::source_build::inspect_source_build_with_manifest_selection(
            root.path(),
            Some(ManifestSelection::Public),
        )
        .unwrap();
        assert_eq!(explicit.status, SourceBuildStatus::AlreadyReady);
        assert_eq!(explicit.plugin_id.as_deref(), Some("ready-a"));
        assert_eq!(explicit.version.as_deref(), Some("1.0.0"));
        assert_eq!(
            explicit.manifest_selection.manifest_selection,
            Some(ManifestSelection::Public)
        );
        assert_eq!(
            explicit
                .manifest_selection
                .manifest_identity
                .as_ref()
                .unwrap()
                .id,
            "ready-a"
        );
    }

    #[test]
    fn explicit_public_different_from_ready_root_does_not_fall_back_to_ready_root() {
        let root = ready_root();
        write_manifest(
            root.path(),
            "public/plugin.json",
            &json!({
                "name":"public-b", "version":"2.0.0", "main":"public.html"
            }),
        );

        let explicit = crate::source_build::inspect_source_build_with_manifest_selection(
            root.path(),
            Some(ManifestSelection::Public),
        )
        .unwrap();
        assert_eq!(explicit.status, SourceBuildStatus::Blocked);
        assert_eq!(explicit.plugin_id.as_deref(), Some("public-b"));
        assert_eq!(explicit.version.as_deref(), Some("2.0.0"));
        assert_eq!(
            explicit.manifest_selection.manifest_selection,
            Some(ManifestSelection::Public)
        );
        assert_eq!(
            explicit
                .manifest_selection
                .manifest_identity
                .as_ref()
                .unwrap()
                .id,
            "public-b"
        );
        assert!(!explicit.blockers.is_empty());
    }

    #[test]
    fn explicit_invalid_public_does_not_borrow_ready_root_identity() {
        let root = ready_root();
        std::fs::create_dir_all(root.path().join("public")).unwrap();
        std::fs::write(root.path().join("public/plugin.json"), b"not-json").unwrap();

        let explicit = crate::source_build::inspect_source_build_with_manifest_selection(
            root.path(),
            Some(ManifestSelection::Public),
        )
        .unwrap();
        assert_eq!(explicit.status, SourceBuildStatus::Blocked);
        assert_eq!(explicit.plugin_id, None);
        assert_eq!(explicit.version, None);
        assert_eq!(
            explicit.manifest_selection.manifest_selection,
            Some(ManifestSelection::Public)
        );
        assert_eq!(explicit.manifest_selection.manifest_identity, None);
    }

    #[test]
    fn default_metadata_is_cleared_if_ready_identity_differs_from_scan_selection() {
        let root = ready_root();
        let selected_manifest = json!({"name":"public-b", "version":"2.0.0", "main":"index.html"});
        write_manifest(root.path(), "plugin.json", &selected_manifest);
        let scan = manifest_selection::scan(root.path(), None);
        let resolved: PluginManifest = serde_json::from_value(json!({
            "name":"ready-a", "version":"1.0.0", "main":"index.html"
        }))
        .unwrap();
        let mut info = scan.info;
        let result = inspect_ready_package(
            root.path(),
            &resolved,
            None,
            scan.selected.as_ref(),
            &mut info,
        )
        .unwrap();
        assert_eq!(result.status, SourceBuildStatus::AlreadyReady);
        assert_eq!(result.plugin_id.as_deref(), Some("ready-a"));
        assert_eq!(result.version.as_deref(), Some("1.0.0"));
        assert_eq!(result.manifest_selection.manifest_selection, None);
        assert_eq!(result.manifest_selection.manifest_sha256, None);
        assert_eq!(result.manifest_selection.manifest_identity, None);
        let serialized = serde_json::to_value(result).unwrap();
        assert_eq!(
            serialized["manifestCandidates"].as_array().unwrap().len(),
            2
        );
    }
}
