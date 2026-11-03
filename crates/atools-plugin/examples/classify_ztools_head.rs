//! Static classification of one already-materialized, pinned ZTools HEAD tree.
//! This example never loads a plugin runtime, invokes a plugin, builds a package,
//! installs dependencies, or accesses the network.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use atools_plugin::loader::{assess_ztools_plugin_compatibility, ZToolsCompatibilityTier};
use atools_plugin::package_resolution::resolve_plugin_package;
use readiness_diagnostics::{aggregate_record_counts, readiness_diagnostic_codes};

#[path = "classify_ztools_head/readiness_diagnostics.rs"]
mod readiness_diagnostics;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const EXPECTED_HEAD: &str = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
const EXPECTED_COUNT: usize = 153;
const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct Input {
    schema_version: u32,
    head: String,
    plugins_tree_oid: String,
    plugins: Vec<InputPlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct InputPlugin {
    plugin_directory: String,
    tree_oid: String,
    head_classification: String,
    head_root_manifest: Option<String>,
    head_public_manifest: Option<String>,
    manifest_pins: std::collections::BTreeMap<String, ManifestPin>,
    snapshot_state: String,
    snapshot_issues: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManifestPin {
    path: String,
    bytes: u64,
    sha256: String,
}

fn main() -> Result<()> {
    let (snapshot_root, input_path) = parse_args()?;
    let snapshot_metadata =
        std::fs::symlink_metadata(&snapshot_root).context("snapshot root is unavailable")?;
    if snapshot_metadata.file_type().is_symlink() || !snapshot_metadata.is_dir() {
        bail!("snapshot root is not a real directory");
    }
    let snapshot_root = snapshot_root
        .canonicalize()
        .context("snapshot root is unavailable")?;
    let input_meta = std::fs::symlink_metadata(&input_path).context("input is unavailable")?;
    if input_meta.file_type().is_symlink()
        || !input_meta.is_file()
        || input_meta.len() > MAX_INPUT_BYTES
    {
        bail!("input is not a bounded regular file");
    }
    let input_bytes = std::fs::read(&input_path)?;
    let input: Input = serde_json::from_slice(&input_bytes).context("input schema is invalid")?;
    validate_input(&input)?;

    let mut names = BTreeSet::new();
    let mut records = Vec::with_capacity(EXPECTED_COUNT);
    for entry in input.plugins {
        if !names.insert(entry.plugin_directory.clone()) {
            bail!("duplicate plugin directory");
        }
        if entry.head_root_manifest.is_none() && entry.head_public_manifest.is_none() {
            records.push(unclassified_record(entry, "no_direct_manifest"));
            continue;
        }
        let plugin_root = snapshot_root.join(&entry.plugin_directory);
        let root_meta = std::fs::symlink_metadata(&plugin_root);
        if entry.snapshot_state == "materialized" {
            let meta = root_meta.context("materialized plugin directory is missing")?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                bail!("materialized plugin root is not a real directory");
            }
            if plugin_root.parent() != Some(snapshot_root.as_path()) {
                bail!("plugin root escaped snapshot");
            }
            records.push(classify_entry(entry, &plugin_root)?);
        } else if entry.snapshot_state == "incompatible_snapshot_entry" {
            records.push(unclassified_record(entry, "incompatible_snapshot_entry"));
        } else {
            bail!("snapshot state is unsupported");
        }
    }
    if records.len() != EXPECTED_COUNT || names.len() != EXPECTED_COUNT {
        bail!("plugin denominator mismatch");
    }

    let counts = aggregate_record_counts(&records)?;
    println!(
        "{}",
        serde_json::to_string(&json!({
            "schemaVersion": 2,
            "head": input.head,
            "pluginsTreeOid": input.plugins_tree_oid,
            "denominator": EXPECTED_COUNT,
            "counts": {
                "analysisStates": counts.state_counts,
                "packageReadiness": counts.readiness_counts,
                "tiers": {
                    "tier1_direct_web_view": counts.tier_counts[0],
                    "tier2_quickjs_or_node_sidecar": counts.tier_counts[1],
                    "tier3_requires_build_or_native_addon": counts.tier_counts[2]
                },
                "readinessDiagnosticCodes": counts.readiness_diagnostic_counts
            },
            "records": records
        }))?
    );
    Ok(())
}

fn classify_entry(entry: InputPlugin, plugin_root: &Path) -> Result<Value> {
    let package = resolve_plugin_package(plugin_root).ok();
    let readiness = package.as_ref().map(|package| package.readiness.as_str());
    let readiness_diagnostic_codes = match package.as_ref() {
        Some(package) => readiness_diagnostic_codes(&package.diagnostics)?,
        None => Vec::new(),
    };
    Ok(match assess_ztools_plugin_compatibility(plugin_root) {
        Ok(report) => json!({
            "pluginDirectory": entry.plugin_directory,
            "treeOid": entry.tree_oid,
            "headClassification": entry.head_classification,
            "headRootManifest": entry.head_root_manifest,
            "headPublicManifest": entry.head_public_manifest,
            "manifestPins": entry.manifest_pins,
            "snapshotState": entry.snapshot_state,
            "snapshotIssues": entry.snapshot_issues,
            "analysisState": "classified",
            "packageReadiness": readiness,
            "readinessDiagnosticCodes": readiness_diagnostic_codes,
            "classifier": {
                "pluginName": report.plugin_name,
                "tier": tier_name(report.tier),
                "mainEntryExists": report.main_entry_exists,
                "hasPreload": report.has_preload,
                "usesNodeBuiltins": report.uses_node_builtins,
                "usesElectronApi": report.uses_electron_api,
                "pageNodeUsage": report.page_node_usage,
                "requiresFrontendBuild": report.requires_frontend_build,
                "adapterRecommendation": report.adapter_recommendation
            }
        }),
        Err(_) => json!({
            "pluginDirectory": entry.plugin_directory,
            "treeOid": entry.tree_oid,
            "headClassification": entry.head_classification,
            "headRootManifest": entry.head_root_manifest,
            "headPublicManifest": entry.head_public_manifest,
            "manifestPins": entry.manifest_pins,
            "snapshotState": entry.snapshot_state,
            "snapshotIssues": entry.snapshot_issues,
            "analysisState": "classifier_error",
            "packageReadiness": readiness,
            "readinessDiagnosticCodes": readiness_diagnostic_codes,
            "classifier": Value::Null
        }),
    })
}

fn unclassified_record(entry: InputPlugin, state: &str) -> Value {
    let state = if entry.head_root_manifest.is_none() && entry.head_public_manifest.is_none() {
        "no_direct_manifest"
    } else {
        state
    };
    json!({
        "pluginDirectory": entry.plugin_directory,
        "treeOid": entry.tree_oid,
        "headClassification": entry.head_classification,
        "headRootManifest": entry.head_root_manifest,
        "headPublicManifest": entry.head_public_manifest,
        "manifestPins": entry.manifest_pins,
        "snapshotState": entry.snapshot_state,
        "snapshotIssues": entry.snapshot_issues,
        "analysisState": state,
        "packageReadiness": Value::Null,
        "readinessDiagnosticCodes": Vec::<String>::new(),
        "classifier": Value::Null
    })
}

fn validate_input(input: &Input) -> Result<()> {
    if input.schema_version != 1 || input.head != EXPECTED_HEAD {
        bail!("input identity mismatch");
    }
    if input.plugins_tree_oid.len() != 40
        || !input
            .plugins_tree_oid
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        bail!("plugin tree object id is invalid");
    }
    if input.plugins.len() != EXPECTED_COUNT {
        bail!("input denominator mismatch");
    }
    for entry in &input.plugins {
        if entry.plugin_directory.is_empty()
            || entry.plugin_directory == "."
            || entry.plugin_directory == ".."
            || entry
                .plugin_directory
                .chars()
                .any(|character| matches!(character, '/' | '\\' | '\0'))
            || entry.tree_oid.len() != 40
            || !entry.tree_oid.bytes().all(|b| b.is_ascii_hexdigit())
        {
            bail!("plugin identity is invalid");
        }
        let root_path = entry.head_root_manifest.as_deref();
        let public_path = entry.head_public_manifest.as_deref();
        if root_path
            .is_some_and(|path| path != format!("plugins/{}/plugin.json", entry.plugin_directory))
            || public_path.is_some_and(|path| {
                path != format!("plugins/{}/public/plugin.json", entry.plugin_directory)
            })
        {
            bail!("manifest path is invalid");
        }
        match (
            root_path.is_some(),
            public_path.is_some(),
            entry.head_classification.as_str(),
        ) {
            (true, true, "main_manifest") | (true, false, "main_manifest") => {}
            (false, true, "source_public_only") => {}
            (false, false, "incomplete_top_level_manifest") => {}
            _ => bail!("manifest class is invalid"),
        }
        if entry
            .manifest_pins
            .keys()
            .any(|key| key != "root" && key != "public")
        {
            bail!("manifest pin class is invalid");
        }
        for (class, path) in [("root", root_path), ("public", public_path)] {
            match (path, entry.manifest_pins.get(class)) {
                (None, None) => {}
                (Some(expected_path), Some(pin))
                    if pin.path == expected_path
                        && pin.bytes <= MAX_INPUT_BYTES
                        && pin.sha256.len() == 64
                        && pin.sha256.bytes().all(|b| b.is_ascii_hexdigit()) => {}
                _ => bail!("manifest pin does not match inventory"),
            }
        }
        if entry.snapshot_state == "incompatible_snapshot_entry" && entry.snapshot_issues.is_empty()
        {
            bail!("incompatible snapshot must include a fixed issue code");
        }
        if entry.snapshot_state == "materialized" && !entry.snapshot_issues.is_empty() {
            bail!("materialized snapshot has incompatibility issues");
        }
        if entry.snapshot_issues.iter().any(|issue| {
            !matches!(
                issue.as_str(),
                "symlink_not_followed"
                    | "symlink_target_not_utf8"
                    | "hardlink_not_followed"
                    | "special_file_not_materialized"
                    | "archive_content_mismatch"
                    | "archive_representation_unsupported"
                    | "archive_entry_missing"
                    | "file_size_limit"
                    | "gitlink_not_archived"
            )
        }) {
            bail!("snapshot issue code is unsupported");
        }
    }
    Ok(())
}

fn tier_name(tier: ZToolsCompatibilityTier) -> &'static str {
    match tier {
        ZToolsCompatibilityTier::Tier1DirectWebView => "tier1_direct_web_view",
        ZToolsCompatibilityTier::Tier2QuickJsOrNodeSidecar => "tier2_quickjs_or_node_sidecar",
        ZToolsCompatibilityTier::Tier3RequiresBuildOrNativeAddon => {
            "tier3_requires_build_or_native_addon"
        }
    }
}

fn parse_args() -> Result<(PathBuf, PathBuf)> {
    let mut args = std::env::args_os().skip(1);
    let mut snapshot = None;
    let mut input = None;
    while let Some(flag) = args.next() {
        let value = args.next().context("missing argument value")?;
        match flag.to_str() {
            Some("--snapshot-root") if snapshot.is_none() => snapshot = Some(PathBuf::from(value)),
            Some("--input") if input.is_none() => input = Some(PathBuf::from(value)),
            _ => bail!("unsupported or duplicate argument"),
        }
    }
    Ok((
        snapshot.context("--snapshot-root is required")?,
        input.context("--input is required")?,
    ))
}
