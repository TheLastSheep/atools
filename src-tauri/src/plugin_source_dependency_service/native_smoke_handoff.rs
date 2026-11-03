//! Optional, success-only handoff for a later native UI fixture.
use super::{case::SourceCase, fixture::Fixture, tree};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

const UI_HANDOFF_NAME: &str = "converted-ui-handoff-v1.json";
const SOURCE_EVIDENCE_NAME: &str = "converted-source-evidence-v1.json";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_TREE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TREE_ENTRIES: u64 = 100_000;
const MAX_NODE_BYTES: u64 = 512 * 1024 * 1024;
const INSTALL_TOOL: &str = "atools-ui.plugin.import";
const FIXTURE_CLIENT_ID: &str = "b235-isolated-native-fixture";
const EXPECTED_TOOLS: [&str; 6] = [
    "inspect_ztools_source_dependencies",
    "fetch_ztools_source_dependencies",
    "prepare_ztools_source_dependencies",
    "inspect_ztools_source_dependencies",
    crate::plugin_source_build::registry::INSPECT_TOOL,
    "convert_ztools_plugin",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HandoffFailure {
    stage: &'static str,
    code: &'static str,
}

impl HandoffFailure {
    const fn new(stage: &'static str, code: &'static str) -> Self {
        Self { stage, code }
    }
    fn json(self) -> Value {
        json!({"stage":self.stage,"code":self.code})
    }
}

#[derive(Debug)]
struct Chain {
    revision: String,
    set_id: String,
    node_sha: String,
    node_bytes: u64,
    toolchain_sha: String,
    dependency_tree_sha: String,
    dependency_tree_bytes: u64,
    dependency_tree_entries: u64,
    dependency_tree_files: u64,
    package_count: u64,
    conversion: Value,
}

pub(super) fn finalize(fixture: &Fixture, report: &mut Value) -> Result<(), String> {
    let cleanup_safe = report
        .pointer("/server/cleanupSafe")
        .and_then(Value::as_bool)
        == Some(true)
        && report.get("passed").and_then(Value::as_bool) == Some(true);
    if cleanup_safe && fixture.retain_converted_handoff {
        match create_handoff(fixture, report) {
            Ok((path, sha256)) => {
                report["server"]["privateDataRemoved"] = json!(false);
                if fixture.case.native_ui_consumer_supported {
                    report["server"]["privateDataPreservedForUiAcceptance"] = json!(true);
                    report["convertedUiHandoff"] = json!({
                        "available":true,"businessUsabilityVerified":false,
                        "nativeUiConsumerSupported":true,"manifestPath":path,"manifestSha256":sha256
                    });
                } else {
                    report["server"]["privateDataPreservedForConvertedEvidence"] = json!(true);
                    report["convertedSourceEvidence"] = json!({
                        "available":true,"businessUsabilityVerified":false,
                        "nativeUiConsumerSupported":false,"manifestPath":path,"manifestSha256":sha256
                    });
                }
            }
            Err(failure) => {
                report["passed"] = json!(false);
                report["server"]["privateDataRemoved"] = json!(false);
                report["server"]["privateDataPreservedForRecovery"] = json!(true);
                if fixture.case.native_ui_consumer_supported {
                    report["convertedUiHandoff"] = json!({
                        "available":false,"businessUsabilityVerified":false,
                        "failure":failure.json()
                    });
                } else {
                    report["convertedSourceEvidence"] = json!({
                        "available":false,"businessUsabilityVerified":false,
                        "nativeUiConsumerSupported":false,"failure":failure.json()
                    });
                }
            }
        }
        return Ok(());
    }
    if cleanup_safe {
        fs::remove_dir_all(&fixture.root).map_err(|_| "Private fixture root cleanup failed")?;
        report["server"]["privateDataRemoved"] = json!(true);
    } else {
        report["server"]["privateDataRemoved"] = json!(false);
        report["server"]["privateDataPreservedForRecovery"] = json!(true);
        if fixture.retain_converted_handoff {
            let mut evidence = json!({"available":false,"businessUsabilityVerified":false,
                "failure":{"stage":"pipeline","code":"HANDOFF_PIPELINE_NOT_SUCCESSFUL"}});
            if !fixture.case.native_ui_consumer_supported {
                evidence["nativeUiConsumerSupported"] = json!(false);
            }
            if fixture.case.native_ui_consumer_supported {
                report["convertedUiHandoff"] = evidence;
            } else {
                report["convertedSourceEvidence"] = evidence;
            }
        }
    }
    Ok(())
}

fn create_handoff(fixture: &Fixture, report: &Value) -> Result<(String, String), HandoffFailure> {
    let case = fixture.case;
    let chain = validate_report(
        case,
        report,
        &fixture.source_revision_before,
        &fixture.source_manifest_sha256,
        &fixture.source_inventory_sha256,
    )?;
    if fixture.root.parent() != Some(Path::new("/private/tmp"))
        || !fixture
            .root
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("atools-batch235-"))
    {
        return Err(HandoffFailure::new(
            "fixture_root",
            "HANDOFF_FIXTURE_ROOT_INVALID",
        ));
    }

    let installed = report.get("installedPlugin").ok_or(HandoffFailure::new(
        "installed_identity",
        "HANDOFF_INSTALLED_IDENTITY_INVALID",
    ))?;
    if installed.get("verified").and_then(Value::as_bool) != Some(true)
        || installed.get("pluginId").and_then(Value::as_str) != Some(case.plugin_id)
        || installed.get("version").and_then(Value::as_str) != Some(case.plugin_version)
    {
        return Err(HandoffFailure::new(
            "installed_identity",
            "HANDOFF_INSTALLED_IDENTITY_INVALID",
        ));
    }
    let installed_tree_sha = required_hash(installed, "completeInstalledTreeSha256")?;
    let installed_entries = bounded_positive(installed, "treeEntries", MAX_TREE_ENTRIES)?;
    let installed_files = bounded_positive(installed, "treeFiles", MAX_TREE_ENTRIES)?;
    let installed_bytes = bounded_positive(installed, "treeBytes", MAX_TREE_BYTES)?;
    let installed_path = fixture.app_data.join("plugins").join(case.plugin_id);
    if !installed_path.is_absolute()
        || !installed_path.starts_with(&fixture.root)
        || installed_path != fixture.root.join("app-data/plugins").join(case.plugin_id)
    {
        return Err(HandoffFailure::new(
            "installed_path",
            "HANDOFF_INSTALLED_PATH_INVALID",
        ));
    }
    let rechecked_tree = tree::digest(&installed_path).map_err(|_| {
        HandoffFailure::new("installed_digest", "HANDOFF_INSTALLED_TREE_UNAVAILABLE")
    })?;
    if rechecked_tree.sha256 != installed_tree_sha
        || rechecked_tree.entries != installed_entries
        || rechecked_tree.files != installed_files
        || rechecked_tree.bytes != installed_bytes
    {
        return Err(HandoffFailure::new(
            "installed_digest",
            "HANDOFF_INSTALLED_TREE_MISMATCH",
        ));
    }

    let runs = report
        .get("taskRuns")
        .and_then(Value::as_array)
        .ok_or(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ))?;
    let install_run = report
        .pointer("/server/taskRunRows")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("capabilityId").and_then(Value::as_str) == Some(INSTALL_TOOL))
        })
        .ok_or(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ))?;
    let task_rows = runs
        .iter()
        .map(|run| {
            json!({
                "taskRunId":run.get("taskRunId"),"capabilityId":run.get("tool"),
                "status":run.get("status"),"output":run.get("output")
            })
        })
        .collect::<Vec<_>>();
    let handoff_name = if case.native_ui_consumer_supported {
        UI_HANDOFF_NAME
    } else {
        SOURCE_EVIDENCE_NAME
    };
    let mut manifest = json!({
        "schemaVersion":1,
        "handoffStatus":if case.native_ui_consumer_supported { "ready_for_native_ui_fixture" } else { "conversion_evidence_only" },
        "businessUsabilityVerified":false,"fixtureRoot":fixture.root,
        "appDataRoot":fixture.app_data,"installedPackagePath":installed_path,
        "source":{
            "path":fixture.source,"upstreamHead":case.upstream_head,
            "manifestSha256":fixture.source_manifest_sha256,
            "inventorySha256":fixture.source_inventory_sha256,
            "sourceRevision":chain.revision,"fileCount":fixture.source_files,"bytes":fixture.source_bytes
        },
        "dependencies":{
            "dependencySetIdSha256":chain.set_id,"packageCount":chain.package_count,
            "nodeBinarySha256":chain.node_sha,"nodeBinaryBytes":chain.node_bytes,
            "toolchainFingerprintSha256":chain.toolchain_sha,
            "treeSha256":chain.dependency_tree_sha,"treeEntries":chain.dependency_tree_entries,
            "treeFiles":chain.dependency_tree_files,"treeBytes":chain.dependency_tree_bytes
        },
        "conversion":{
            "taskRunId":runs[5].get("taskRunId"),"capabilityId":EXPECTED_TOOLS[5],
            "status":runs[5].get("status"),"output":chain.conversion
        },
        "expectedSequence":EXPECTED_TOOLS,"taskRuns":task_rows,
        "installationTaskRun":{
            "taskRunId":install_run.get("id"),
            "capabilityId":install_run.get("capabilityId"),
            "status":install_run.get("status"),
            "initiatorType":install_run.get("initiatorType"),
            "clientId":install_run.get("clientId")
        },
        "installedPackage":{
            "pluginId":case.plugin_id,"version":case.plugin_version,"treeSha256":installed_tree_sha,
            "treeEntries":installed_entries,"treeFiles":installed_files,"treeBytes":installed_bytes
        },
        "taskRunCount":EXPECTED_TOOLS.len()+1,
        "taskRunsTerminal":true,"pendingPermissionRequestCount":0,"activeTaskRunCount":0,
        "allLeasesInactive":true,"sourceFilesUnchanged":true
    });
    if !case.native_ui_consumer_supported {
        manifest["artifactKind"] = json!("converted_source_evidence");
        manifest["sourceCaseId"] = json!(case.case_id);
        manifest["nativeUiConsumerSupported"] = json!(false);
        manifest["pluginIdentity"] = json!({"id":case.plugin_id,"version":case.plugin_version,
            "main":case.plugin_main,"preload":case.plugin_preload,"featureCode":case.feature_code,
            "runtime":case.runtime});
    }
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|_| {
        HandoffFailure::new("manifest_publication", "HANDOFF_MANIFEST_PUBLISH_FAILED")
    })?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(HandoffFailure::new(
            "manifest_publication",
            "HANDOFF_MANIFEST_PUBLISH_FAILED",
        ));
    }
    let path = fixture.root.join(handoff_name);
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(&path).map_err(|_| {
        HandoffFailure::new("manifest_publication", "HANDOFF_MANIFEST_PUBLISH_FAILED")
    })?;
    file.write_all(&bytes).map_err(|_| {
        HandoffFailure::new("manifest_publication", "HANDOFF_MANIFEST_PUBLISH_FAILED")
    })?;
    file.sync_all().map_err(|_| {
        HandoffFailure::new("manifest_publication", "HANDOFF_MANIFEST_PUBLISH_FAILED")
    })?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok((path.to_string_lossy().into_owned(), sha256))
}

