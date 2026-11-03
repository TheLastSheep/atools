//! Candidate-aware manifest path normalization.
//!
//! A public manifest may point its Web entry at its containing plugin root, while
//! ordinary manifest candidates keep their selected directory as their package.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use atools_core::models::{PluginManifest, PluginRuntimeKind};

use super::{html::is_remote_entry, paths};

const PUBLIC_MANIFEST: &str = "public/plugin.json";
const PUBLIC_ROOT: &str = "public";

pub(super) fn normalize_candidate(
    source_root: &Path,
    candidate: &Path,
    manifest: &mut PluginManifest,
) -> Result<PathBuf> {
    let package_root = source_root.join(candidate.parent().unwrap_or_else(|| Path::new("")));
    if candidate != Path::new(PUBLIC_MANIFEST)
        || manifest.effective_runtime_kind() != PluginRuntimeKind::Web
    {
        super::normalize_web_main_entry(manifest)?;
        return Ok(package_root);
    }

    normalize_public_candidate(source_root, manifest)
}

fn normalize_public_candidate(
    source_root: &Path,
    manifest: &mut PluginManifest,
) -> Result<PathBuf> {
    let main = manifest
        .main
        .as_deref()
        .filter(|value| !value.trim().is_empty() && !is_remote_entry(value))
        .map(normalize_public_main)
        .transpose()?;
    let runtime_entry = manifest
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.entry.as_deref())
        .filter(|value| !value.trim().is_empty() && !is_remote_entry(value))
        .map(normalize_public_relative)
        .transpose()?;
    let promote_root = main.as_ref().is_some_and(|path| outside_public(path))
        || runtime_entry
            .as_ref()
            .is_some_and(|path| outside_public(path));

    if !promote_root {
        if let (Some(value), Some(path)) = (manifest.main.as_mut(), main.as_ref()) {
            *value = strip_public(path)?.to_string_lossy().into_owned();
        }
        if let (Some(runtime), Some(path)) = (manifest.runtime.as_mut(), runtime_entry.as_ref()) {
            runtime.entry = Some(strip_public(path)?.to_string_lossy().into_owned());
        }
        return Ok(source_root.join(PUBLIC_ROOT));
    }

    if let (Some(value), Some(path)) = (manifest.main.as_mut(), main.as_ref()) {
        *value = path.to_string_lossy().into_owned();
    }
    if let (Some(runtime), Some(path)) = (manifest.runtime.as_mut(), runtime_entry.as_ref()) {
        runtime.entry = Some(path.to_string_lossy().into_owned());
    }
    remap_public_assets(source_root, manifest)?;
    Ok(source_root.to_path_buf())
}

fn normalize_public_main(value: &str) -> Result<PathBuf> {
    validate_reference(value)?;
    if value.starts_with("//") {
        bail!("Network-root plugin entry is not allowed");
    }
    if let Some(root_relative) = value.strip_prefix('/') {
        // Preserve the existing ZTools convention: one leading slash is relative
        // to the selected package root (public/ for this manifest candidate).
        return paths::normalized_relative(Path::new(PUBLIC_ROOT), root_relative, false);
    }
    paths::normalized_relative(Path::new(PUBLIC_ROOT), value, true)
}

fn normalize_public_relative(value: &str) -> Result<PathBuf> {
    validate_reference(value)?;
    if value.starts_with('/') {
        bail!("Absolute plugin reference is not allowed");
    }
    paths::normalized_relative(Path::new(PUBLIC_ROOT), value, true)
}

fn validate_reference(value: &str) -> Result<()> {
    if value.chars().any(char::is_control) {
        bail!("Control character in plugin reference");
    }
    Ok(())
}

fn outside_public(path: &Path) -> bool {
    !path.starts_with(PUBLIC_ROOT)
}

fn strip_public(path: &Path) -> Result<PathBuf> {
    let relative = path
        .strip_prefix(PUBLIC_ROOT)
        .map_err(|_| anyhow::anyhow!("Reference is outside public package"))?;
    if relative.as_os_str().is_empty() {
        bail!("Plugin reference must name an entry");
    }
    Ok(relative.to_path_buf())
}

fn is_external_asset(value: &str) -> bool {
    ["data:", "http://", "https://", "asset:"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
}

fn remap_public_assets(source_root: &Path, manifest: &mut PluginManifest) -> Result<()> {
    if let Some(logo) = manifest
        .logo
        .as_deref()
        .filter(|value| !value.trim().is_empty() && !is_external_asset(value))
    {
        manifest.logo = Some(
            normalize_public_relative(logo)?
                .to_string_lossy()
                .into_owned(),
        );
    }
    if let Some(preload) = manifest.preload.as_deref() {
        manifest.preload = Some(
            normalize_public_relative(preload)?
                .to_string_lossy()
                .into_owned(),
        );
    }
    for feature in &mut manifest.features {
        let Some(icon) = feature
            .icon
            .as_deref()
            .filter(|value| !value.trim().is_empty() && !is_external_asset(value))
        else {
            continue;
        };
        let relative = normalize_public_relative(icon)?;
        // Missing icons remain optional. A present symlink or unsafe component is
        // rejected by the same no-follow reader used for package assets.
        paths::asset_exists(source_root, &relative)?;
        feature.icon = Some(relative.to_string_lossy().into_owned());
    }
    Ok(())
}
