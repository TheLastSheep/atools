//! Strict consumer for the fixed, retained source-build handoff used by the native UI fixture.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

const SOURCE_PATH: &str = "/private/tmp/atools-batch107-root/my-calculator-head-v1";
const CALCULATOR_CASE: &str = "converted-my-calculator-source";
const TODO_CASE: &str = "converted-todo-neo-source";
const DEEPREAD_CASE: &str = "converted-deepread-source";

fn calculator_pins() -> &'static Value {
    use std::sync::OnceLock;
    static PINS: OnceLock<Value> = OnceLock::new();
    PINS.get_or_init(|| {
        crate::plugin_source_build::converted_source_registry::handoff(CALCULATOR_CASE)
            .expect("the checked-in converted-source registry must validate")
    })
}
fn calculator_profile() -> &'static Value {
    use std::sync::OnceLock;
    static PROFILE: OnceLock<Value> = OnceLock::new();
    PROFILE.get_or_init(|| {
        crate::plugin_source_build::converted_source_registry::profile(CALCULATOR_CASE)
            .expect("the checked-in converted-source registry must validate")
    })
}
fn pin_str(key: &str) -> &'static str {
    calculator_pins()[key]
        .as_str()
        .expect("valid pinned string")
}
fn pin_num(key: &str) -> u64 {
    calculator_pins()[key]
        .as_u64()
        .expect("valid pinned integer")
}
fn profile_str(key: &str) -> &'static str {
    calculator_profile()[key]
        .as_str()
        .expect("valid profile string")
}

const EXPECTED_SEQUENCE: [&str; 6] = [
    "inspect_ztools_source_dependencies",
    "fetch_ztools_source_dependencies",
    "prepare_ztools_source_dependencies",
    "inspect_ztools_source_dependencies",
    "inspect_ztools_source_build",
    "convert_ztools_plugin",
];

#[derive(Clone, Debug)]
pub(super) struct VerifiedHandoff {
    pub case_id: String,
    pub producer_source_case_id: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub artifact_kind: String,
    pub handoff_status: String,
    pub native_ui_consumer_supported: bool,
    pub fixture_root: PathBuf,
    pub installed_package_path: PathBuf,
    pub manifest_sha256: String,
    pub source_revision: String,
    pub source_manifest_sha256: String,
    pub source_file_count: u64,
    pub source_bytes: u64,
    pub source_inventory_sha256: String,
    pub dependency_set_id_sha256: String,
    pub dependency_tree_sha256: String,
    pub dependency_tree_bytes: u64,
    pub installed_package_tree_sha256: String,
    pub tree_entries: u64,
    pub tree_files: u64,
    pub tree_bytes: u64,
}

pub(super) fn verify(
    manifest_path: &Path,
    expected_sha256: &str,
    case_id: &str,
) -> Result<VerifiedHandoff, String> {
    if !valid_sha256(expected_sha256) {
        return Err("CONVERTED_HANDOFF_EXPECTED_SHA_INVALID".into());
    }
    let pins = crate::plugin_source_build::converted_source_registry::handoff(case_id)?;
    let handoff_file = pins["artifactFileName"]
        .as_str()
        .ok_or("CONVERTED_HANDOFF_CASE_INVALID")?;
    let file_name = manifest_path.file_name().and_then(|name| name.to_str());
    if file_name != Some(handoff_file) || !manifest_path.is_absolute() {
        return Err("CONVERTED_HANDOFF_PATH_INVALID".into());
    }
    let root = manifest_path
        .parent()
        .ok_or("CONVERTED_HANDOFF_PATH_INVALID")?;
    validate_fixture_root(root)?;
    if manifest_path != root.join(handoff_file) {
        return Err("CONVERTED_HANDOFF_PATH_INVALID".into());
    }
    let bytes = match pins["artifactKind"].as_str() {
        Some("converted_ui_handoff_v1") if case_id == CALCULATOR_CASE => {
            crate::read_converted_handoff(root)?
        }
        Some("converted_source_evidence")
            if matches!(
                case_id,
                "converted-tetris-source" | TODO_CASE | DEEPREAD_CASE
            ) =>
        {
            crate::plugin_source_build::read_converted_source_evidence(root)?
        }
        _ => return Err("CONVERTED_HANDOFF_CASE_INVALID".into()),
    };
    let actual_sha256 = digest(&bytes);
    crate::plugin_source_build::converted_source_registry::validate_artifact_digest(
        case_id,
        &actual_sha256,
        expected_sha256,
    )?;
    let document: Value =
        serde_json::from_slice(&bytes).map_err(|_| "CONVERTED_HANDOFF_JSON_INVALID")?;
    let verified = if case_id == CALCULATOR_CASE {
        validate_document(&document, root, actual_sha256)?
    } else if case_id == TODO_CASE {
        super::converted_source_evidence_verification::validate_todo_document(
            &document,
            root,
            actual_sha256,
            &pins,
        )?
    } else if case_id == DEEPREAD_CASE {
        super::converted_source_evidence_verification::validate_deepread_document(
            &document,
            root,
            actual_sha256,
            &pins,
        )?
    } else {
        super::converted_source_evidence_verification::validate_document(
            &document,
            root,
            actual_sha256,
            &pins,
        )?
    };
    let tree = crate::calculate_converted_package_tree(&verified.installed_package_path)?;
    if tree.sha256 != verified.installed_package_tree_sha256
        || tree.entries != verified.tree_entries
        || tree.files != verified.tree_files
        || tree.bytes != verified.tree_bytes
    {
        return Err("CONVERTED_HANDOFF_INSTALLED_TREE_MISMATCH".into());
    }
    Ok(verified)
}