fn validate_report(
    case: SourceCase,
    report: &Value,
    expected_revision: &str,
    expected_manifest: &str,
    expected_inventory: &str,
) -> Result<Chain, HandoffFailure> {
    require_quiescent_success(report)?;
    if report.get("profile").and_then(Value::as_str) != Some(case.report_profile)
        || report.get("sourceCaseId").and_then(Value::as_str) != Some(case.case_id)
    {
        return Err(HandoffFailure::new(
            "source_identity",
            "HANDOFF_SOURCE_IDENTITY_MISMATCH",
        ));
    }
    let runs = report
        .get("taskRuns")
        .and_then(Value::as_array)
        .ok_or(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ))?;
    let initial = output(runs, 0)?;
    let fetched = output(runs, 1)?;
    let prepared = output(runs, 2)?;
    let prepared_inspection = output(runs, 3)?;
    let source_build_inspection = output(runs, 4)?;
    let conversion = output(runs, 5)?;

    let revision = required_hash(initial, "sourceRevision")?;
    let set_id = required_hash(initial, "dependencySetIdSha256")?;
    let node_sha = required_hash(initial, "nodeBinarySha256")?;
    let node_bytes = bounded_positive(initial, "nodeBinaryBytes", MAX_NODE_BYTES)?;
    let toolchain_sha = required_hash(initial, "toolchainFingerprintSha256")?;
    let dependency_tree_sha = required_hash(prepared, "treeSha256")?;
    let dependency_tree_bytes = bounded_positive(prepared, "treeBytes", MAX_TREE_BYTES)?;
    let dependency_tree_entries = bounded_positive(prepared, "treeEntries", MAX_TREE_ENTRIES)?;
    let dependency_tree_files = bounded_positive(prepared, "treeFiles", MAX_TREE_ENTRIES)?;
    let package_count = bounded_positive(initial, "packageCount", 10_000)?;

    let output_hashes_match = [
        (fetched, "sourceRevision", revision.as_str()),
        (prepared, "sourceRevision", revision.as_str()),
        (prepared_inspection, "sourceRevision", revision.as_str()),
        (source_build_inspection, "sourceRevision", revision.as_str()),
        (conversion, "sourceRevision", revision.as_str()),
        (fetched, "dependencySetIdSha256", set_id.as_str()),
        (prepared, "dependencySetIdSha256", set_id.as_str()),
        (
            prepared_inspection,
            "dependencySetIdSha256",
            set_id.as_str(),
        ),
        (conversion, "dependencySetIdSha256", set_id.as_str()),
        (
            prepared_inspection,
            "dependencyTreeSha256",
            dependency_tree_sha.as_str(),
        ),
        (
            conversion,
            "dependencyTreeSha256",
            dependency_tree_sha.as_str(),
        ),
        (prepared, "nodeBinarySha256", node_sha.as_str()),
        (prepared_inspection, "nodeBinarySha256", node_sha.as_str()),
        (
            prepared,
            "toolchainFingerprintSha256",
            toolchain_sha.as_str(),
        ),
        (
            prepared_inspection,
            "toolchainFingerprintSha256",
            toolchain_sha.as_str(),
        ),
        (
            conversion,
            "toolchainFingerprintSha256",
            toolchain_sha.as_str(),
        ),
    ]
    .iter()
    .all(|(object, field, expected)| object.get(field).and_then(Value::as_str) == Some(*expected));

    if revision != expected_revision
        || fetched.get("status").and_then(Value::as_str) != Some("cached")
        || prepared.get("status").and_then(Value::as_str) != Some("prepared")
        || prepared_inspection.get("status").and_then(Value::as_str) != Some("eligible")
        || prepared_inspection
            .get("dependencySetPrepared")
            .and_then(Value::as_bool)
            != Some(true)
        || source_build_inspection
            .get("status")
            .and_then(Value::as_str)
            != Some("eligible")
        || source_build_inspection
            .get("pluginId")
            .and_then(Value::as_str)
            != Some(case.plugin_id)
        || conversion.get("installed").and_then(Value::as_bool) != Some(true)
        || conversion.get("pluginId").and_then(Value::as_str) != Some(case.plugin_id)
        || conversion
            .get("businessOperationVerified")
            .and_then(Value::as_bool)
            != Some(false)
        || conversion
            .get("dependencyClosureVerified")
            .and_then(Value::as_bool)
            != Some(false)
        || prepared.get("nodeBinaryBytes").and_then(Value::as_u64) != Some(node_bytes)
        || prepared_inspection
            .get("nodeBinaryBytes")
            .and_then(Value::as_u64)
            != Some(node_bytes)
        || prepared.get("toolchainFingerprintSha256")
            != prepared_inspection.get("toolchainFingerprintSha256")
        || prepared_inspection
            .get("dependencyTreeBytes")
            .and_then(Value::as_u64)
            != Some(dependency_tree_bytes)
        || prepared.get("treeEntries").and_then(Value::as_u64) != Some(dependency_tree_entries)
        || prepared.get("treeFiles").and_then(Value::as_u64) != Some(dependency_tree_files)
        || prepared.get("packageCount").and_then(Value::as_u64) != Some(package_count)
        || fetched.get("packageCount").and_then(Value::as_u64) != Some(package_count)
        || !output_hashes_match
    {
        return Err(HandoffFailure::new(
            "task_output_identity",
            "HANDOFF_OUTPUT_CHAIN_MISMATCH",
        ));
    }

    let source = report.get("sourceProvenance").ok_or(HandoffFailure::new(
        "source_identity",
        "HANDOFF_SOURCE_IDENTITY_MISMATCH",
    ))?;
    let source_after = source
        .get("sourceRevisionAfter")
        .and_then(|value| value.get("sha256"))
        .and_then(Value::as_str);
    if source.get("upstreamHead").and_then(Value::as_str) != Some(case.upstream_head)
        || source.get("fileCount").and_then(Value::as_u64) != Some(case.file_count as u64)
        || source.get("bytes").and_then(Value::as_u64) != Some(case.source_bytes)
        || source.get("sourceFilesUnchanged").and_then(Value::as_bool) != Some(true)
        || source.get("manifestSha256").and_then(Value::as_str) != Some(expected_manifest)
        || source.get("inventorySha256").and_then(Value::as_str) != Some(expected_inventory)
        || source.get("sourceRevisionBefore").and_then(Value::as_str) != Some(expected_revision)
        || source_after != Some(expected_revision)
    {
        return Err(HandoffFailure::new(
            "source_identity",
            "HANDOFF_SOURCE_IDENTITY_MISMATCH",
        ));
    }

    Ok(Chain {
        revision,
        set_id,
        node_sha,
        node_bytes,
        toolchain_sha,
        dependency_tree_sha,
        dependency_tree_bytes,
        dependency_tree_entries,
        dependency_tree_files,
        package_count,
        conversion: conversion.clone(),
    })
}

