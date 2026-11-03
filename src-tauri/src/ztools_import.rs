use std::fs;
use std::path::{Path, PathBuf};

use atools_core::models::{Cmd, CmdType, PluginManifest};
use atools_core::Plugin;
use serde::{Deserialize, Serialize};
mod archive;
mod archive_readiness;
mod batch_plan;
mod directory;
mod discovery;
mod inspection;
#[cfg(test)]
mod lifecycle_import;
mod zip;
use archive::{
    archive_source_type, asar_entry, is_supported_archive, packed_entry_data, parse_asar,
    read_archive, read_archive_bytes, stage_plugin_archive, ParsedAsar,
};
pub(crate) use batch_plan::{plan_import_batch, PreparedImport};
#[cfg(test)]
mod archive_io_tests;
#[cfg(test)]
mod batch_tests;
#[cfg(all(test, feature = "local-original-archive-fixtures"))]
mod original_archive_tests;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportCandidate {
    pub path: String,
    pub source_type: String,
    #[serde(default)]
    pub package_path: Option<String>,
    #[serde(default)]
    pub entry_readiness: Option<String>,
    #[serde(default)]
    pub headless: bool,
    #[serde(default)]
    pub installation_id: Option<String>,
    /// Opaque, conservative directory-conflict key; never replaces the database ID.
    #[serde(default)]
    pub installation_key: Option<String>,
    pub name: String,
    pub title: Option<String>,
    pub version: String,
    pub features_count: usize,
    pub platform_supported: bool,
    pub main_exists: bool,
    pub preload_exists: bool,
    pub logo_exists: bool,
    pub unsupported_cmd_types: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: usize = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_ARCHIVE_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportReport {
    pub imported: Vec<String>,
    pub skipped: Vec<ZToolsImportCandidate>,
    pub failed: Vec<ZToolsImportFailure>,
}

pub fn scan_ztools_plugin_candidates(root: &Path) -> Result<Vec<ZToolsImportCandidate>, String> {
    let sources = discovery::discover(&[root.to_path_buf()])?;
    inspect_sources(sources)
}

fn inspect_sources(sources: Vec<PathBuf>) -> Result<Vec<ZToolsImportCandidate>, String> {
    let mut candidates = Vec::new();
    for source in sources {
        candidates.push(
            candidate_from_source(&source)
                .unwrap_or_else(|error| failed_candidate_from_source(&source, error)),
        );
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    Ok(candidates)
}

fn failed_candidate_from_source(source: &Path, error: String) -> ZToolsImportCandidate {
    ZToolsImportCandidate {
        path: source.to_string_lossy().to_string(),
        source_type: if source.is_dir() {
            "directory"
        } else {
            archive_source_type(source)
        }
        .to_string(),
        package_path: None,
        entry_readiness: None,
        headless: false,
        installation_id: None,
        installation_key: None,
        name: source
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("invalid-plugin")
            .to_string(),
        title: None,
        version: String::new(),
        features_count: 0,
        platform_supported: true,
        main_exists: false,
        preload_exists: false,
        logo_exists: false,
        unsupported_cmd_types: Vec::new(),
        warnings: Vec::new(),
        errors: vec![error],
    }
}

pub fn scan_default_ztools_plugin_candidates() -> Result<Vec<ZToolsImportCandidate>, String> {
    let roots: Vec<_> = default_ztools_plugin_roots()
        .into_iter()
        .filter(|root| {
            fs::symlink_metadata(root)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.is_symlink())
        })
        .collect();
    inspect_sources(discovery::discover(&roots)?)
}

pub fn default_ztools_plugin_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut roots = vec![home.join(".ztools").join("plugins")];
    #[cfg(target_os = "macos")]
    roots.push(
        home.join("Library")
            .join("Application Support")
            .join("ZTools")
            .join("plugins"),
    );
    #[cfg(target_os = "windows")]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(app_data).join("ZTools").join("plugins"));
    }
    #[cfg(target_os = "linux")]
    roots.push(home.join(".config").join("ZTools").join("plugins"));
    roots
}

pub fn import_ztools_plugins(
    db: &atools_core::Database,
    install_root: &Path,
    paths: &[String],
    overwrite: bool,
) -> Result<ZToolsImportReport, String> {
    let plan = plan_import_batch(paths)?;
    let mut report = plan.report;
    for prepared in plan.ready {
        let path = prepared.path();
        let mut part =
            execute_prepared(db, install_root, prepared, overwrite).unwrap_or_else(|error| {
                ZToolsImportReport {
                    imported: Vec::new(),
                    skipped: Vec::new(),
                    failed: vec![ZToolsImportFailure { path, error }],
                }
            });
        report.imported.append(&mut part.imported);
        report.skipped.append(&mut part.skipped);
        report.failed.append(&mut part.failed);
    }
    Ok(report)
}