pub(super) fn validate_fixture_root(root: &Path) -> Result<(), String> {
    let mut components = root.components();
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err("CONVERTED_HANDOFF_PATH_INVALID".into());
    }
    let parts: Result<Vec<_>, _> = components
        .map(|component| {
            component
                .as_os_str()
                .to_str()
                .ok_or("CONVERTED_HANDOFF_PATH_INVALID")
        })
        .collect();
    let parts = parts?;
    if parts.len() != 3
        || parts[0] != "private"
        || parts[1] != "tmp"
        || !parts[2].starts_with("atools-batch235-")
        || parts[2].len() > 128
        || !parts[2]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("CONVERTED_HANDOFF_PATH_INVALID".into());
    }
    Ok(())
}

fn validate_document(
    document: &Value,
    root: &Path,
    raw_sha256: String,
) -> Result<VerifiedHandoff, String> {
    exact_keys(
        document,
        &[
            "activeTaskRunCount",
            "allLeasesInactive",
            "appDataRoot",
            "businessUsabilityVerified",
            "conversion",
            "dependencies",
            "expectedSequence",
            "fixtureRoot",
            "handoffStatus",
            "installedPackage",
            "installedPackagePath",
            "installationTaskRun",
            "pendingPermissionRequestCount",
            "schemaVersion",
            "source",
            "sourceFilesUnchanged",
            "taskRunCount",
            "taskRuns",
            "taskRunsTerminal",
        ],
    )?;
    let root_text = root.to_str().ok_or("CONVERTED_HANDOFF_PATH_INVALID")?;
    let app_data = root.join("app-data");
    let installed = app_data.join("plugins").join(profile_str("id"));
    if document["schemaVersion"] != 1
        || document["handoffStatus"] != pin_str("handoffStatus")
        || document["businessUsabilityVerified"] != false
        || document["sourceFilesUnchanged"] != true
        || document["taskRunsTerminal"] != true
        || document["pendingPermissionRequestCount"] != 0
        || document["activeTaskRunCount"] != 0
        || document["allLeasesInactive"] != true
        || document["taskRunCount"] != (EXPECTED_SEQUENCE.len() + 1)
        || document["fixtureRoot"] != root_text
        || document["appDataRoot"] != app_data.to_str().ok_or("CONVERTED_HANDOFF_PATH_INVALID")?
        || document["installedPackagePath"]
            != installed.to_str().ok_or("CONVERTED_HANDOFF_PATH_INVALID")?
        || document["expectedSequence"] != json!(EXPECTED_SEQUENCE)
    {
        return Err("CONVERTED_HANDOFF_STATE_INVALID".into());
    }
    validate_source(&document["source"])?;
    validate_dependencies(&document["dependencies"])?;
    validate_task_runs(
        &document["taskRuns"],
        &document["installationTaskRun"],
        &document["source"],
        &document["dependencies"],
    )?;
    let final_run = document["taskRuns"]
        .as_array()
        .and_then(|runs| runs.get(5))
        .ok_or("CONVERTED_HANDOFF_TASK_RUNS_INVALID")?;
    validate_conversion_record(&document["conversion"], final_run)?;
    let installed_package = &document["installedPackage"];
    exact_keys(
        installed_package,
        &[
            "pluginId",
            "treeBytes",
            "treeEntries",
            "treeFiles",
            "treeSha256",
            "version",
        ],
    )?;
    if installed_package["pluginId"] != profile_str("id")
        || installed_package["version"] != profile_str("version")
        || installed_package["treeSha256"] != pin_str("installedPackageTreeSha256")
        || installed_package["treeFiles"] != pin_num("treeFiles")
        || installed_package["treeEntries"] != pin_num("treeEntries")
        || installed_package["treeBytes"] != pin_num("treeBytes")
    {
        return Err("CONVERTED_HANDOFF_PACKAGE_IDENTITY_INVALID".into());
    }
    Ok(VerifiedHandoff {
        case_id: CALCULATOR_CASE.into(),
        producer_source_case_id: pin_str("sourceCaseId").into(),
        plugin_id: profile_str("id").into(),
        plugin_version: profile_str("version").into(),
        artifact_kind: pin_str("artifactKind").into(),
        handoff_status: pin_str("handoffStatus").into(),
        native_ui_consumer_supported: true,
        fixture_root: root.to_path_buf(),
        installed_package_path: installed,
        manifest_sha256: raw_sha256,
        source_revision: pin_str("sourceRevision").into(),
        source_manifest_sha256: pin_str("sourceManifestSha256").into(),
        source_file_count: document["source"]["fileCount"]
            .as_u64()
            .ok_or("CONVERTED_HANDOFF_SOURCE_INVALID")?,
        source_bytes: document["source"]["bytes"]
            .as_u64()
            .ok_or("CONVERTED_HANDOFF_SOURCE_INVALID")?,
        source_inventory_sha256: pin_str("sourceInventorySha256").into(),
        dependency_set_id_sha256: pin_str("dependencySetIdSha256").into(),
        dependency_tree_sha256: pin_str("dependencyTreeSha256").into(),
        dependency_tree_bytes: pin_num("dependencyTreeBytes"),
        installed_package_tree_sha256: installed_package["treeSha256"].as_str().unwrap().to_owned(),
        tree_entries: installed_package["treeEntries"].as_u64().unwrap(),
        tree_files: installed_package["treeFiles"].as_u64().unwrap(),
        tree_bytes: installed_package["treeBytes"].as_u64().unwrap(),
    })
}

