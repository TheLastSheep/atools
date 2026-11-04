//! Applies a source-derived manifest path map to an already verified private output.

use super::{output::ApprovedManifest, staging};
use atools_plugin::source_build::{ManifestOutputRewritePlan, ManifestPathField, SourceBuildPlan};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

const MANIFEST_LIMIT: u64 = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestRewriteReceipt {
    pub before_sha256: String,
    pub after_sha256: String,
    pub mapped_fields: Vec<&'static str>,
}

pub(super) fn rewrite_verified_output(
    output_root: &Path,
    plan: &SourceBuildPlan,
    approved: &ApprovedManifest,
) -> Result<Option<ManifestRewriteReceipt>, String> {
    #[cfg(unix)]
    {
        return rewrite_verified_output_unix(output_root, plan, approved);
    }
    #[cfg(not(unix))]
    {
        let _ = (output_root, plan, approved);
        Err("SourceBuildSandboxUnsupported".into())
    }
}

#[cfg(unix)]
fn rewrite_verified_output_unix(
    output_root: &Path,
    plan: &SourceBuildPlan,
    approved: &ApprovedManifest,
) -> Result<Option<ManifestRewriteReceipt>, String> {
    use super::staging::Directory;

    let Some(rewrite) = plan.manifest_output_rewrite.as_ref() else {
        return Ok(None);
    };
    validate_rewrite_plan(rewrite)?;
    let output_directory = Directory::absolute(output_root)?;
    let manifest_name = OsStr::new("plugin.json");
    let manifest_snapshot = staging::read_relative_regular(
        &output_directory,
        Path::new("plugin.json"),
        MANIFEST_LIMIT,
    )?
    .ok_or("SourceBuildFileUnavailable")?;
    let before = &manifest_snapshot.bytes;
    let mut output_json: Value =
        serde_json::from_slice(before).map_err(|_| "SourceBuildInvalidOutputManifest")?;
    validate_manifest_projection(&approved.raw, &mut output_json, rewrite)?;
    validate_public_asset_copies(&output_directory, rewrite)?;

    let before_sha256 = digest(before);
    let mapped_fields = rewrite
        .paths
        .iter()
        .filter(|path| path.source_value != path.output_value)
        .map(|path| path.field.summary_name())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let path_values_changed = rewrite.paths.iter().any(|path| {
        get_path(&output_json, &path.field).and_then(Value::as_str)
            != Some(path.output_value.as_str())
    });
    let after = if path_values_changed {
        for path in &rewrite.paths {
            *get_path_mut(&mut output_json, &path.field)? =
                Value::String(path.output_value.clone());
        }
        let mut bytes = serde_json::to_vec_pretty(&output_json)
            .map_err(|_| "SourceBuildOutputManifestEncodeFailed")?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MANIFEST_LIMIT {
            return Err("SourceBuildOutputManifestLimitExceeded".into());
        }
        staging::replace_relative_regular(
            &output_directory,
            manifest_name,
            &manifest_snapshot,
            &bytes,
        )?;
        bytes
    } else {
        before.to_vec()
    };
    Ok(Some(ManifestRewriteReceipt {
        before_sha256,
        after_sha256: digest(&after),
        mapped_fields,
    }))
}

pub(super) fn verify_published_manifest(
    published_root: &Path,
    receipt: &ManifestRewriteReceipt,
    plan: &SourceBuildPlan,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        use super::staging::Directory;

        let output_directory = Directory::absolute(published_root)?;
        let manifest = staging::read_relative_regular(
            &output_directory,
            Path::new("plugin.json"),
            MANIFEST_LIMIT,
        )?
        .ok_or("SourceBuildFileUnavailable")?;
        if digest(&manifest.bytes) != receipt.after_sha256 {
            return Err("SourceBuildOutputManifestCopyChanged".into());
        }
        let rewrite = plan
            .manifest_output_rewrite
            .as_ref()
            .ok_or("SourceBuildManifestRewritePlanInvalid")?;
        validate_public_asset_copies(&output_directory, rewrite)
    }
    #[cfg(not(unix))]
    {
        let _ = (published_root, receipt, plan);
        Err("SourceBuildSandboxUnsupported".into())
    }
}

