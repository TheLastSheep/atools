//! Converted handoff source preparation and path-free import commands for the published host.
use super::converted_handoff_verification::{verify as verify_converted_handoff, VerifiedHandoff};
use super::fixture_profile::{reviewed_converted_profile, reviewed_profile};
use super::package_verification::{self, read_bounded_regular};
use super::path_evidence;
use super::{AppState, PublishedFixture};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

pub(super) struct PreparedSource {
    pub plugin_root: PathBuf,
    pub package_import_path: PathBuf,
    pub profile: Value,
    pub downloads: Option<PathBuf>,
    pub source_verification: Value,
    pub converted_handoff: Option<VerifiedHandoff>,
    pub deepread_text_encoding: super::deepread_fixture::TextEncoding,
}

#[derive(Clone, Debug)]
pub(super) struct ConvertedImportProof {
    pub manifest_sha256: String,
    pub source_tree_sha256: String,
    pub source_tree_entries: u64,
    pub source_tree_files: u64,
    pub source_tree_bytes: u64,
}

pub(super) fn prepare_source(
    args: &[String],
    case_id: &str,
    host_root: &std::path::Path,
) -> Result<PreparedSource, String> {
    let converted_args = super::converted_handoff_arguments::validate(args)?;
    let deepread_text_encoding = converted_args
        .as_ref()
        .map(|value| value.deepread_text_encoding)
        .unwrap_or_default();
    let converted_handoff = if let Some(converted_args) = converted_args {
        if case_id != converted_args.case_id {
            return Err("Converted case identity changed before source preparation".into());
        }
        let manifest = PathBuf::from(converted_args.manifest_path);
        if !manifest.is_absolute() {
            return Err("Converted handoff manifest path must be absolute".into());
        }
        let handoff = verify_converted_handoff(
            &manifest,
            &converted_args.expected_sha256,
            &converted_args.case_id,
        )?;
        if host_root.starts_with(&handoff.fixture_root)
            || handoff.fixture_root.starts_with(host_root)
        {
            return Err("Host fixture root must be separate from the retained handoff root".into());
        }
        Some(handoff)
    } else {
        if matches!(
            case_id,
            "converted-my-calculator-source"
                | "converted-tetris-source"
                | "converted-todo-neo-source"
                | "converted-deepread-source"
        ) {
            return Err("Converted source case requires its fixed handoff inputs".into());
        }
        None
    };
    let plugin_root = if let Some(handoff) = &converted_handoff {
        handoff.installed_package_path.clone()
    } else {
        super::arg_path(args, "--plugin-root")?
    };
    let manifest_path = plugin_root.join("plugin.json");
    let manifest_bytes = if converted_handoff.is_some() {
        crate::read_converted_package_manifest(&plugin_root)?
    } else {
        read_bounded_regular(&manifest_path, package_verification::MAX_MANIFEST_BYTES)?
    };
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|_| "Invalid reviewed plugin manifest")?;
    let profile = if let Some(handoff) = &converted_handoff {
        reviewed_converted_profile(
            &manifest,
            &handoff.installed_package_tree_sha256,
            &handoff.case_id,
        )?
    } else {
        reviewed_profile(case_id, &manifest)?
    };
    let downloads = path_evidence::prepare(&profile, deepread_text_encoding)?;
    let (package_import_path, source_verification) = if let Some(handoff) = &converted_handoff {
        (
            plugin_root.clone(),
            json!({"sourceKind":"converted_handoff_directory",
            "handoffManifestSha256":handoff.manifest_sha256,"sourceRevision":handoff.source_revision,
            "sourceManifestSha256":handoff.source_manifest_sha256,"conversionSourceProvenanceUnchanged":true,
            "installedPackageTreeSha256":handoff.installed_package_tree_sha256,
            "convertedPackageTreeVerifiedBeforeExecution":true}),
        )
    } else {
        let review: Value = serde_json::from_slice(&read_bounded_regular(
            &super::arg_path(args, "--source-review")?,
            package_verification::MAX_REVIEW_BYTES,
        )?)
        .map_err(|e| e.to_string())?;
        let package_import_path = if profile["sourceKind"] == "local_original_archive" {
            let path = super::arg_path(args, "--package-import-path")?;
            if review["fixture"]["packageImportPath"].as_str() != path.to_str()
                || path == plugin_root
            {
                return Err(
                    "Native archive import argument must match the retained original ZPX source"
                        .into(),
                );
            }
            path
        } else {
            plugin_root.clone()
        };
        let verifier = if profile["sourceKind"] == "local_original_archive" {
            crate::legacy_runtime::local_archive_verification::verify_reviewed_archive
        } else if profile["sourceKind"] == "local_full_directory" {
            crate::legacy_runtime::local_package_verification::verify_reviewed_local_package
        } else {
            package_verification::verify_reviewed_package
        };
        let result = verifier(
            &review,
            &profile,
            &plugin_root,
            super::arg_value(args, "--expected-sha256")?,
        )?;
        (package_import_path, result)
    };
    Ok(PreparedSource {
        plugin_root,
        package_import_path,
        profile,
        downloads,
        source_verification,
        converted_handoff,
        deepread_text_encoding,
    })
}