fn validate_conversion_record(conversion: &Value, final_run: &Value) -> Result<(), String> {
    exact_keys(
        conversion,
        &["capabilityId", "output", "status", "taskRunId"],
    )?;
    if conversion["capabilityId"] != final_run["capabilityId"]
        || conversion["status"] != final_run["status"]
        || conversion["taskRunId"] != final_run["taskRunId"]
        || conversion["output"] != final_run["output"]
    {
        return Err("CONVERTED_HANDOFF_CONVERSION_RECORD_MISMATCH".into());
    }
    Ok(())
}

fn validate_source(source: &Value) -> Result<(), String> {
    exact_keys(
        source,
        &[
            "bytes",
            "fileCount",
            "inventorySha256",
            "manifestSha256",
            "path",
            "sourceRevision",
            "upstreamHead",
        ],
    )?;
    let source_path = source["path"]
        .as_str()
        .ok_or("CONVERTED_HANDOFF_SOURCE_INVALID")?;
    let path = Path::new(source_path);
    if source_path != SOURCE_PATH
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        || source["sourceRevision"] != pin_str("sourceRevision")
        || source["manifestSha256"] != pin_str("sourceManifestSha256")
        || source["inventorySha256"] != pin_str("sourceInventorySha256")
        || source["upstreamHead"] != pin_str("upstreamHead")
        || source["fileCount"] != pin_num("sourceFileCount")
        || source["bytes"] != pin_num("sourceBytes")
    {
        return Err("CONVERTED_HANDOFF_SOURCE_INVALID".into());
    }
    Ok(())
}

