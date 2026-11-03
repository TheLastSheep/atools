//! Install-time policy around the non-executing plugin runtime dependency report.
use atools_plugin::package_resolution::{
    runtime_dependencies::{inspect_runtime_dependencies, DependencyStatus},
    PackageDiagnostic, ResolvedPluginPackage,
};
use std::path::{Component, Path};

const MAX_MISSING_ITEMS: usize = 4;
const MAX_SPECIFIER_CHARS: usize = 80;
const MAX_SOURCE_CHARS: usize = 96;
const MAX_ERROR_BYTES: usize = 960;

const MISSING_CODE: &str = "PLUGIN_RUNTIME_DEPENDENCY_MISSING";
const UNKNOWN_CODE: &str = "PLUGIN_RUNTIME_DEPENDENCY_PREFLIGHT_INCOMPLETE";

pub(super) fn check_and_annotate(package: &mut ResolvedPluginPackage) -> Result<(), String> {
    let report = inspect_runtime_dependencies(package);
    let missing = report
        .findings
        .iter()
        .filter(|finding| matches!(&finding.status, DependencyStatus::Missing))
        .collect::<Vec<_>>();

    if report.complete && !missing.is_empty() {
        return Err(missing_error(&missing));
    }

    let has_unknown = report
        .findings
        .iter()
        .any(|finding| matches!(&finding.status, DependencyStatus::Unknown));
    if !report.complete || has_unknown {
        package.diagnostics.push(PackageDiagnostic {
            code: UNKNOWN_CODE.into(),
            message:
                "运行时依赖静态预检存在动态或不确定引用；这不证明依赖缺失，也不代表运行时已验证。"
                    .into(),
        });
    }
    Ok(())
}

fn missing_error(
    findings: &[&atools_plugin::package_resolution::runtime_dependencies::RuntimeDependencyFinding],
) -> String {
    let mut entries = Vec::new();
    for finding in findings.iter().take(MAX_MISSING_ITEMS) {
        let specifier = clipped(&finding.specifier, MAX_SPECIFIER_CHARS);
        let source = safe_relative_path(&finding.source_path);
        entries.push(format!("{specifier} ({source})"));
    }
    let extra = findings.len().saturating_sub(entries.len());
    let extra_text = if extra > 0 {
        format!("，另有 {extra} 项未展开")
    } else {
        String::new()
    };
    let message = format!(
        "[{MISSING_CODE}] 发布包的 preload 缺少可确定的运行依赖：{}{}。请使用包含运行依赖的发布包；ATools 不会自动安装依赖。",
        entries.join("；"), extra_text
    );
    truncate_utf8(&message, MAX_ERROR_BYTES)
}

fn safe_relative_path(path: &Path) -> String {
    let mut parts = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            Component::CurDir => None,
            _ => None,
        })
        .collect::<Vec<_>>();
    if path.is_absolute() && parts.len() > 3 {
        parts.drain(..parts.len() - 3);
    }
    let joined = if parts.is_empty() {
        "preload".to_string()
    } else {
        parts.join("/")
    };
    clipped(&joined, MAX_SOURCE_CHARS)
}

fn clipped(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                '�'
            } else {
                character
            }
        })
        .take(max_chars)
        .collect()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
#[path = "runtime_dependencies_tests.rs"]
mod tests;
