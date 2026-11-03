//! Read-only selection of one coherent, bounded plugin package.
//!
//! A selected manifest owns its complete package root. Missing assets never fall
//! back individually to a source repository, public directory or another build.

pub mod html;
mod js_tokens;
mod manifest_paths;
pub mod page_requirements;
mod paths;
mod readiness;
pub mod runtime_dependencies;

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use atools_core::models::PluginManifest;
use serde::Serialize;

pub const MANIFEST_CANDIDATES: &[&str] = &[
    "plugin.json",
    "dist/plugin.json",
    "dist/ztools/plugin.json",
    "public/plugin.json",
    "src/plugin.json",
    "app/plugin.json",
    "plugin/plugin.json",
];
const SOURCE_MANIFEST_CANDIDATES: &[&str] = &[
    "public/plugin.json",
    "src/plugin.json",
    "app/plugin.json",
    "plugin/plugin.json",
];
const PUBLISHED_MANIFEST_CANDIDATES: &[&str] = &["dist/plugin.json", "dist/ztools/plugin.json"];
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PRELOAD_BYTES: usize = 2 * 1024 * 1024;

/// Read one normalized relative resource using the same no-follow component guard
/// as package inspection. The caller owns authorization, root selection and cap.
pub fn read_package_asset_bytes(
    root: &Path,
    relative: &Path,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>> {
    paths::read_bytes(root, relative, max_bytes)
}

/// Normalizes a manifest-declared package asset path without permitting traversal.
/// Leading `./` segments are accepted and removed, matching package resolution.
pub fn normalize_package_asset_path(value: &str) -> Result<PathBuf> {
    paths::normalized_relative(Path::new(""), value, false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageReadiness {
    Ready,
    RequiresBuild,
    Incomplete,
    Remote,
}

impl PackageReadiness {
    pub fn is_local_ready(self) -> bool {
        self == Self::Ready
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::RequiresBuild => "requires_build",
            Self::Incomplete => "incomplete",
            Self::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PackageDiagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedPluginPackage {
    pub source_root: PathBuf,
    pub manifest_path: PathBuf,
    pub package_root: PathBuf,
    pub manifest: PluginManifest,
    pub raw_manifest: serde_json::Value,
    pub readiness: PackageReadiness,
    pub diagnostics: Vec<PackageDiagnostic>,
}

/// Fixed, nonrecursive presence check for directory scanners. A symlink counts as
/// a candidate here so callers stop descending; resolution subsequently rejects it.
pub fn has_manifest_candidate(root: &Path) -> bool {
    MANIFEST_CANDIDATES
        .iter()
        .any(|candidate| std::fs::symlink_metadata(root.join(candidate)).is_ok())
}

/// ZTools joins a Web main beginning with '/' onto the plugin directory. Preserve
/// that package-relative convention, while keeping raw metadata unchanged and
/// refusing traversal, Windows paths and native runtime absolute entries.
pub fn normalize_web_main_entry(manifest: &mut PluginManifest) -> Result<()> {
    if manifest.effective_runtime_kind() != atools_core::models::PluginRuntimeKind::Web {
        return Ok(());
    }
    let Some(main) = manifest.main.as_mut() else {
        return Ok(());
    };
    if main.trim().is_empty() || html::is_remote_entry(main) {
        return Ok(());
    }
    let relative =
        paths::normalized_relative(Path::new(""), main.strip_prefix('/').unwrap_or(main), false)?;
    *main = relative.to_string_lossy().into_owned();
    Ok(())
}

/// Normalizes the path fields for one selected manifest candidate without
/// changing the raw manifest or the caller's package/build root.
pub(crate) fn normalize_candidate_manifest_paths(
    source_root: &Path,
    candidate: &Path,
    manifest: &mut PluginManifest,
) -> Result<PathBuf> {
    manifest_paths::normalize_candidate(source_root, candidate, manifest)
}

fn read_candidate(source_root: &Path, candidate: &str) -> Result<Option<ResolvedPluginPackage>> {
    let relative = paths::normalized_relative(Path::new(""), candidate, false)?;
    let Some(content) = paths::read_text(source_root, &relative, MAX_MANIFEST_BYTES)? else {
        return Ok(None);
    };
    let manifest_path = source_root.join(&relative);
    let raw_manifest: serde_json::Value = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse manifest at {manifest_path:?}"))?;
    let mut manifest: PluginManifest = serde_json::from_value(raw_manifest.clone())
        .with_context(|| format!("Failed to parse manifest at {manifest_path:?}"))?;
    if manifest.name.trim().is_empty() {
        bail!("Plugin manifest name cannot be empty: {manifest_path:?}");
    }
    let package_root = normalize_candidate_manifest_paths(source_root, &relative, &mut manifest)
        .with_context(|| format!("Invalid package references at {manifest_path:?}"))?;
    manifest
        .validate_runtime_contract()
        .map_err(anyhow::Error::msg)
        .with_context(|| format!("Invalid runtime contract at {manifest_path:?}"))?;
    let (readiness, diagnostics) = readiness::inspect_package(&package_root, &manifest)
        .with_context(|| format!("Invalid package at {manifest_path:?}"))?;
    Ok(Some(ResolvedPluginPackage {
        source_root: source_root.to_path_buf(),
        manifest_path,
        package_root,
        manifest,
        raw_manifest,
        readiness,
        diagnostics,
    }))
}

fn same_identity(source: &ResolvedPluginPackage, published: &ResolvedPluginPackage) -> Result<()> {
    if source.manifest.name != published.manifest.name
        || source.manifest.version != published.manifest.version
    {
        bail!(
            "Published package identity/version mismatch: source {:?}@{:?}, dist {:?}@{:?}",
            source.manifest.name,
            source.manifest.version,
            published.manifest.name,
            published.manifest.version
        );
    }
    Ok(())
}

fn note_selected_published(
    mut published: ResolvedPluginPackage,
    displaced: Option<&ResolvedPluginPackage>,
) -> ResolvedPluginPackage {
    if let Some(displaced) = displaced {
        published.diagnostics.push(PackageDiagnostic {
            code: "selected_published_package".into(),
            message: format!(
                "Selected complete same-version published package instead of {} ({})",
                displaced.manifest_path.display(),
                displaced.readiness.as_str()
            ),
        });
    }
    published
}

/// Select a coherent package without building, executing, recursively scanning or networking.
pub fn resolve_plugin_package(source_root: &Path) -> Result<ResolvedPluginPackage> {
    let source_root = paths::canonical_root(source_root)?;
    let root = read_candidate(&source_root, MANIFEST_CANDIDATES[0])?;
    if root.as_ref().is_some_and(|package| {
        matches!(
            package.readiness,
            PackageReadiness::Ready | PackageReadiness::Remote
        )
    }) {
        return Ok(root.unwrap());
    }
    let mut source = root;
    if source.is_none() {
        for candidate in SOURCE_MANIFEST_CANDIDATES {
            if let Some(package) = read_candidate(&source_root, candidate)? {
                source = Some(package);
                break;
            }
        }
    }
    let mut first_published: Option<ResolvedPluginPackage> = None;
    for candidate in PUBLISHED_MANIFEST_CANDIDATES {
        let Some(published) = read_candidate(&source_root, candidate)? else {
            continue;
        };
        if let Some(source) = source.as_ref() {
            same_identity(source, &published)?;
        }
        if let Some(first) = first_published.as_ref() {
            // This is reached only after a non-ready primary led to a nested
            // fallback check; a ready primary returns before nested is read.
            // Without a source anchor, reject identity conflicts between these
            // published candidates actually considered for fallback.
            same_identity(first, &published)?;
        }
        if published.readiness.is_local_ready() {
            let displaced = first_published.as_ref().or(source.as_ref());
            return Ok(note_selected_published(published, displaced));
        }
        if first_published.is_none() {
            first_published = Some(published);
        }
    }
    match (source, first_published) {
        (Some(mut source), Some(published)) => {
            source.diagnostics.push(PackageDiagnostic {
                code: "incomplete_published_package".into(),
                message: format!(
                    "Published package cannot replace source: {} is {}",
                    published.manifest_path.display(),
                    published.readiness.as_str()
                ),
            });
            source.diagnostics.extend(published.diagnostics);
            Ok(source)
        }
        (Some(source), None) => Ok(source),
        (None, Some(published)) => Ok(published),
        (None, None) => {
            bail!("No plugin.json manifest in fixed plugin package candidates at {source_root:?}")
        }
    }
}

/// Read one preload relative to the selected package. Standalone callers without a
/// manifest retain the historical utility behavior, with the same confined budget.
pub fn read_package_preload(source_root: &Path, preload: &str) -> Result<String> {
    let source_root = paths::canonical_root(source_root)?;
    let package_root = if has_manifest_candidate(&source_root) {
        resolve_plugin_package(&source_root)?.package_root
    } else {
        source_root
    };
    let relative = paths::normalized_relative(Path::new(""), preload, false)?;
    paths::read_text(&package_root, &relative, MAX_PRELOAD_BYTES)?.with_context(|| {
        format!(
            "Failed to read preload script at {:?}",
            package_root.join(relative)
        )
    })
}
