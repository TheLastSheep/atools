//! Static inventory of ready ZTools packages whose manifest has no preload.
//! This does not execute plugin code, build packages, or access the network.

use std::{collections::BTreeMap, path::PathBuf, time::Instant};

use anyhow::{bail, Context, Result};
use atools_plugin::package_resolution::{
    page_requirements::{inspect_plugin_page, Usage},
    resolve_plugin_package,
};
use serde_json::{json, Value};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        bail!("Usage: audit_page_requirements <ZTools-plugins/plugins> <absolute-output-json>");
    }
    let source_root = PathBuf::from(&args[0]).canonicalize()?;
    let output = PathBuf::from(&args[1]);
    if !source_root.is_dir() || !output.is_absolute() || output.exists() {
        bail!("Source must be a directory and output an unused absolute path");
    }

    let mut directories = std::fs::read_dir(&source_root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    directories.retain(|path| {
        std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
    });
    directories.sort();
    let direct_directory_count = directories.len();

    let started = Instant::now();
    let mut counts = BTreeMap::<String, usize>::from([
        ("node_detected".into(), 0),
        ("node_not_detected".into(), 0),
        ("node_unknown".into(), 0),
        ("electron_detected".into(), 0),
        ("electron_not_detected".into(), 0),
        ("electron_unknown".into(), 0),
    ]);
    let mut no_preload = Vec::<Value>::new();
    let mut unresolved = Vec::<Value>::new();
    for directory in directories {
        let package = match resolve_plugin_package(&directory) {
            Ok(package) => package,
            Err(error) => {
                unresolved.push(json!({
                    "package": directory.file_name().unwrap_or_default().to_string_lossy(),
                    "error": format!("{error:#}"),
                }));
                continue;
            }
        };
        if package.manifest.preload.is_some() {
            continue;
        }

        let scan_started = Instant::now();
        let inspected = inspect_plugin_page(&directory);
        let (node_usage, electron_usage, scan_error) = match inspected {
            Ok(requirements) => (
                requirements.node_usage,
                requirements.electron_usage,
                Value::Null,
            ),
            Err(error) => (Usage::Unknown, Usage::Unknown, json!(format!("{error:#}"))),
        };
        *counts
            .entry(format!("node_{}", usage(node_usage)))
            .or_default() += 1;
        *counts
            .entry(format!("electron_{}", usage(electron_usage)))
            .or_default() += 1;
        no_preload.push(json!({
            "package": directory.file_name().unwrap_or_default().to_string_lossy(),
            "name": package.manifest.name,
            "version": package.manifest.version,
            "manifestMain": package.raw_manifest.get("main").cloned().unwrap_or(Value::Null),
            "readiness": package.readiness.as_str(),
            "nodeUsage": usage(node_usage),
            "electronUsage": usage(electron_usage),
            "scanError": scan_error,
            "inspectionDurationMs": scan_started.elapsed().as_secs_f64() * 1000.0,
        }));
    }

    let report = json!({
        "schemaVersion": 1,
        "generatedAt": atools_core::utils::now_iso(),
        "scope": "Static inspection of only the selected ready local HTML main, actual inline/external scripts and bounded local dependencies for direct child packages with no manifest preload. No plugin code is executed, built or installed; no network or recursive backup/source scan is performed. Static usage classification is not runtime or business compatibility acceptance.",
        "sourceRoot": source_root,
        "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
        "timingScope": "One offline filesystem inventory and bounded static page scan; excludes Rust compilation, plugin execution and launcher startup. Filesystem cache state is uncontrolled.",
        "directPackageDirectories": direct_directory_count,
        "noPreloadCount": no_preload.len(),
        "counts": counts,
        "entries": no_preload,
        "unresolvedPackageCount": unresolved.len(),
        "unresolvedPackages": unresolved,
    });
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&output, serde_json::to_vec_pretty(&report)?)
        .with_context(|| format!("Write report {output:?}"))?;
    println!(
        "{}",
        json!({
            "output": output,
            "noPreloadCount": report["noPreloadCount"],
            "counts": report["counts"],
            "unresolvedPackageCount": report["unresolvedPackageCount"],
        })
    );
    Ok(())
}

fn usage(value: Usage) -> &'static str {
    match value {
        Usage::Detected => "detected",
        Usage::NotDetected => "not_detected",
        Usage::Unknown => "unknown",
    }
}
