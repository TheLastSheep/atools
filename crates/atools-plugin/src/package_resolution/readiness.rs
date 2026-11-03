use std::path::Path;

use anyhow::{bail, Result};
use atools_core::models::{PluginManifest, PluginRuntimeKind};

use super::html::{
    html_entry_references, is_remote_entry, is_source_entry_path, is_uncompiled_script_path,
    local_html_reference_path, HtmlAssetKind, MAX_HTML_REFERENCES,
};
use super::paths::{asset_exists, html_relative, normalized_relative, read_text};
use super::{PackageDiagnostic, PackageReadiness, MAX_HTML_BYTES, MAX_PRELOAD_BYTES};

fn diagnostic(diagnostics: &mut Vec<PackageDiagnostic>, code: &str, message: String) {
    diagnostics.push(PackageDiagnostic {
        code: code.into(),
        message,
    });
}

fn declared_asset(
    root: &Path,
    value: &str,
    role: &str,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Result<bool> {
    let relative = normalized_relative(Path::new(""), value, false)?;
    let exists = asset_exists(root, &relative)?;
    if !exists {
        diagnostic(
            diagnostics,
            &format!("missing_{role}"),
            format!("Declared {role} is missing from the selected package: {value}"),
        );
    }
    Ok(exists)
}

fn inspect_html(
    root: &Path,
    entry: &Path,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Result<(bool, bool)> {
    let html = read_text(root, entry, MAX_HTML_BYTES)?.unwrap_or_default();
    if html.trim().is_empty() {
        diagnostic(diagnostics, "empty_main", "HTML main entry is empty".into());
        return Ok((false, true));
    }
    let references = html_entry_references(&html);
    if references.assets.len() > MAX_HTML_REFERENCES {
        bail!("HTML entry exceeds {MAX_HTML_REFERENCES} asset references");
    }
    let mut requires_build = false;
    let mut incomplete = false;
    let mut base = entry
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    if let Some(href) = references.base_href.filter(|href| !href.is_empty()) {
        // Browser URL base semantics are not filesystem parent semantics. An explicit base
        // must be packaged relative to the entry; remote bases cannot prove offline readiness.
        if is_remote_entry(&href) {
            diagnostic(
                diagnostics,
                "remote_html_base",
                format!("HTML base requires a remote origin: {href}"),
            );
            return Ok((false, true));
        }
        let href = local_html_reference_path(&href)?;
        let base_file = if href.ends_with('/') || href == "." || href == ".." {
            format!("{href}/__atools_base__")
        } else if href.is_empty() {
            "__atools_base__".into()
        } else {
            href
        };
        base = html_relative(&base, &base_file)?;
        base.pop();
    }
    for reference in references.assets {
        let value = reference.value.trim();
        if value.is_empty() {
            continue;
        }
        if is_remote_entry(value) || value.starts_with("data:") || value.starts_with("blob:") {
            diagnostic(
                diagnostics,
                "external_html_asset",
                format!("HTML asset is not verified locally: {value}"),
            );
            continue;
        }
        let value = local_html_reference_path(value)?;
        if reference.kind == HtmlAssetKind::Script && is_source_entry_path(&value) {
            requires_build = true;
            diagnostic(
                diagnostics,
                "source_script_entry",
                format!("HTML script requires a frontend build: {value}"),
            );
            // Source templates commonly use Vite /src URLs. They never become runnable
            // package paths and are not read from outside the package.
            continue;
        }
        let relative = html_relative(&base, &value)?;
        if !asset_exists(root, &relative)? {
            incomplete = true;
            let role = if reference.kind == HtmlAssetKind::Script {
                "script"
            } else {
                "stylesheet"
            };
            diagnostic(
                diagnostics,
                &format!("missing_{role}"),
                format!("HTML {role} is missing from the selected package: {value}"),
            );
        }
    }
    Ok((requires_build, incomplete))
}

pub(super) fn inspect_package(
    root: &Path,
    manifest: &PluginManifest,
) -> Result<(PackageReadiness, Vec<PackageDiagnostic>)> {
    let mut diagnostics = Vec::new();
    let mut incomplete = false;
    let preload_requires_build = manifest
        .preload
        .as_deref()
        .is_some_and(is_uncompiled_script_path);
    if preload_requires_build {
        diagnostic(
            &mut diagnostics,
            "source_preload_entry",
            "Declared preload requires compilation to executable JavaScript".into(),
        );
    }
    if let Some(logo) = manifest
        .logo
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !is_remote_entry(logo) && !logo.starts_with("data:") {
            declared_asset(root, logo, "logo", &mut diagnostics)?;
        }
    }
    if let Some(preload) = manifest.preload.as_deref() {
        let relative = normalized_relative(Path::new(""), preload, false)?;
        if read_text(root, &relative, MAX_PRELOAD_BYTES)?.is_none() {
            incomplete = true;
            diagnostic(
                &mut diagnostics,
                "missing_preload",
                format!("Declared preload is missing from the selected package: {preload}"),
            );
        }
    }
    if manifest.effective_runtime_kind() != PluginRuntimeKind::Web {
        let Some(entry) = manifest.effective_runtime_entry() else {
            diagnostic(
                &mut diagnostics,
                "missing_runtime_entry",
                "Native runtime has no declared entry".into(),
            );
            return Ok((PackageReadiness::Incomplete, diagnostics));
        };
        if !declared_asset(root, entry, "runtime_entry", &mut diagnostics)? {
            incomplete = true;
        }
        return Ok((
            if preload_requires_build {
                PackageReadiness::RequiresBuild
            } else if incomplete {
                PackageReadiness::Incomplete
            } else {
                PackageReadiness::Ready
            },
            diagnostics,
        ));
    }
    let main = manifest
        .main
        .as_deref()
        .filter(|main| !main.trim().is_empty())
        .or_else(|| {
            manifest
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.entry.as_deref())
        });
    let Some(main) = main else {
        if manifest.preload.is_none() {
            incomplete = true;
            diagnostic(
                &mut diagnostics,
                "missing_entry",
                "Package declares neither a main nor a preload entry".into(),
            );
        }
        return Ok((
            if preload_requires_build {
                PackageReadiness::RequiresBuild
            } else if incomplete {
                PackageReadiness::Incomplete
            } else {
                PackageReadiness::Ready
            },
            diagnostics,
        ));
    };
    if is_remote_entry(main) {
        diagnostic(
            &mut diagnostics,
            "remote_entry",
            format!("Remote entry was not fetched or verified: {main}"),
        );
        return Ok((
            if preload_requires_build {
                PackageReadiness::RequiresBuild
            } else if incomplete {
                PackageReadiness::Incomplete
            } else {
                PackageReadiness::Remote
            },
            diagnostics,
        ));
    }
    let entry = normalized_relative(Path::new(""), main, false)?;
    let exists = declared_asset(root, main, "main", &mut diagnostics)?;
    let extension = entry
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_html = matches!(extension.as_str(), "html" | "htm");
    let explicit_headless_js = manifest
        .main
        .as_deref()
        .is_none_or(|main| main.trim().is_empty())
        && matches!(extension.as_str(), "js" | "cjs" | "mjs");
    let mut requires_build =
        preload_requires_build || is_source_entry_path(main) || (!is_html && !explicit_headless_js);
    if requires_build {
        diagnostic(
            &mut diagnostics,
            "source_main_entry",
            format!("Web main requires a frontend build: {main}"),
        );
    }
    if !exists {
        incomplete = true;
    }
    if exists && is_html {
        let (source, missing) = inspect_html(root, &entry, &mut diagnostics)?;
        requires_build |= source;
        incomplete |= missing;
    }
    let readiness = if requires_build {
        PackageReadiness::RequiresBuild
    } else if incomplete {
        PackageReadiness::Incomplete
    } else {
        PackageReadiness::Ready
    };
    Ok((readiness, diagnostics))
}