fn validate_dependencies(dependencies: &Value) -> Result<(), String> {
    exact_keys(
        dependencies,
        &[
            "dependencySetIdSha256",
            "nodeBinaryBytes",
            "nodeBinarySha256",
            "packageCount",
            "toolchainFingerprintSha256",
            "treeBytes",
            "treeEntries",
            "treeFiles",
            "treeSha256",
        ],
    )?;
    if dependencies["dependencySetIdSha256"] != pin_str("dependencySetIdSha256")
        || dependencies["treeSha256"] != pin_str("dependencyTreeSha256")
        || dependencies["treeBytes"] != pin_num("dependencyTreeBytes")
        || dependencies["treeEntries"] != pin_num("dependencyTreeEntries")
        || dependencies["treeFiles"] != pin_num("dependencyTreeFiles")
        || dependencies["nodeBinarySha256"] != pin_str("nodeBinarySha256")
        || dependencies["nodeBinaryBytes"] != pin_num("nodeBinaryBytes")
        || dependencies["toolchainFingerprintSha256"] != pin_str("toolchainFingerprintSha256")
        || dependencies["packageCount"] != pin_num("packageCount")
    {
        return Err("CONVERTED_HANDOFF_DEPENDENCY_IDENTITY_INVALID".into());
    }
    Ok(())
}