fn validate_rewrite_plan(plan: &ManifestOutputRewritePlan) -> Result<(), String> {
    let mut fields = BTreeSet::new();
    let mut main_count = 0;
    let mut main_mapping: Option<(&PathBuf, &str)> = None;
    let mut runtime_mapping: Option<(&PathBuf, &str)> = None;
    for path in &plan.paths {
        let key = match path.field {
            ManifestPathField::Main => {
                main_count += 1;
                if !is_html(&path.source_path)
                    || slash_path(&path.source_path).as_deref() != Some(path.output_value.as_str())
                {
                    return Err("SourceBuildManifestRewritePlanInvalid".into());
                }
                main_mapping = Some((&path.source_path, path.output_value.as_str()));
                "main".to_owned()
            }
            ManifestPathField::Logo => "logo".to_owned(),
            ManifestPathField::Preload => "preload".to_owned(),
            ManifestPathField::RuntimeEntry => {
                runtime_mapping = Some((&path.source_path, path.output_value.as_str()));
                "runtime.entry".to_owned()
            }
            ManifestPathField::FeatureIcon(index) => format!("features[{index}].icon"),
        };
        if !fields.insert(key) || safe_relative(&path.source_path).is_none() {
            return Err("SourceBuildManifestRewritePlanInvalid".into());
        }
        if path.source_value.is_empty()
            || path.output_value.is_empty()
            || path.source_value.chars().any(char::is_control)
            || path.output_value.chars().any(char::is_control)
        {
            return Err("SourceBuildManifestRewritePlanInvalid".into());
        }
        let output_path = Path::new(&path.output_value);
        if safe_relative(output_path).is_none()
            || slash_path(output_path).as_deref() != Some(path.output_value.as_str())
        {
            return Err("SourceBuildManifestRewritePlanInvalid".into());
        }
        if matches!(
            path.field,
            ManifestPathField::Logo
                | ManifestPathField::Preload
                | ManifestPathField::FeatureIcon(_)
        ) {
            let output = path.source_path.strip_prefix("public").ok();
            if output.and_then(slash_path).as_deref() != Some(path.output_value.as_str()) {
                return Err("SourceBuildManifestRewritePlanInvalid".into());
            }
        }
    }
    if main_count != 1 || runtime_mapping.is_some_and(|runtime| Some(runtime) != main_mapping) {
        return Err("SourceBuildManifestRewritePlanInvalid".into());
    }
    validate_asset_pins(plan)?;
    Ok(())
}

fn validate_asset_pins(plan: &ManifestOutputRewritePlan) -> Result<(), String> {
    let mut expected = std::collections::BTreeMap::<PathBuf, (PathBuf, bool)>::new();
    for path in &plan.paths {
        if matches!(
            path.field,
            ManifestPathField::Main | ManifestPathField::RuntimeEntry
        ) {
            continue;
        }
        let source_public = path
            .source_path
            .strip_prefix("public")
            .map_err(|_| "SourceBuildManifestRewritePlanInvalid")?;
        if slash_path(source_public).as_deref() != Some(path.output_value.as_str()) {
            return Err("SourceBuildManifestRewritePlanInvalid".into());
        }
        let required = !matches!(path.field, ManifestPathField::FeatureIcon(_));
        match expected.get_mut(&path.source_path) {
            Some((output, is_required)) => {
                if output.as_path() != Path::new(&path.output_value) {
                    return Err("SourceBuildManifestRewritePlanInvalid".into());
                }
                *is_required |= required;
            }
            None => {
                expected.insert(
                    path.source_path.clone(),
                    (PathBuf::from(&path.output_value), required),
                );
            }
        }
    }
    if expected.len() != plan.public_assets.len() || expected.len() > 4096 {
        return Err("SourceBuildManifestRewritePlanInvalid".into());
    }
    let mut unique = BTreeSet::new();
    let mut total = 0usize;
    for pin in &plan.public_assets {
        let Some((output_path, required)) = expected.get(&pin.source_path) else {
            return Err("SourceBuildManifestRewritePlanInvalid".into());
        };
        if output_path != &pin.output_path
            || !unique.insert(pin.source_path.clone())
            || safe_relative(&pin.source_path).is_none()
            || safe_relative(&pin.output_path).is_none()
        {
            return Err("SourceBuildManifestRewritePlanInvalid".into());
        }
        match (pin.source_byte_len, pin.source_sha256.as_deref()) {
            (Some(byte_len), Some(hash)) => {
                let byte_len = usize::try_from(byte_len)
                    .map_err(|_| "SourceBuildManifestRewritePlanInvalid")?;
                total = total
                    .checked_add(byte_len)
                    .filter(|size| *size <= 32 * 1024 * 1024)
                    .ok_or("SourceBuildManifestRewritePlanInvalid")?;
                if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err("SourceBuildManifestRewritePlanInvalid".into());
                }
            }
            (None, None) if !required => {}
            _ => return Err("SourceBuildManifestRewritePlanInvalid".into()),
        }
    }
    Ok(())
}