#[tauri::command]
pub(super) async fn native_published_import_converted_handoff(
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let fixture = app.state::<PublishedFixture>();
    let handoff = fixture
        .converted_handoff
        .as_ref()
        .ok_or("Converted handoff import is unavailable for this fixture")?;
    let source = handoff.installed_package_path.clone();
    let source_before = verify_source_tree(handoff, &source)?;
    let state = app.state::<AppState>();
    let install_root = state.config.plugins_dir();
    let report = crate::plugin_mutations::import(
        &app,
        state.db.clone(),
        install_root.clone(),
        vec![source.to_string_lossy().into_owned()],
        false,
    )
    .await?;
    let source_after = verify_source_tree(handoff, &source)?;
    if source_before.sha256 != source_after.sha256
        || source_before.entries != source_after.entries
        || source_before.files != source_after.files
        || source_before.bytes != source_after.bytes
    {
        return Err("Converted handoff package changed during production import".into());
    }
    if report.imported.len() != 1
        || report.imported[0] != handoff.plugin_id
        || !report.skipped.is_empty()
        || !report.failed.is_empty()
    {
        return Err("Converted handoff package was not imported exactly once".into());
    }
    let plugin = state
        .db
        .get_plugin(&handoff.plugin_id)
        .map_err(|_| "Imported converted plugin identity unavailable")?;
    let expected = install_root.join(&handoff.plugin_id);
    if std::fs::canonicalize(&plugin.path)
        .map_err(|_| "Imported converted plugin path unavailable")?
        != std::fs::canonicalize(&expected)
            .map_err(|_| "Imported converted plugin directory unavailable")?
        || plugin.version != handoff.plugin_version
    {
        return Err("Imported converted plugin database identity differs from the handoff".into());
    }
    let tree = crate::calculate_converted_package_tree(&expected)?;
    if !tree_matches(handoff, &tree) {
        return Err("Imported plugin tree differs from the verified handoff".into());
    }
    *fixture.converted_import_proof.lock() = Some(ConvertedImportProof {
        manifest_sha256: handoff.manifest_sha256.clone(),
        source_tree_sha256: source_after.sha256,
        source_tree_entries: source_after.entries,
        source_tree_files: source_after.files,
        source_tree_bytes: source_after.bytes,
    });
    Ok(
        json!({"status":"imported","pluginId":handoff.plugin_id.clone(),"version":handoff.plugin_version.clone(),
        "packageSha256":tree.sha256,"treeEntries":tree.entries,"treeFiles":tree.files,"treeBytes":tree.bytes,
        "conversionSourceProvenanceUnchanged":true,"importSourceTreeUnchanged":true,
        "installedTargetMatchesHandoff":true,"businessUsabilityVerified":false}),
    )
}

#[tauri::command]
pub(super) fn native_published_installed_package(app: tauri::AppHandle) -> Result<Value, String> {
    let fixture = app.state::<PublishedFixture>();
    let state = app.state::<AppState>();
    let id = fixture.profile["id"]
        .as_str()
        .ok_or("Missing fixture plugin identity")?;
    let plugin = state.db.get_plugin(id).map_err(|error| error.to_string())?;
    let expected = std::fs::canonicalize(state.config.plugins_dir())
        .map_err(|error| error.to_string())?
        .join(id);
    if std::fs::canonicalize(&plugin.path).map_err(|error| error.to_string())? != expected
        || plugin.version
            != fixture.profile["version"]
                .as_str()
                .ok_or("Missing fixture version")?
    {
        return Err(
            "Installed fixture database identity differs from the exact expected package".into(),
        );
    }
    if let Some(handoff) = &fixture.converted_handoff {
        let proof = fixture
            .converted_import_proof
            .lock()
            .clone()
            .ok_or("Converted source has no successful production-import proof")?;
        if proof.manifest_sha256 != handoff.manifest_sha256 {
            return Err("Converted import proof belongs to another handoff".into());
        }
        let source = verify_source_tree(handoff, &handoff.installed_package_path)?;
        if source.sha256 != proof.source_tree_sha256
            || source.entries != proof.source_tree_entries
            || source.files != proof.source_tree_files
            || source.bytes != proof.source_tree_bytes
        {
            return Err(
                "Converted import source no longer matches its pre/post import proof".into(),
            );
        }
        let tree = crate::calculate_converted_package_tree(&expected)?;
        if !tree_matches(handoff, &tree) {
            return Err(
                "Converted installed package differs from its verified handoff tree".into(),
            );
        }
        return Ok(
            json!({"status":"verified","pluginId":handoff.plugin_id.clone(),"version":handoff.plugin_version.clone(),
            "packageSha256":tree.sha256,"treeEntries":tree.entries,"treeFiles":tree.files,"treeBytes":tree.bytes,
            "conversionSourceProvenanceUnchanged":true,"importSourceTreeUnchanged":true,
            "installedTargetMatchesHandoff":true,"businessUsabilityVerified":false}),
        );
    }
    crate::legacy_runtime::local_archive_verification::verify_installed(&expected, &fixture.profile)
}

fn verify_source_tree(
    handoff: &VerifiedHandoff,
    source: &std::path::Path,
) -> Result<crate::ConvertedPackageTree, String> {
    let tree = crate::calculate_converted_package_tree(source)?;
    if tree_matches(handoff, &tree) {
        Ok(tree)
    } else {
        Err("Converted handoff source package changed before import".into())
    }
}

fn tree_matches(handoff: &VerifiedHandoff, tree: &crate::ConvertedPackageTree) -> bool {
    tree.sha256 == handoff.installed_package_tree_sha256
        && tree.entries == handoff.tree_entries
        && tree.files == handoff.tree_files
        && tree.bytes == handoff.tree_bytes
}
