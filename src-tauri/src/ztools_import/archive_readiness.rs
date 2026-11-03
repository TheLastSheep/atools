//! Shared, bounded, in-memory ZIP/ASAR readiness checks. Never executes plugin code.
use super::{inspection::SourceInspection, ZToolsImportCandidate, MAX_ARCHIVE_DEPTH};
use atools_core::{PluginManifest, PluginRuntimeKind};
use atools_plugin::package_resolution::html::{
    html_entry_references, is_remote_entry, is_source_entry_path, is_uncompiled_script_path,
    local_html_reference_path, HtmlAssetKind, MAX_HTML_REFERENCES,
};
use atools_plugin::package_resolution::{
    normalize_web_main_entry, PackageReadiness, MAX_HTML_BYTES, MAX_MANIFEST_BYTES,
    MAX_PRELOAD_BYTES,
};
use std::path::Path;

pub(super) trait PackageReader {
    fn exists(&self, path: &str) -> Result<bool, String>;
    fn read(&mut self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String>;
}

pub(super) fn normalized_path(base: &str, value: &str, html: bool) -> Result<String, String> {
    if value.is_empty()
        || value.contains(['\\', '\0', ':'])
        || (!html && value.starts_with('/'))
        || (html && value.starts_with("//"))
    {
        return Err("Unsafe plugin archive path".into());
    }
    let mut parts: Vec<&str> = if value.starts_with('/') {
        Vec::new()
    } else {
        base.split('/').filter(|part| !part.is_empty()).collect()
    };
    for part in value.trim_start_matches('/').split('/') {
        match part {
            "" | "." => {}
            ".." if html && !parts.is_empty() => {
                parts.pop();
            }
            ".." => return Err("Plugin archive path escapes package".into()),
            value => parts.push(value),
        }
    }
    if parts.is_empty() || parts.len() > MAX_ARCHIVE_DEPTH {
        return Err("Plugin archive path is empty or exceeds depth budget".into());
    }
    Ok(parts.join("/"))
}

fn text(
    reader: &mut impl PackageReader,
    path: &str,
    limit: usize,
) -> Result<Option<String>, String> {
    reader
        .read(path, limit)?
        .map(|bytes| {
            if bytes.len() > limit {
                return Err(format!("Archive entry exceeds read budget: {path}"));
            }
            String::from_utf8(bytes).map_err(|_| format!("Archive entry is not UTF-8: {path}"))
        })
        .transpose()
}

fn inspect_html(
    reader: &mut impl PackageReader,
    path: &str,
    errors: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Result<bool, String> {
    let html =
        text(reader, path, MAX_HTML_BYTES)?.ok_or_else(|| format!("Missing HTML entry: {path}"))?;
    if html.trim().is_empty() {
        errors.push("Empty HTML entry".into());
    }
    let refs = html_entry_references(&html);
    if refs.assets.len() > MAX_HTML_REFERENCES {
        return Err("HTML reference count exceeds budget".into());
    }
    let mut base = path
        .rsplit_once('/')
        .map_or("", |(base, _)| base)
        .to_string();
    if let Some(href) = refs.base_href.filter(|href| !href.is_empty()) {
        if is_remote_entry(&href) {
            errors.push("HTML base requires a remote origin".into());
            return Ok(false);
        }
        let decoded = local_html_reference_path(&href).map_err(|error| error.to_string())?;
        let file = if decoded.ends_with('/') || decoded == "." || decoded == ".." {
            format!("{decoded}/__atools_base__")
        } else if decoded.is_empty() {
            "__atools_base__".into()
        } else {
            decoded
        };
        let resolved = normalized_path(&base, &file, true)?;
        base = resolved
            .rsplit_once('/')
            .map_or("", |(base, _)| base)
            .into();
    }
    let mut source = false;
    for asset in refs.assets {
        let value = asset.value.trim();
        if value.is_empty() {
            continue;
        }
        if is_remote_entry(value) || value.starts_with("data:") || value.starts_with("blob:") {
            warnings.push(format!("HTML asset is not verified locally: {value}"));
            continue;
        }
        let decoded = local_html_reference_path(value).map_err(|error| error.to_string())?;
        if asset.kind == HtmlAssetKind::Script && is_source_entry_path(&decoded) {
            source = true;
            errors.push(format!("HTML script requires a frontend build: {value}"));
            continue;
        }
        let target = normalized_path(&base, &decoded, true)?;
        if !reader.exists(&target)? {
            errors.push(format!("Missing HTML asset: {value}"));
        }
    }
    Ok(source)
}

pub(super) fn inspect(
    source: &Path,
    source_type: &str,
    reader: &mut impl PackageReader,
) -> Result<SourceInspection, String> {
    let manifest_text =
        text(reader, "plugin.json", MAX_MANIFEST_BYTES)?.ok_or("Archive has no plugin.json")?;
    let raw: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|error| error.to_string())?;
    let mut manifest: PluginManifest =
        serde_json::from_value(raw.clone()).map_err(|error| error.to_string())?;
    if manifest.name.trim().is_empty() {
        return Err("Plugin manifest name cannot be empty".into());
    }
    normalize_web_main_entry(&mut manifest).map_err(|error| error.to_string())?;
    manifest.validate_runtime_contract()?;
    let headless = manifest
        .main
        .as_deref()
        .is_none_or(|main| main.trim().is_empty());
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut requires_build = manifest
        .preload
        .as_deref()
        .is_some_and(is_uncompiled_script_path);
    if requires_build {
        errors.push("Preload requires compilation to executable JavaScript".into());
    }
    let preload_exists = if let Some(preload) = manifest.preload.as_deref() {
        let preload = normalized_path("", preload, false)?;
        let exists = text(reader, &preload, MAX_PRELOAD_BYTES)?.is_some();
        if !exists {
            errors.push("Missing preload file".into());
        }
        exists
    } else {
        true
    };
    let logo_exists = if let Some(logo) = manifest
        .logo
        .as_deref()
        .filter(|logo| !logo.trim().is_empty())
    {
        if is_remote_entry(logo) || logo.starts_with("data:") {
            false
        } else {
            let exists = reader.exists(&normalized_path("", logo, false)?)?;
            if !exists {
                warnings.push("Missing logo file".into());
            }
            exists
        }
    } else {
        true
    };
    let web = manifest.effective_runtime_kind() == PluginRuntimeKind::Web;
    let main = manifest
        .main
        .as_deref()
        .filter(|main| !main.trim().is_empty());
    let mut remote = false;
    let mut main_exists = if let Some(main) = main.filter(|main| !is_remote_entry(main)) {
        reader.exists(&normalized_path("", main, false)?)?
    } else {
        false
    };
    if !web {
        if let Some(entry) = manifest.effective_runtime_entry() {
            if !reader.exists(&normalized_path("", entry, false)?)? {
                errors.push("Missing native runtime entry".into());
            }
        } else {
            errors.push("Missing native runtime entry".into());
        }
    } else if let Some(entry) = main.or_else(|| {
        manifest
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.entry.as_deref())
    }) {
        if is_remote_entry(entry) {
            remote = true;
            errors.push(
                "Remote entry was not fetched or verified; choose a local published package".into(),
            );
        } else {
            let path = normalized_path("", entry, false)?;
            let exists = reader.exists(&path)?;
            main_exists = main.is_some() && exists;
            if !exists {
                errors.push(format!("Missing package entry: {entry}"));
            }
            let ext = Path::new(entry)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let html = matches!(ext.as_str(), "html" | "htm");
            let explicit_headless_js =
                main.is_none() && matches!(ext.as_str(), "js" | "cjs" | "mjs");
            let source_main = is_source_entry_path(entry) || (!html && !explicit_headless_js);
            if source_main {
                requires_build = true;
                errors.push("Web main requires a frontend build".into());
            }
            if exists && html {
                requires_build |= inspect_html(reader, &path, &mut errors, &mut warnings)?;
            }
        }
    } else if manifest.preload.is_none() {
        errors.push("Missing package runtime entry".into());
    }
    let readiness = if requires_build {
        PackageReadiness::RequiresBuild
    } else if remote && (manifest.preload.is_none() || preload_exists) {
        PackageReadiness::Remote
    } else if errors.is_empty() {
        PackageReadiness::Ready
    } else {
        PackageReadiness::Incomplete
    };
    let platform_supported = crate::plugin_packages::platform_supported(&raw);
    if !platform_supported {
        errors.push("该插件未声明支持当前操作系统".into());
    }
    let unsupported = super::unsupported_cmd_types(&manifest);
    if !unsupported.is_empty() {
        warnings.push(format!(
            "Unsupported command types: {}",
            unsupported.join(", ")
        ));
    }
    Ok(SourceInspection::new(
        ZToolsImportCandidate {
            path: source.to_string_lossy().into(),
            source_type: source_type.into(),
            package_path: None,
            entry_readiness: Some(readiness.as_str().into()),
            headless,
            installation_id: None,
            installation_key: None,
            name: manifest.name.clone(),
            title: manifest.title.clone(),
            version: manifest.version.clone(),
            features_count: manifest.features.len(),
            platform_supported,
            main_exists,
            preload_exists,
            logo_exists,
            unsupported_cmd_types: unsupported,
            warnings,
            errors,
        },
        manifest,
        raw,
    ))
}

