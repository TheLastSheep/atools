//! Source-derived allowlist for the one supported public-manifest output rewrite.
//!
//! The plan is computed from the selected source manifest before a build starts. It
//! never derives an authorized path from untrusted runner output.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use atools_core::models::PluginManifest;
use serde_json::Value;
use sha2::{Digest, Sha256};

const PUBLIC_MANIFEST: &str = "public/plugin.json";
const PUBLIC_DIR: &str = "public";
const PUBLIC_ASSET_BYTES_LIMIT: usize = 32 * 1024 * 1024;
const PUBLIC_ASSET_COUNT_LIMIT: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestOutputRewritePlan {
    pub paths: Vec<ManifestPathRewrite>,
    /// Source bytes and hashes are captured during planning, before the runner starts.
    pub public_assets: Vec<PublicAssetPin>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicAssetPin {
    pub source_path: PathBuf,
    pub output_path: PathBuf,
    /// Missing feature icons are explicitly represented by paired `None` metadata.
    pub source_byte_len: Option<u64>,
    pub source_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestPathRewrite {
    pub field: ManifestPathField,
    /// Verified source-root-relative path that produced this manifest value.
    pub source_path: PathBuf,
    /// Exact value from the selected source manifest.
    pub source_value: String,
    /// Exact value expected in the packaged output.
    pub output_value: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManifestPathField {
    Main,
    Logo,
    Preload,
    RuntimeEntry,
    FeatureIcon(usize),
}

impl ManifestPathField {
    pub fn summary_name(&self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Logo => "logo",
            Self::Preload => "preload",
            Self::RuntimeEntry => "runtime.entry",
            Self::FeatureIcon(_) => "features[].icon",
        }
    }
}

/// Builds the allowlist only for a public Web manifest promoted to the plugin
/// root by its parent-relative HTML main. Unsupported layouts return `None`.
pub fn plan_public_root_rewrite(
    source_root: &Path,
    manifest_relative: &Path,
    raw: &Value,
    normalized: &PluginManifest,
) -> Option<ManifestOutputRewritePlan> {
    if manifest_relative != Path::new(PUBLIC_MANIFEST)
        || normalized.effective_runtime_kind() != atools_core::PluginRuntimeKind::Web
    {
        return None;
    }
    let raw_main = raw.get("main")?.as_str()?;
    let normalized_main = normalized.main.as_deref()?;
    let main_path = safe_relative(normalized_main)?;
    if main_path.starts_with(PUBLIC_DIR) || !is_html(&main_path) {
        return None;
    }
    // Read through the package resolver's bounded, component-wise no-follow path.
    if atools_plugin_read(source_root, &main_path)?.is_empty() {
        return None;
    }
    let main_output = slash_path(&main_path)?;
    let mut paths = vec![ManifestPathRewrite {
        field: ManifestPathField::Main,
        source_path: main_path.clone(),
        source_value: raw_main.to_owned(),
        output_value: main_output.clone(),
    }];

    if let Some(runtime_entry) = normalized
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.entry.as_deref())
    {
        let runtime_path = safe_relative(runtime_entry)?;
        if runtime_path != main_path {
            return None;
        }
        let source_value = raw.pointer("/runtime/entry")?.as_str()?.to_owned();
        paths.push(ManifestPathRewrite {
            field: ManifestPathField::RuntimeEntry,
            source_path: main_path.clone(),
            source_value,
            output_value: main_output,
        });
    }

    if let Some(value) = normalized.logo.as_deref() {
        let source = raw.get("logo")?.as_str()?;
        if !is_external_asset(source) {
            paths.push(asset_rewrite(ManifestPathField::Logo, source, value)?);
        }
    }
    if let Some(value) = normalized.preload.as_deref() {
        let source = raw.get("preload")?.as_str()?;
        if !is_external_asset(source) {
            paths.push(asset_rewrite(ManifestPathField::Preload, source, value)?);
        }
    }
    let raw_features = raw
        .get("features")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw_features.len() != normalized.features.len() {
        return None;
    }
    for (index, feature) in normalized.features.iter().enumerate() {
        let Some(value) = feature.icon.as_deref() else {
            continue;
        };
        let source = raw_features.get(index)?.get("icon")?.as_str()?;
        if !is_external_asset(source) {
            paths.push(asset_rewrite(
                ManifestPathField::FeatureIcon(index),
                source,
                value,
            )?);
        }
    }
    let public_assets = pin_public_assets(source_root, &paths)?;
    Some(ManifestOutputRewritePlan {
        paths,
        public_assets,
    })
}

fn pin_public_assets(
    source_root: &Path,
    paths: &[ManifestPathRewrite],
) -> Option<Vec<PublicAssetPin>> {
    pin_public_assets_with_limits(
        source_root,
        paths,
        PUBLIC_ASSET_BYTES_LIMIT,
        PUBLIC_ASSET_COUNT_LIMIT,
    )
}

pub(super) fn pin_public_assets_with_limits(
    source_root: &Path,
    paths: &[ManifestPathRewrite],
    byte_limit: usize,
    asset_limit: usize,
) -> Option<Vec<PublicAssetPin>> {
    let mut assets = BTreeMap::<PathBuf, (PathBuf, bool)>::new();
    for path in paths {
        if matches!(
            path.field,
            ManifestPathField::Main | ManifestPathField::RuntimeEntry
        ) {
            continue;
        }
        let required = !matches!(path.field, ManifestPathField::FeatureIcon(_));
        match assets.get_mut(&path.source_path) {
            Some((output, is_required)) => {
                if output.as_path() != Path::new(&path.output_value) || path.output_value.is_empty()
                {
                    return None;
                }
                *is_required |= required;
            }
            None => {
                assets.insert(
                    path.source_path.clone(),
                    (PathBuf::from(&path.output_value), required),
                );
            }
        }
        if assets.len() > asset_limit {
            return None;
        }
    }

    let mut total_bytes = 0usize;
    assets
        .into_iter()
        .map(|(source_path, (output_path, required))| {
            let remaining = byte_limit.checked_sub(total_bytes)?;
            let bytes = crate::package_resolution::read_package_asset_bytes(
                source_root,
                &source_path,
                remaining,
            )
            .ok()?;
            if required && bytes.is_none() {
                return None;
            }
            let (source_byte_len, source_sha256) = if let Some(bytes) = bytes {
                total_bytes = total_bytes.checked_add(bytes.len())?;
                if total_bytes > byte_limit {
                    return None;
                }
                let byte_len = u64::try_from(bytes.len()).ok()?;
                let sha256 = format!("{:x}", Sha256::digest(&bytes));
                (Some(byte_len), Some(sha256))
            } else {
                (None, None)
            };
            Some(PublicAssetPin {
                source_path,
                output_path,
                source_byte_len,
                source_sha256,
            })
        })
        .collect()
}

fn asset_rewrite(
    field: ManifestPathField,
    source_value: &str,
    normalized_value: &str,
) -> Option<ManifestPathRewrite> {
    let path = safe_relative(normalized_value)?;
    let public_relative = path.strip_prefix(PUBLIC_DIR).ok()?;
    let output_value = slash_path(public_relative)?;
    Some(ManifestPathRewrite {
        field,
        source_path: path,
        source_value: source_value.to_owned(),
        output_value,
    })
}

fn atools_plugin_read(source_root: &Path, relative: &Path) -> Option<Vec<u8>> {
    crate::package_resolution::read_package_asset_bytes(
        source_root,
        relative,
        crate::package_resolution::MAX_HTML_BYTES,
    )
    .ok()?
}

fn safe_relative(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(path.to_path_buf())
}

fn slash_path(path: &Path) -> Option<String> {
    let parts = path
        .components()
        .map(|part| match part {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn is_html(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("html" | "htm")
    )
}

fn is_external_asset(value: &str) -> bool {
    ["data:", "http://", "https://", "asset:"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
}
