use std::fs;
use std::path::{Path, PathBuf};

use atools_core::models::{Cmd, CmdType, PluginManifest};
use atools_core::Plugin;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportCandidate {
    pub path: String,
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
    let mut manifests = Vec::new();
    collect_plugin_manifests(root, &mut manifests)?;

    let mut candidates = Vec::new();
    for manifest_path in manifests {
        candidates.push(candidate_from_manifest(&manifest_path)?);
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    Ok(candidates)
}

pub fn import_ztools_plugins(
    db: &atools_core::Database,
    install_root: &Path,
    paths: &[String],
    overwrite: bool,
) -> Result<ZToolsImportReport, String> {
    let _mutation_guard = crate::commands::acquire_plugin_mutation_lock()?;
    fs::create_dir_all(install_root).map_err(|e| e.to_string())?;

    let mut report = ZToolsImportReport {
        imported: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };

    for path in paths {
        let source = PathBuf::from(path);
        match import_one(db, install_root, &source, overwrite) {
            Ok(name) => report.imported.push(name),
            Err(ImportSkip::Skip(candidate)) => report.skipped.push(candidate),
            Err(ImportSkip::Fail(error)) => report.failed.push(ZToolsImportFailure {
                path: path.clone(),
                error,
            }),
        }
    }

    Ok(report)
}

enum ImportSkip {
    Skip(ZToolsImportCandidate),
    Fail(String),
}

#[allow(clippy::result_large_err)] // Skip returns the full candidate for the import report.
fn import_one(
    db: &atools_core::Database,
    install_root: &Path,
    source: &Path,
    overwrite: bool,
) -> Result<String, ImportSkip> {
    let manifest_path = source.join("plugin.json");
    let mut candidate = candidate_from_manifest(&manifest_path).map_err(ImportSkip::Fail)?;
    if !candidate.errors.is_empty() {
        return Err(ImportSkip::Skip(candidate));
    }

    let manifest_content =
        fs::read_to_string(&manifest_path).map_err(|e| ImportSkip::Fail(e.to_string()))?;
    let manifest: PluginManifest =
        serde_json::from_str(&manifest_content).map_err(|e| ImportSkip::Fail(e.to_string()))?;
    let plugin_id = atools_core::utils::sanitize_id(&manifest.name);
    let install_dir = install_root.join(&plugin_id);

    let existing = db.get_plugin(&plugin_id).ok();
    if fs::symlink_metadata(&install_dir).is_ok() && !overwrite {
        candidate
            .warnings
            .push("Plugin already installed; overwrite disabled".to_string());
        return Err(ImportSkip::Skip(candidate));
    }

    let staged_dir =
        crate::commands::stage_plugin_directory(source, &install_dir).map_err(ImportSkip::Fail)?;

    let now = atools_core::utils::now_iso();
    let plugin = Plugin {
        id: plugin_id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: install_dir.to_string_lossy().to_string(),
        enabled: true,
        manifest: manifest.clone(),
        created_at: existing
            .as_ref()
            .map(|plugin| plugin.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };

    crate::commands::replace_plugin_directory_transactionally(&staged_dir, &install_dir, || {
        db.save_plugin_with_features(&plugin, &manifest.features)
            .map_err(|error| error.to_string())
    })
    .map_err(ImportSkip::Fail)?;

    Ok(plugin_id)
}

fn collect_plugin_manifests(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if root.file_name().and_then(|name| name.to_str()) == Some("node_modules") {
        return Ok(());
    }

    if root.join("plugin.json").is_file() {
        out.push(root.join("plugin.json"));
        return Ok(());
    }

    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false)
        {
            let _ = collect_plugin_manifests(&entry.path(), out);
        }
    }

    Ok(())
}

fn candidate_from_manifest(manifest_path: &Path) -> Result<ZToolsImportCandidate, String> {
    let plugin_dir = manifest_path
        .parent()
        .ok_or_else(|| "Invalid plugin path".to_string())?;
    let text = fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let manifest: PluginManifest =
        serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;

    let title = raw
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let platform_supported = raw
        .get("platform")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|item| item == "darwin" || item == "macos")
        })
        .unwrap_or(true);
    let main_exists = manifest
        .main
        .as_ref()
        .map(|main| plugin_dir.join(main).is_file())
        .unwrap_or(false);
    let preload_exists = manifest
        .preload
        .as_ref()
        .map(|preload| plugin_dir.join(preload).is_file())
        .unwrap_or(true);
    let logo_exists = manifest
        .logo
        .as_ref()
        .map(|logo| plugin_dir.join(logo).is_file())
        .unwrap_or(true);
    let unsupported_cmd_types = unsupported_cmd_types(&manifest);
    let mut warnings = Vec::new();
    let mut errors = Vec::new();

    if !platform_supported {
        warnings.push("Plugin platform does not include darwin".to_string());
    }
    if !main_exists {
        errors.push("Missing main file".to_string());
    }
    if !preload_exists {
        warnings.push("Missing preload file".to_string());
    }
    if !logo_exists {
        warnings.push("Missing logo file".to_string());
    }
    if !unsupported_cmd_types.is_empty() {
        warnings.push(format!(
            "Unsupported command types: {}",
            unsupported_cmd_types.join(", ")
        ));
    }

    Ok(ZToolsImportCandidate {
        path: plugin_dir.to_string_lossy().to_string(),
        name: manifest.name,
        title,
        version: manifest.version,
        features_count: manifest.features.len(),
        platform_supported,
        main_exists,
        preload_exists,
        logo_exists,
        unsupported_cmd_types,
        warnings,
        errors,
    })
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
