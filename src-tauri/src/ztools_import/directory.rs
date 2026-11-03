//! Resolve a source checkout once, then present/import exactly its selected package.
use super::{inspection::SourceInspection, unsupported_cmd_types, ZToolsImportCandidate};
use atools_plugin::package_resolution::{resolve_plugin_package, PackageReadiness};
use std::path::Path;

pub use crate::plugin_packages::platform_supported;

pub(super) fn inspect(source: &Path) -> Result<SourceInspection, String> {
    let package = resolve_plugin_package(source).map_err(|error| error.to_string())?;
    let raw = &package.raw_manifest;
    let manifest = &package.manifest;
    let headless = manifest
        .main
        .as_deref()
        .is_none_or(|entry| entry.trim().is_empty());
    let platform_supported = platform_supported(raw);
    let mut warnings = Vec::new();
    let mut errors = Vec::new();
    for diagnostic in &package.diagnostics {
        if package.readiness == PackageReadiness::Ready {
            warnings.push(diagnostic.message.clone());
        } else {
            errors.push(diagnostic.message.clone());
        }
    }
    if package.readiness != PackageReadiness::Ready && errors.is_empty() {
        errors.push("该插件没有可直接运行的本地入口，请选择插件发布产物".into());
    }
    if !platform_supported {
        errors.push("该插件未声明支持当前操作系统".into());
    }
    let unsupported = unsupported_cmd_types(manifest);
    if !unsupported.is_empty() {
        warnings.push(format!(
            "Unsupported command types: {}",
            unsupported.join(", ")
        ));
    }
    Ok(SourceInspection::new(
        ZToolsImportCandidate {
            path: source.to_string_lossy().to_string(),
            source_type: "directory".into(),
            package_path: Some(package.package_root.to_string_lossy().to_string()),
            entry_readiness: Some(package.readiness.as_str().into()),
            headless,
            installation_id: None,
            installation_key: None,
            name: manifest.name.clone(),
            title: manifest.title.clone(),
            version: manifest.version.clone(),
            features_count: manifest.features.len(),
            platform_supported,
            main_exists: !headless
                && manifest
                    .main
                    .as_ref()
                    .is_some_and(|entry| package.package_root.join(entry).is_file()),
            preload_exists: manifest
                .preload
                .as_ref()
                .is_none_or(|entry| package.package_root.join(entry).is_file()),
            logo_exists: manifest
                .logo
                .as_ref()
                .is_none_or(|entry| package.package_root.join(entry).is_file()),
            unsupported_cmd_types: unsupported,
            warnings,
            errors,
        },
        package.manifest,
        package.raw_manifest,
    ))
}