fn validate_manifest_projection(
    source: &Value,
    output: &Value,
    plan: &ManifestOutputRewritePlan,
) -> Result<(), String> {
    let mut normalized_output = output.clone();
    for path in &plan.paths {
        let source_value = get_path(source, &path.field)
            .and_then(Value::as_str)
            .ok_or("SourceBuildManifestRewritePlanMismatch")?;
        if source_value != path.source_value {
            return Err("SourceBuildManifestRewritePlanMismatch".into());
        }
        let actual = get_path(&normalized_output, &path.field)
            .and_then(Value::as_str)
            .ok_or("SourceBuildOutputManifestPathMismatch")?;
        if actual != path.source_value && actual != path.output_value {
            return Err("SourceBuildOutputManifestPathMismatch".into());
        }
        *get_path_mut(&mut normalized_output, &path.field)? =
            Value::String(path.source_value.clone());
    }
    if &normalized_output != source {
        return Err("SourceBuildOutputManifestMetadataMismatch".into());
    }
    Ok(())
}

#[cfg(unix)]
fn validate_public_asset_copies(
    output_root: &staging::Directory,
    plan: &ManifestOutputRewritePlan,
) -> Result<(), String> {
    for pin in &plan.public_assets {
        let output =
            staging::read_relative_regular(output_root, &pin.output_path, staging::FILE_LIMIT)?;
        match (pin.source_byte_len, pin.source_sha256.as_deref(), output) {
            (Some(expected_len), Some(expected_hash), Some(output)) => {
                if u64::try_from(output.bytes.len()).ok() != Some(expected_len)
                    || digest(&output.bytes).as_str() != expected_hash
                {
                    return Err("SourceBuildOutputPublicAssetMismatch".into());
                }
            }
            (None, None, None) => {}
            _ => return Err("SourceBuildOutputPublicAssetMismatch".into()),
        }
    }
    Ok(())
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

fn safe_relative(path: &Path) -> Option<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(())
}

fn slash_path(path: &Path) -> Option<String> {
    path.components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .filter(|parts| !parts.is_empty())
        .map(|parts| parts.join("/"))
}

fn get_path<'a>(value: &'a Value, field: &ManifestPathField) -> Option<&'a Value> {
    match field {
        ManifestPathField::Main => value.get("main"),
        ManifestPathField::Logo => value.get("logo"),
        ManifestPathField::Preload => value.get("preload"),
        ManifestPathField::RuntimeEntry => value.pointer("/runtime/entry"),
        ManifestPathField::FeatureIcon(index) => value.get("features")?.get(*index)?.get("icon"),
    }
}

fn get_path_mut<'a>(
    value: &'a mut Value,
    field: &ManifestPathField,
) -> Result<&'a mut Value, String> {
    match field {
        ManifestPathField::Main => value.get_mut("main"),
        ManifestPathField::Logo => value.get_mut("logo"),
        ManifestPathField::Preload => value.get_mut("preload"),
        ManifestPathField::RuntimeEntry => value.pointer_mut("/runtime/entry"),
        ManifestPathField::FeatureIcon(index) => value
            .get_mut("features")
            .and_then(|features| features.get_mut(*index))
            .and_then(|feature| feature.get_mut("icon")),
    }
    .ok_or_else(|| "SourceBuildOutputManifestPathMismatch".to_owned())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
