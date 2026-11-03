//! Local package policy and validated staging, shared by install/update/import.
use atools_core::PluginManifest;
use atools_plugin::package_resolution::{
    resolve_plugin_package, PackageReadiness, ResolvedPluginPackage,
};
use std::path::{Path, PathBuf};

mod runtime_dependencies;

pub fn local_package(source: &Path) -> Result<ResolvedPluginPackage, String> {
    let mut package = resolve_plugin_package(source).map_err(|error| error.to_string())?;
    if package.readiness != PackageReadiness::Ready {
        let reason = package
            .diagnostics
            .iter()
            .map(|item| item.message.as_str())
            .collect::<Vec<_>>()
            .join("；");
        return Err(format!("插件尚无可直接运行的本地产物：{reason}"));
    }
    if !platform_supported(&package.raw_manifest) {
        return Err("该插件未声明支持当前操作系统".into());
    }
    runtime_dependencies::check_and_annotate(&mut package)?;
    Ok(package)
}

pub fn platform_supported(raw: &serde_json::Value) -> bool {
    raw.get("platform")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|platform| match std::env::consts::OS {
                    "macos" => platform == "darwin" || platform == "macos",
                    "windows" => platform == "win32" || platform == "windows",
                    "linux" => platform == "linux",
                    other => platform == other,
                })
        })
        .unwrap_or(true)
}

/// A failed validation never leaves a half-imported sibling directory behind.
pub struct StagedPackage {
    pub path: PathBuf,
    pub manifest: PluginManifest,
}
impl Drop for StagedPackage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub fn validate_staged(
    path: PathBuf,
    expected: &PluginManifest,
    expected_raw: Option<&serde_json::Value>,
) -> Result<StagedPackage, String> {
    let mut staged = StagedPackage {
        path,
        manifest: expected.clone(),
    };
    let package = local_package(&staged.path)?;
    if package.package_root
        != staged
            .path
            .canonicalize()
            .map_err(|error| error.to_string())?
        || serde_json::to_value(&package.manifest).map_err(|error| error.to_string())?
            != serde_json::to_value(expected).map_err(|error| error.to_string())?
        || expected_raw.is_some_and(|raw| *raw != package.raw_manifest)
    {
        return Err("插件产物在复制时发生变化，请重新选择发布目录".into());
    }
    staged.manifest = package.manifest;
    Ok(staged)
}

pub fn stage_directory(
    package: &ResolvedPluginPackage,
    destination: &Path,
) -> Result<StagedPackage, String> {
    let destination_resolved = canonical_target(destination).ok_or("无法安全解析插件安装目录")?;
    if package.package_root.starts_with(&destination_resolved)
        || destination_resolved.starts_with(&package.package_root)
    {
        return Err("插件安装目录不能与源目录重叠".into());
    }
    let path = crate::commands::stage_plugin_directory(&package.package_root, destination)?;
    validate_staged(path, &package.manifest, Some(&package.raw_manifest))
}

/// Resolve through the nearest existing ancestor without creating a directory.
pub fn canonical_target(path: &Path) -> Option<PathBuf> {
    if let Ok(existing) = path.canonicalize() {
        return Some(existing);
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    if absolute
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    let mut probe = absolute.as_path();
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(probe) {
            Ok(_) => {
                let mut target = probe.canonicalize().ok()?;
                for part in missing.into_iter().rev() {
                    target.push(part);
                }
                return Some(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && missing.len() < 64 => {
                missing.push(probe.file_name()?.to_os_string());
                probe = probe.parent()?;
            }
            _ => return None,
        }
    }
}

#[cfg(test)]
#[path = "plugin_packages_tests.rs"]
mod tests;