fn validate_task_runs(
    task_runs: &Value,
    installation: &Value,
    source: &Value,
    dependencies: &Value,
) -> Result<(), String> {
    exact_keys(
        installation,
        &[
            "capabilityId",
            "clientId",
            "initiatorType",
            "status",
            "taskRunId",
        ],
    )?;
    if installation["capabilityId"] != "atools-ui.plugin.import"
        || installation["clientId"] != "atools-ui"
        || installation["initiatorType"] != "human"
        || installation["status"] != "succeeded"
    {
        return Err("CONVERTED_HANDOFF_INSTALL_RUN_INVALID".into());
    }
    let runs = task_runs
        .as_array()
        .ok_or("CONVERTED_HANDOFF_TASK_RUNS_INVALID")?;
    if runs.len() != EXPECTED_SEQUENCE.len() {
        return Err("CONVERTED_HANDOFF_TASK_RUNS_INVALID".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    validate_task_id(&installation["taskRunId"], &mut ids)?;
    for (index, expected) in EXPECTED_SEQUENCE.iter().enumerate() {
        let run = &runs[index];
        exact_keys(run, &["capabilityId", "output", "status", "taskRunId"])?;
        if run["capabilityId"] != *expected || run["status"] != "succeeded" {
            return Err("CONVERTED_HANDOFF_TASK_RUNS_INVALID".into());
        }
        validate_task_id(&run["taskRunId"], &mut ids)?;
        let output = &run["output"];
        match index {
            0 | 3 => validate_dependency_inspection(output, index == 3, source, dependencies)?,
            1 => validate_fetch(output, source, dependencies)?,
            2 => validate_prepare(output, source, dependencies)?,
            4 => validate_build_inspection(output, source)?,
            5 => validate_conversion(output, source, dependencies)?,
            _ => unreachable!(),
        }
    }
    Ok(())
}

fn validate_dependency_inspection(
    output: &Value,
    prepared: bool,
    source: &Value,
    dependencies: &Value,
) -> Result<(), String> {
    exact_keys(
        output,
        &[
            "archiveBytes",
            "businessUsabilityVerified",
            "cachedBytes",
            "dependencyClosureVerified",
            "dependencySetIdSha256",
            "dependencySetPrepared",
            "dependencyTreeBytes",
            "dependencyTreeSha256",
            "lifecyclesSkipped",
            "missingCount",
            "nodeBinaryBytes",
            "nodeBinarySha256",
            "packageCount",
            "planSha256",
            "skippedOptionalCount",
            "sourceRevision",
            "status",
            "target",
            "toolchainFingerprintSha256",
            "toolchainHashElapsedMs",
        ],
    )?;
    if output["status"] != "eligible"
        || output["sourceRevision"] != source["sourceRevision"]
        || output["dependencySetIdSha256"] != dependencies["dependencySetIdSha256"]
        || output["planSha256"] != pin_str("planSha256")
        || output["nodeBinarySha256"] != dependencies["nodeBinarySha256"]
        || output["nodeBinaryBytes"] != dependencies["nodeBinaryBytes"]
        || output["toolchainFingerprintSha256"] != dependencies["toolchainFingerprintSha256"]
        || output["dependencySetPrepared"] != prepared
        || output["toolchainHashElapsedMs"]
            .as_u64()
            .is_none_or(|ms| ms > 120_000)
        || output["dependencyClosureVerified"] != false
        || output["businessUsabilityVerified"] != false
        || output["lifecyclesSkipped"] != true
        || output["packageCount"] != pin_num("packageCount")
        || output["planSha256"] != pin_str("planSha256")
        || output["skippedOptionalCount"] != pin_num("skippedOptionalCount")
        || output["missingCount"] != if prepared { 0 } else { pin_num("packageCount") }
        || output["cachedBytes"]
            != if prepared {
                json!(pin_num("archiveBytes"))
            } else {
                json!(0)
            }
        || output["archiveBytes"]
            != if prepared {
                json!(pin_num("archiveBytes"))
            } else {
                Value::Null
            }
        || output["target"] != json!({"cpu":"arm64","os":"darwin"})
        || (prepared
            && (output["dependencyTreeSha256"] != dependencies["treeSha256"]
                || output["dependencyTreeBytes"] != dependencies["treeBytes"]))
        || (!prepared
            && (!output["dependencyTreeSha256"].is_null()
                || !output["dependencyTreeBytes"].is_null()))
    {
        return Err("CONVERTED_HANDOFF_DEPENDENCY_INSPECTION_INVALID".into());
    }
    Ok(())
}

fn validate_fetch(output: &Value, source: &Value, dependencies: &Value) -> Result<(), String> {
    exact_keys(
        output,
        &[
            "businessUsabilityVerified",
            "cachedArchiveCount",
            "dependencySetIdSha256",
            "dependencySetPrepared",
            "elapsedMs",
            "fetchedArchiveCount",
            "lifecyclesSkipped",
            "packageCount",
            "sourceRevision",
            "status",
            "verifiedArchiveBytes",
        ],
    )?;
    if output["status"] != "cached"
        || output["elapsedMs"].as_u64().is_none_or(|ms| ms > 120_000)
        || output["sourceRevision"] != source["sourceRevision"]
        || output["dependencySetIdSha256"] != dependencies["dependencySetIdSha256"]
        || output["packageCount"] != pin_num("packageCount")
        || output["cachedArchiveCount"] != 0
        || output["fetchedArchiveCount"] != pin_num("fetchedArchiveCount")
        || output["verifiedArchiveBytes"] != pin_num("archiveBytes")
        || output["dependencySetPrepared"] != false
        || output["businessUsabilityVerified"] != false
        || output["lifecyclesSkipped"] != true
    {
        return Err("CONVERTED_HANDOFF_FETCH_INVALID".into());
    }
    Ok(())
}

fn validate_prepare(output: &Value, source: &Value, dependencies: &Value) -> Result<(), String> {
    exact_keys(
        output,
        &[
            "archiveBytes",
            "businessUsabilityVerified",
            "dependencyClosureVerified",
            "dependencySetIdSha256",
            "fileCount",
            "manifestSha256",
            "nodeBinaryBytes",
            "nodeBinarySha256",
            "packageCount",
            "sourceRevision",
            "status",
            "toolchainFingerprintSha256",
            "toolchainHashElapsedMs",
            "treeBytes",
            "treeEntries",
            "treeFiles",
            "treeSha256",
            "unpackedBytes",
            "workerElapsedMs",
        ],
    )?;
    if output["status"] != "prepared"
        || output["archiveBytes"] != pin_num("archiveBytes")
        || output["fileCount"] != pin_num("preparedFileCount")
        || output["unpackedBytes"] != pin_num("unpackedBytes")
        || output["manifestSha256"] != pin_str("preparedManifestSha256")
        || output["sourceRevision"] != source["sourceRevision"]
        || output["dependencySetIdSha256"] != dependencies["dependencySetIdSha256"]
        || output["treeSha256"] != dependencies["treeSha256"]
        || output["treeBytes"] != dependencies["treeBytes"]
        || output["treeEntries"] != dependencies["treeEntries"]
        || output["treeFiles"] != dependencies["treeFiles"]
        || output["nodeBinarySha256"] != dependencies["nodeBinarySha256"]
        || output["nodeBinaryBytes"] != dependencies["nodeBinaryBytes"]
        || output["toolchainFingerprintSha256"] != dependencies["toolchainFingerprintSha256"]
        || output["packageCount"] != pin_num("packageCount")
        || output["archiveBytes"] != pin_num("archiveBytes")
        || output["fileCount"] != pin_num("preparedFileCount")
        || output["unpackedBytes"] != pin_num("unpackedBytes")
        || output["toolchainHashElapsedMs"]
            .as_u64()
            .is_none_or(|ms| ms > 120_000)
        || output["workerElapsedMs"]
            .as_u64()
            .is_none_or(|ms| ms > 120_000)
        || output["dependencyClosureVerified"] != false
        || output["businessUsabilityVerified"] != false
    {
        return Err("CONVERTED_HANDOFF_PREPARE_INVALID".into());
    }
    Ok(())
}

fn validate_build_inspection(output: &Value, source: &Value) -> Result<(), String> {
    exact_keys(
        output,
        &["buildSteps", "pluginId", "sourceRevision", "status"],
    )?;
    if output["status"] != "eligible"
        || output["sourceRevision"] != source["sourceRevision"]
        || output["pluginId"] != profile_str("id")
        || output["buildSteps"] != json!([{"kind":"typecheck"},{"kind":"viteBuild"}])
    {
        return Err("CONVERTED_HANDOFF_BUILD_INSPECTION_INVALID".into());
    }
    Ok(())
}

fn validate_conversion(output: &Value, source: &Value, dependencies: &Value) -> Result<(), String> {
    exact_keys(
        output,
        &[
            "buildSteps",
            "businessOperationVerified",
            "dependencyClosureVerified",
            "dependencySetIdSha256",
            "dependencyTreeSha256",
            "installed",
            "pluginId",
            "sourceRevision",
            "toolchainFingerprintSha256",
        ],
    )?;
    if output["pluginId"] != profile_str("id")
        || output["sourceRevision"] != source["sourceRevision"]
        || output["dependencySetIdSha256"] != dependencies["dependencySetIdSha256"]
        || output["dependencyTreeSha256"] != dependencies["treeSha256"]
        || output["toolchainFingerprintSha256"] != dependencies["toolchainFingerprintSha256"]
        || output["businessOperationVerified"] != false
        || output["dependencyClosureVerified"] != false
        || output["installed"] != true
        || output["buildSteps"] != json!([{"kind":"typecheck"},{"kind":"viteBuild"}])
    {
        return Err("CONVERTED_HANDOFF_CONVERSION_INVALID".into());
    }
    Ok(())
}

pub(super) fn validate_task_id(
    value: &Value,
    unique: &mut std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let value = value.as_str().ok_or("CONVERTED_HANDOFF_TASK_ID_INVALID")?;
    let Some(uuid) = value.strip_prefix("run-") else {
        return Err("CONVERTED_HANDOFF_TASK_ID_INVALID".into());
    };
    let parsed = uuid::Uuid::parse_str(uuid).map_err(|_| "CONVERTED_HANDOFF_TASK_ID_INVALID")?;
    if parsed.hyphenated().to_string() != uuid
        || parsed.get_version() != Some(uuid::Version::Random)
        || !unique.insert(value.to_owned())
    {
        return Err("CONVERTED_HANDOFF_TASK_ID_INVALID".into());
    }
    Ok(())
}

pub(super) fn exact_keys(value: &Value, expected: &[&str]) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("CONVERTED_HANDOFF_SCHEMA_INVALID")?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err("CONVERTED_HANDOFF_SCHEMA_INVALID".into());
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn fixture_metadata(handoff: &VerifiedHandoff) -> Value {
    json!({"caseId":handoff.case_id,"sourceCaseId":handoff.producer_source_case_id,
        "artifactKind":handoff.artifact_kind,"handoffStatus":handoff.handoff_status,
        "nativeUiConsumerSupported":handoff.native_ui_consumer_supported,
        "manifestSha256":handoff.manifest_sha256,
        "source":{"sourceRevision":handoff.source_revision,"manifestSha256":handoff.source_manifest_sha256,
            "fileCount":handoff.source_file_count,"bytes":handoff.source_bytes,
            "inventorySha256":handoff.source_inventory_sha256},
        "sourceRevision":handoff.source_revision,
        "dependencySetIdSha256":handoff.dependency_set_id_sha256,
        "dependencyTreeSha256":handoff.dependency_tree_sha256,
        "dependencyTreeBytes":handoff.dependency_tree_bytes,
        "installedPackageTreeSha256":handoff.installed_package_tree_sha256,
        "treeEntries":handoff.tree_entries,"treeFiles":handoff.tree_files,"treeBytes":handoff.tree_bytes,
        "businessUsabilityVerified":false,"conversionSourceProvenanceUnchanged":true})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn representative(root: &Path) -> Value {
        let source = json!({"bytes":722589,"fileCount":32,"inventorySha256":pin_str("sourceInventorySha256"),
            "manifestSha256":pin_str("sourceManifestSha256"),"path":"/private/tmp/atools-batch107-root/my-calculator-head-v1",
            "sourceRevision":pin_str("sourceRevision"),"upstreamHead":pin_str("upstreamHead")});
        let dependencies = json!({"dependencySetIdSha256":pin_str("dependencySetIdSha256"),"nodeBinaryBytes":pin_num("nodeBinaryBytes"),
            "nodeBinarySha256":pin_str("nodeBinarySha256"),"packageCount":70,"toolchainFingerprintSha256":pin_str("toolchainFingerprintSha256"),
            "treeBytes":pin_num("dependencyTreeBytes"),"treeEntries":pin_num("dependencyTreeEntries"),"treeFiles":pin_num("dependencyTreeFiles"),
            "treeSha256":pin_str("dependencyTreeSha256")});
        let inspect = |prepared: bool| {
            json!({"archiveBytes":if prepared {json!(14578697)} else {Value::Null},
            "businessUsabilityVerified":false,"cachedBytes":if prepared {json!(14578697)} else {json!(0)},
            "dependencyClosureVerified":false,"dependencySetIdSha256":pin_str("dependencySetIdSha256"),
            "dependencySetPrepared":prepared,"dependencyTreeBytes":if prepared {json!(pin_num("dependencyTreeBytes"))} else {Value::Null},
            "dependencyTreeSha256":if prepared {json!(pin_str("dependencyTreeSha256"))} else {Value::Null},"lifecyclesSkipped":true,
            "missingCount":if prepared {json!(0)} else {json!(70)},"nodeBinaryBytes":pin_num("nodeBinaryBytes"),
            "nodeBinarySha256":pin_str("nodeBinarySha256"),"packageCount":70,"planSha256":"9646f6268632e7d3a65e39f4bc6cc007e74476f264695e1b5cadf192a9e3d567",
            "skippedOptionalCount":49,"sourceRevision":pin_str("sourceRevision"),"status":"eligible","target":{"cpu":"arm64","os":"darwin"},
            "toolchainFingerprintSha256":pin_str("toolchainFingerprintSha256"),"toolchainHashElapsedMs":1})
        };
        let task = |id: u8, capability: &str, output: Value| {
            json!({"capabilityId":capability,"output":output,"status":"succeeded",
            "taskRunId":format!("run-00000000-0000-4000-8000-00000000000{id}")})
        };
        let runs = vec![
            task(1, EXPECTED_SEQUENCE[0], inspect(false)),
            task(
                2,
                EXPECTED_SEQUENCE[1],
                json!({"businessUsabilityVerified":false,"cachedArchiveCount":0,
                "dependencySetIdSha256":pin_str("dependencySetIdSha256"),"dependencySetPrepared":false,"elapsedMs":1,
                "fetchedArchiveCount":70,"lifecyclesSkipped":true,"packageCount":70,"sourceRevision":pin_str("sourceRevision"),
                "status":"cached","verifiedArchiveBytes":14578697}),
            ),
            task(
                3,
                EXPECTED_SEQUENCE[2],
                json!({"archiveBytes":14578697,"businessUsabilityVerified":false,
                "dependencyClosureVerified":false,"dependencySetIdSha256":pin_str("dependencySetIdSha256"),"fileCount":2422,
                "manifestSha256":"d2a4b1280e1a1b9ed830ecc7cfccb0cc19fdaa2aaedd9bde964d6146c71f40c6",
                "nodeBinaryBytes":pin_num("nodeBinaryBytes"),"nodeBinarySha256":pin_str("nodeBinarySha256"),"packageCount":70,
                "sourceRevision":pin_str("sourceRevision"),"status":"prepared","toolchainFingerprintSha256":pin_str("toolchainFingerprintSha256"),
                "toolchainHashElapsedMs":1,"treeBytes":pin_num("dependencyTreeBytes"),"treeEntries":pin_num("dependencyTreeEntries"),
                "treeFiles":pin_num("dependencyTreeFiles"),"treeSha256":pin_str("dependencyTreeSha256"),"unpackedBytes":63444422,"workerElapsedMs":1}),
            ),
            task(4, EXPECTED_SEQUENCE[3], inspect(true)),
            task(
                5,
                EXPECTED_SEQUENCE[4],
                json!({"buildSteps":[{"kind":"typecheck"},{"kind":"viteBuild"}],"pluginId":"my-calculator",
                "sourceRevision":pin_str("sourceRevision"),"status":"eligible"}),
            ),
            task(
                6,
                EXPECTED_SEQUENCE[5],
                json!({"buildSteps":[{"kind":"typecheck"},{"kind":"viteBuild"}],"businessOperationVerified":false,
                "dependencyClosureVerified":false,"dependencySetIdSha256":pin_str("dependencySetIdSha256"),
                "dependencyTreeSha256":pin_str("dependencyTreeSha256"),"installed":true,"pluginId":"my-calculator",
                "sourceRevision":pin_str("sourceRevision"),"toolchainFingerprintSha256":pin_str("toolchainFingerprintSha256")}),
            ),
        ];
        json!({"activeTaskRunCount":0,"allLeasesInactive":true,"appDataRoot":root.join("app-data"),
            "businessUsabilityVerified":false,"conversion":{"capabilityId":"convert_ztools_plugin","output":runs[5]["output"],
                "status":"succeeded","taskRunId":runs[5]["taskRunId"]},"dependencies":dependencies,
            "expectedSequence":EXPECTED_SEQUENCE,"fixtureRoot":root,"handoffStatus":"ready_for_native_ui_fixture",
            "installedPackage":{"pluginId":"my-calculator","treeBytes":pin_num("treeBytes"),"treeEntries":pin_num("treeEntries"),"treeFiles":pin_num("treeFiles"),
                "treeSha256":pin_str("installedPackageTreeSha256"),"version":"1.0.1"},
            "installedPackagePath":root.join("app-data/plugins/my-calculator"),
            "installationTaskRun":{"capabilityId":"atools-ui.plugin.import","clientId":"atools-ui","initiatorType":"human",
                "status":"succeeded","taskRunId":"run-00000000-0000-4000-8000-000000000007"},
            "pendingPermissionRequestCount":0,"schemaVersion":1,"source":source,"sourceFilesUnchanged":true,
            "taskRunCount":7,"taskRuns":runs,"taskRunsTerminal":true})
    }

    #[test]
    fn representative_v63_handoff_shape_binds_all_six_operations_and_import() {
        let root = Path::new("/private/tmp/atools-batch235-fixture-test");
        let doc = representative(root);
        let verified = validate_document(&doc, root, "a".repeat(64)).unwrap();
        assert_eq!(
            verified.installed_package_path,
            root.join("app-data/plugins/my-calculator")
        );
        assert_eq!(verified.tree_bytes, pin_num("treeBytes"));
        assert_eq!(
            fixture_metadata(&verified)["businessUsabilityVerified"],
            false
        );
    }

    #[test]
    fn rejects_nonterminal_duplicate_or_mismatched_task_evidence() {
        let root = Path::new("/private/tmp/atools-batch235-fixture-test");
        let mut doc = representative(root);
        doc["taskRuns"][5]["status"] = json!("running");
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
        let mut doc = representative(root);
        doc["taskRuns"][5]["taskRunId"] = doc["taskRuns"][0]["taskRunId"].clone();
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
        let mut doc = representative(root);
        doc["conversion"]["output"]["sourceRevision"] = json!("0".repeat(64));
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
    }

    #[test]
    fn rejects_business_claims_and_extra_public_fields() {
        let root = Path::new("/private/tmp/atools-batch235-fixture-test");
        let mut doc = representative(root);
        doc["businessUsabilityVerified"] = json!(true);
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
        let mut doc = representative(root);
        doc["unexpected"] = json!(true);
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
        let mut doc = representative(root);
        doc["installedPackage"]["treeFiles"] = json!(65);
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
        let mut doc = representative(root);
        doc["conversion"]["taskRunId"] = json!("run-00000000-0000-4000-8000-000000000099");
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
    }

    #[test]
    fn rejects_handoff_with_a_different_source_path() {
        let root = Path::new("/private/tmp/atools-batch235-fixture-test");
        let mut doc = representative(root);
        doc["source"]["path"] = json!("/tmp/other-calculator");
        assert!(validate_document(&doc, root, "a".repeat(64)).is_err());
    }
}