pub(super) fn asar_inspect(source: &Path) -> Result<SourceInspection, String> {
    struct AsarReader<'a>(super::ParsedAsar<'a>);
    impl PackageReader for AsarReader<'_> {
        fn exists(&self, path: &str) -> Result<bool, String> {
            let path = Path::new(path);
            let node = match super::asar_entry(&self.0, path) {
                Ok(Some(node)) => node,
                _ => return Ok(false),
            };
            if node.get("link").is_some() || node.get("files").is_some() {
                return Err(format!(
                    "Required ASAR asset is not a regular file: {}",
                    path.display()
                ));
            }
            if node.get("unpacked").and_then(serde_json::Value::as_bool) == Some(true) {
                return Err(
                    "Required ASAR asset is external; scan never reads unpacked user paths".into(),
                );
            }
            super::packed_entry_data(&self.0, node, path)?;
            Ok(true)
        }
        fn read(&mut self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
            if !self.exists(path)? {
                return Ok(None);
            }
            let path = Path::new(path);
            let node = super::asar_entry(&self.0, path)?.unwrap();
            let bytes = super::packed_entry_data(&self.0, node, path)?;
            if bytes.len() > limit {
                return Err(format!(
                    "ASAR entry exceeds read budget: {}",
                    path.display()
                ));
            }
            Ok(Some(bytes.to_vec()))
        }
    }
    let bytes = super::read_archive(source)?;
    let mut reader = AsarReader(super::parse_asar(&bytes)?);
    inspect(source, super::archive_source_type(source), &mut reader)
}

#[cfg(test)]
pub(super) fn asar_candidate(source: &Path) -> Result<ZToolsImportCandidate, String> {
    asar_inspect(source).map(|item| item.candidate)
}

#[cfg(test)]
#[path = "archive_readiness_tests.rs"]
mod tests;
