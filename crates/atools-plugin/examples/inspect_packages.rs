//! Pure-read package inventory: no JavaScript, plugin executable, build or network is run.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use atools_plugin::package_resolution::{has_manifest_candidate, resolve_plugin_package};
use serde_json::{json, Value};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        bail!("Usage: inspect_packages <source-directory> <absolute-output-json>");
    }
    let source_root = PathBuf::from(&args[0]).canonicalize()?;
    let output = PathBuf::from(&args[1]);
    if !source_root.is_dir() || !output.is_absolute() {
        bail!("Source must be a directory and output must be absolute");
    }
    let mut directories = std::fs::read_dir(&source_root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    directories.retain(|path| {
        std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
    });
    directories.sort();
    let mut counts = BTreeMap::<String, usize>::new();
    let inspection_started = Instant::now();
    let entries: Vec<Value> = directories
        .into_iter()
        .map(|directory| {
            let entry_started = Instant::now();
            let candidate_present = has_manifest_candidate(&directory);
            let mut result = json!({
                "directory": directory.file_name().unwrap().to_string_lossy(),
                "sourceRoot": directory,
                "hasManifestCandidate": candidate_present,
            });
            match resolve_plugin_package(&directory) {
                Ok(package) => {
                    let readiness = package.readiness.as_str();
                    *counts.entry(readiness.into()).or_default() += 1;
                    result["readiness"] = readiness.into();
                    result["name"] = package.manifest.name.into();
                    result["version"] = package.manifest.version.into();
                    result["main"] = json!(package.manifest.main);
                    result["preload"] = json!(package.manifest.preload);
                    result["headless"] = package
                        .manifest
                        .main
                        .as_deref()
                        .is_none_or(|main| main.trim().is_empty())
                        .into();
                    result["platform"] = package
                        .raw_manifest
                        .get("platform")
                        .cloned()
                        .unwrap_or(Value::Null);
                    result["packageRoot"] = json!(package.package_root);
                    result["manifestPath"] = json!(package.manifest_path);
                    result["selectedManifestRelative"] =
                        json!(package.manifest_path.strip_prefix(&directory).ok());
                    result["diagnostics"] = json!(package.diagnostics);
                }
                Err(error) => {
                    *counts.entry("unresolved".into()).or_default() += 1;
                    result["readiness"] = "unresolved".into();
                    result["error"] = format!("{error:#}").into();
                }
            }
            result["inspectionDurationMs"] = json!(entry_started.elapsed().as_secs_f64() * 1000.0);
            result
        })
        .collect();
    let report = json!({
        "schemaVersion": 1,
        "generatedAt": atools_core::utils::now_iso(),
        "scope": "Pure-read package selection and static entry/asset integrity only. No original plugin is executed, built, installed or network-fetched; readiness is not runtime/business compatibility acceptance.",
        "sourceRoot": source_root,
        "directoryCount": entries.len(),
        "inspectionDurationMs": inspection_started.elapsed().as_secs_f64() * 1000.0,
        "timingScope": "One local read-only inventory pass; excludes Rust compilation, plugin execution and production launcher startup. Filesystem cache state is uncontrolled.",
        "counts": counts,
        "entries": entries,
    });
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&output, serde_json::to_vec_pretty(&report)?)
        .with_context(|| format!("Write report {output:?}"))?;
    println!(
        "{}",
        json!({"output":output,"directoryCount":report["directoryCount"],"counts":report["counts"]})
    );
    Ok(())
}