pub(crate) fn execute_prepared(
    db: &atools_core::Database,
    root: &Path,
    prepared: PreparedImport,
    overwrite: bool,
) -> Result<ZToolsImportReport, String> {
    let mut report = ZToolsImportReport {
        imported: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };
    match install_prepared(db, root, prepared, overwrite) {
        Ok(id) => report.imported.push(id),
        Err(ImportSkip::Skip(candidate)) => report.skipped.push(candidate),
        Err(ImportSkip::Fail(error)) => return Err(error),
    }
    Ok(report)
}

enum ImportSkip {
    Skip(ZToolsImportCandidate),
    Fail(String),
}

#[allow(clippy::result_large_err)] // Skip returns the full candidate for the import report.
fn install_prepared(
    db: &atools_core::Database,
    install_root: &Path,
    prepared: PreparedImport,
    overwrite: bool,
) -> Result<String, ImportSkip> {
    let PreparedImport {
        source,
        inspected,
        id: plugin_id,
    } = prepared;
    let inspection::SourceInspection {
        mut candidate,
        manifest,
        raw_manifest,
    } = inspected;
    if !candidate.errors.is_empty() {
        return Err(ImportSkip::Skip(candidate));
    }
    let metadata =
        fs::symlink_metadata(&source).map_err(|error| ImportSkip::Fail(error.to_string()))?;
    if metadata.is_symlink() {
        return Err(ImportSkip::Fail(
            "插件来源变成符号链接，请重新选择实际路径".into(),
        ));
    }
    let install_dir = install_root.join(&plugin_id);

    if fs::symlink_metadata(&install_dir).is_ok() && !overwrite {
        candidate
            .warnings
            .push("Plugin already installed; overwrite disabled".to_string());
        return Err(ImportSkip::Skip(candidate));
    }

    let staged = if metadata.is_dir() {
        let package = crate::plugin_packages::local_package(&source).map_err(ImportSkip::Fail)?;
        if package.raw_manifest != raw_manifest {
            return Err(ImportSkip::Fail(
                "插件源在导入时发生变化，请重新扫描".into(),
            ));
        }
        crate::plugin_packages::stage_directory(&package, &install_dir).map_err(ImportSkip::Fail)?
    } else {
        let path = stage_plugin_archive(&source, &install_dir).map_err(ImportSkip::Fail)?;
        crate::plugin_packages::validate_staged(path, &manifest, Some(&raw_manifest))
            .map_err(ImportSkip::Fail)?
    };
    if serde_json::to_value(&staged.manifest)
        .map_err(|error| ImportSkip::Fail(error.to_string()))?
        != serde_json::to_value(&manifest).map_err(|error| ImportSkip::Fail(error.to_string()))?
    {
        return Err(ImportSkip::Fail(
            "插件源在导入时发生变化，请重新扫描".into(),
        ));
    }
    let existing = db.get_plugin(&plugin_id).ok();
    if fs::symlink_metadata(&install_dir).is_ok() && !overwrite {
        candidate
            .warnings
            .push("Plugin already installed; overwrite disabled".into());
        return Err(ImportSkip::Skip(candidate));
    }
    let now = atools_core::utils::now_iso();
    let plugin = Plugin {
        id: plugin_id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: install_dir.to_string_lossy().to_string(),
        enabled: existing.as_ref().is_none_or(|plugin| plugin.enabled),
        manifest: manifest.clone(),
        created_at: existing
            .as_ref()
            .map(|plugin| plugin.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };

    crate::commands::replace_plugin_directory_transactionally(&staged.path, &install_dir, || {
        db.save_plugin_with_features(&plugin, &manifest.features)
            .map_err(|error| error.to_string())
    })
    .map_err(ImportSkip::Fail)?;

    Ok(plugin_id)
}

fn candidate_from_source(source: &Path) -> Result<ZToolsImportCandidate, String> {
    inspection::inspect(source).map(|inspected| inspected.candidate)
}

fn unsupported_cmd_types(manifest: &PluginManifest) -> Vec<String> {
    for feature in &manifest.features {
        for cmd in &feature.cmds {
            if let Cmd::Typed(typed) = cmd {
                match typed.type_ {
                    CmdType::Regex
                    | CmdType::Over
                    | CmdType::Img
                    | CmdType::Files
                    | CmdType::Window => {}
                }
            }
        }
    }

    Vec::new()
}

#[cfg(test)]
#[path = "ztools_import/archive_tests.rs"]
mod tests;