fn require_quiescent_success(report: &Value) -> Result<(), HandoffFailure> {
    let server = report
        .get("server")
        .ok_or(HandoffFailure::new("quiescence", "HANDOFF_NOT_QUIESCENT"))?;
    let scenario = report
        .get("scenario")
        .ok_or(HandoffFailure::new("quiescence", "HANDOFF_NOT_QUIESCENT"))?;
    let rows = server
        .get("taskRunRows")
        .and_then(Value::as_array)
        .ok_or(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ))?;
    let runs = report
        .get("taskRuns")
        .and_then(Value::as_array)
        .ok_or(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ))?;
    if report.get("passed").and_then(Value::as_bool) != Some(true)
        || server.get("cleanupSafe").and_then(Value::as_bool) != Some(true)
        || server.get("taskRunCount").and_then(Value::as_u64) != Some(rows.len() as u64)
        || server.get("allTaskRunsTerminal").and_then(Value::as_bool) != Some(true)
        || server
            .get("taskRunInventoryComplete")
            .and_then(Value::as_bool)
            != Some(true)
        || server
            .get("pendingPermissionRequestCount")
            .and_then(Value::as_u64)
            != Some(0)
        || server.get("activeTaskRunCount").and_then(Value::as_u64) != Some(0)
        || server.get("allLeasesInactive").and_then(Value::as_bool) != Some(true)
        || server.get("clipboardBackendCalls").and_then(Value::as_u64) != Some(0)
        || report
            .pointer("/sourceProvenance/sourceFilesUnchanged")
            .and_then(Value::as_bool)
            != Some(true)
        || scenario
            .get("taskSequenceMatchesExpected")
            .and_then(Value::as_bool)
            != Some(true)
        || scenario
            .get("expectedSequence")
            .and_then(Value::as_array)
            .is_none_or(|sequence| {
                sequence.len() != EXPECTED_TOOLS.len()
                    || sequence
                        .iter()
                        .zip(EXPECTED_TOOLS)
                        .any(|(item, expected)| item.as_str() != Some(expected))
            })
        || scenario.get("completedStages").and_then(Value::as_u64)
            != Some(EXPECTED_TOOLS.len() as u64)
        || scenario
            .get("sourceRevisionMatchesAfter")
            .and_then(Value::as_bool)
            != Some(true)
        || scenario
            .get("businessUsabilityVerified")
            .and_then(Value::as_bool)
            != Some(false)
        || runs.len() != EXPECTED_TOOLS.len()
        || rows.len() != EXPECTED_TOOLS.len() + 1
    {
        return Err(HandoffFailure::new("quiescence", "HANDOFF_NOT_QUIESCENT"));
    }

    let mut inventory = std::collections::BTreeMap::new();
    for row in rows {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_task_id(id))
            .ok_or(HandoffFailure::new(
                "task_inventory",
                "HANDOFF_TASK_INVENTORY_INVALID",
            ))?;
        if inventory.insert(id, row).is_some() {
            return Err(HandoffFailure::new(
                "task_inventory",
                "HANDOFF_TASK_INVENTORY_INVALID",
            ));
        }
    }
    for (index, run) in runs.iter().enumerate() {
        let id = run
            .get("taskRunId")
            .and_then(Value::as_str)
            .filter(|id| valid_task_id(id))
            .ok_or(HandoffFailure::new(
                "task_inventory",
                "HANDOFF_TASK_INVENTORY_INVALID",
            ))?;
        let row = inventory.get(id).ok_or(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ))?;
        if run.get("tool").and_then(Value::as_str) != Some(EXPECTED_TOOLS[index])
            || run.get("status").and_then(Value::as_str) != Some("succeeded")
            || run.get("initiatorType").and_then(Value::as_str) != Some("agent")
            || run.get("clientId").and_then(Value::as_str) != Some(FIXTURE_CLIENT_ID)
            || run.get("inputIdentityMatched").and_then(Value::as_bool) != Some(true)
            || row.get("capabilityId").and_then(Value::as_str) != Some(EXPECTED_TOOLS[index])
            || row.get("status").and_then(Value::as_str) != Some("succeeded")
            || row.get("initiatorType").and_then(Value::as_str) != Some("agent")
            || row.get("clientId").and_then(Value::as_str) != Some(FIXTURE_CLIENT_ID)
        {
            return Err(HandoffFailure::new(
                "task_inventory",
                "HANDOFF_TASK_INVENTORY_INVALID",
            ));
        }
        inventory.remove(id);
    }
    if inventory.len() != 1 {
        return Err(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ));
    }
    let (_, install) = inventory.iter().next().ok_or(HandoffFailure::new(
        "task_inventory",
        "HANDOFF_TASK_INVENTORY_INVALID",
    ))?;
    if install.get("capabilityId").and_then(Value::as_str) != Some(INSTALL_TOOL)
        || install.get("status").and_then(Value::as_str) != Some("succeeded")
        || install.get("initiatorType").and_then(Value::as_str) != Some("human")
        || install.get("clientId").and_then(Value::as_str) != Some("atools-ui")
        || install.get("errorCount").and_then(Value::as_u64) != Some(0)
    {
        return Err(HandoffFailure::new(
            "task_inventory",
            "HANDOFF_TASK_INVENTORY_INVALID",
        ));
    }
    Ok(())
}

fn output(runs: &[Value], index: usize) -> Result<&Value, HandoffFailure> {
    runs.get(index)
        .and_then(|run| run.get("output"))
        .ok_or(HandoffFailure::new(
            "task_output_identity",
            "HANDOFF_OUTPUT_CHAIN_MISMATCH",
        ))
}

fn required_hash(output: &Value, field: &str) -> Result<String, HandoffFailure> {
    output
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .map(str::to_owned)
        .ok_or(HandoffFailure::new(
            "task_output_identity",
            "HANDOFF_OUTPUT_CHAIN_MISMATCH",
        ))
}

fn bounded_positive(output: &Value, field: &str, max: u64) -> Result<u64, HandoffFailure> {
    output
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= max)
        .ok_or(HandoffFailure::new(
            "task_output_identity",
            "HANDOFF_OUTPUT_CHAIN_MISMATCH",
        ))
}

fn valid_task_id(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("run-") else {
        return false;
    };
    uuid.len() == 36
        && uuid.as_bytes()[14] == b'4'
        && matches!(uuid.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        && uuid.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

#[cfg(test)]
#[path = "native_smoke_handoff_tests.rs"]
mod tests;
