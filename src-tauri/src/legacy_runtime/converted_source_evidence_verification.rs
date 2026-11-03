//! Strict consumer for fixed converted-source evidence artifacts (never UI-ready).
use super::converted_handoff_verification::{self as common, VerifiedHandoff};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const CASE_ID: &str = "converted-tetris-source";
const SOURCE_PATH: &str = "/private/tmp/atools-batch107-root/tetris-head-v1";
const TODO_CASE_ID: &str = "converted-todo-neo-source";
const TODO_SOURCE_PATH: &str = "/private/tmp/atools-batch107-root/todo-neo-head-v1";
const DEEPREAD_CASE_ID: &str = "converted-deepread-source";
const DEEPREAD_SOURCE_PATH: &str =
    "/private/tmp/atools-batch335-deepread-producer/source-fixed-head-v1";
const SEQUENCE: [&str; 6] = [
    "inspect_ztools_source_dependencies",
    "fetch_ztools_source_dependencies",
    "prepare_ztools_source_dependencies",
    "inspect_ztools_source_dependencies",
    "inspect_ztools_source_build",
    "convert_ztools_plugin",
];

fn text<'a>(pins: &'a Value, key: &str) -> &'a str {
    pins[key].as_str().expect("registry string pin")
}
fn number(pins: &Value, key: &str) -> u64 {
    pins[key].as_u64().expect("registry integer pin")
}

pub(super) fn validate_document(
    document: &Value,
    root: &Path,
    raw_sha256: String,
    pins: &Value,
) -> Result<VerifiedHandoff, String> {
    validate_document_for_case(document, root, raw_sha256, pins, CASE_ID, SOURCE_PATH)
}

pub(super) fn validate_todo_document(
    document: &Value,
    root: &Path,
    raw_sha256: String,
    pins: &Value,
) -> Result<VerifiedHandoff, String> {
    validate_document_for_case(
        document,
        root,
        raw_sha256,
        pins,
        TODO_CASE_ID,
        TODO_SOURCE_PATH,
    )
}

pub(super) fn validate_deepread_document(
    document: &Value,
    root: &Path,
    raw_sha256: String,
    pins: &Value,
) -> Result<VerifiedHandoff, String> {
    validate_document_for_case(
        document,
        root,
        raw_sha256,
        pins,
        DEEPREAD_CASE_ID,
        DEEPREAD_SOURCE_PATH,
    )
}

fn validate_document_for_case(
    document: &Value,
    root: &Path,
    raw_sha256: String,
    pins: &Value,
    case_id: &str,
    expected_source_path: &str,
) -> Result<VerifiedHandoff, String> {
    common::exact_keys(
        document,
        &[
            "activeTaskRunCount",
            "allLeasesInactive",
            "appDataRoot",
            "artifactKind",
            "businessUsabilityVerified",
            "conversion",
            "dependencies",
            "expectedSequence",
            "fixtureRoot",
            "handoffStatus",
            "installationTaskRun",
            "installedPackage",
            "installedPackagePath",
            "nativeUiConsumerSupported",
            "pendingPermissionRequestCount",
            "pluginIdentity",
            "schemaVersion",
            "source",
            "sourceCaseId",
            "sourceFilesUnchanged",
            "taskRunCount",
            "taskRuns",
            "taskRunsTerminal",
        ],
    )?;
    let root_text = root.to_str().ok_or("CONVERTED_HANDOFF_PATH_INVALID")?;
    let app_data = root.join("app-data");
    let profile_value = crate::plugin_source_build::converted_source_registry::profile(case_id)?;
    let plugin_id = profile_value["id"]
        .as_str()
        .ok_or("CONVERTED_SOURCE_EVIDENCE_PLUGIN_IDENTITY_INVALID")?;
    let version = profile_value["version"]
        .as_str()
        .ok_or("CONVERTED_SOURCE_EVIDENCE_PLUGIN_IDENTITY_INVALID")?;
    // The source-build producer labels any Electron preload as Node. Todo's UI
    // remains a web runtime: its Electron require is optional and its only
    // ipcRenderer features are disabled in this pinned source.
    let producer_runtime = if matches!(case_id, TODO_CASE_ID | DEEPREAD_CASE_ID) {
        "node"
    } else {
        profile_value["runtime"]
            .as_str()
            .ok_or("CONVERTED_SOURCE_EVIDENCE_PLUGIN_IDENTITY_INVALID")?
    };
    let installed = app_data.join("plugins").join(plugin_id);
    if document["schemaVersion"] != 1
        || document["artifactKind"] != text(pins, "artifactKind")
        || document["sourceCaseId"] != text(pins, "sourceCaseId")
        || document["handoffStatus"] != text(pins, "handoffStatus")
        || document["nativeUiConsumerSupported"] != false
        || pins["nativeUiConsumerSupported"] != false
        || document["businessUsabilityVerified"] != false
        || document["sourceFilesUnchanged"] != true
        || document["taskRunsTerminal"] != true
        || document["pendingPermissionRequestCount"] != 0
        || document["activeTaskRunCount"] != 0
        || document["allLeasesInactive"] != true
        || document["taskRunCount"] != 7
        || document["fixtureRoot"] != root_text
        || document["appDataRoot"] != app_data.to_str().ok_or("CONVERTED_HANDOFF_PATH_INVALID")?
        || document["installedPackagePath"]
            != installed.to_str().ok_or("CONVERTED_HANDOFF_PATH_INVALID")?
        || document["expectedSequence"] != json!(SEQUENCE)
    {
        return Err("CONVERTED_SOURCE_EVIDENCE_STATE_INVALID".into());
    }

    let source = &document["source"];
    common::exact_keys(
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
    if source["path"] != expected_source_path
        || source["upstreamHead"] != text(pins, "upstreamHead")
        || source["manifestSha256"] != text(pins, "sourceManifestSha256")
        || source["inventorySha256"] != text(pins, "sourceInventorySha256")
        || source["sourceRevision"] != text(pins, "sourceRevision")
        || source["fileCount"] != number(pins, "sourceFileCount")
        || source["bytes"] != number(pins, "sourceBytes")
    {
        return Err("CONVERTED_SOURCE_EVIDENCE_SOURCE_INVALID".into());
    }

    let dependencies = &document["dependencies"];
    common::exact_keys(
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
    if dependencies["dependencySetIdSha256"] != text(pins, "dependencySetIdSha256")
        || dependencies["nodeBinarySha256"] != text(pins, "nodeBinarySha256")
        || dependencies["nodeBinaryBytes"] != number(pins, "nodeBinaryBytes")
        || dependencies["toolchainFingerprintSha256"] != text(pins, "toolchainFingerprintSha256")
        || dependencies["packageCount"] != number(pins, "packageCount")
        || dependencies["treeSha256"] != text(pins, "dependencyTreeSha256")
        || dependencies["treeBytes"] != number(pins, "dependencyTreeBytes")
        || dependencies["treeEntries"] != number(pins, "dependencyTreeEntries")
        || dependencies["treeFiles"] != number(pins, "dependencyTreeFiles")
    {
        return Err("CONVERTED_SOURCE_EVIDENCE_DEPENDENCY_IDENTITY_INVALID".into());
    }

    let profile = &document["pluginIdentity"];
    common::exact_keys(
        profile,
        &["featureCode", "id", "main", "preload", "runtime", "version"],
    )?;
    if profile["id"] != plugin_id
        || profile["version"] != version
        || profile["main"] != pins["pluginMain"]
        || profile["preload"] != pins["pluginPreload"]
        || profile["runtime"] != producer_runtime
        || profile["featureCode"] != profile_value["featureCode"]
    {
        return Err("CONVERTED_SOURCE_EVIDENCE_PLUGIN_IDENTITY_INVALID".into());
    }

    let installed_package = &document["installedPackage"];
    common::exact_keys(
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
    if installed_package["pluginId"] != plugin_id
        || installed_package["version"] != version
        || installed_package["treeSha256"] != text(pins, "installedPackageTreeSha256")
        || installed_package["treeEntries"] != number(pins, "treeEntries")
        || installed_package["treeFiles"] != number(pins, "treeFiles")
        || installed_package["treeBytes"] != number(pins, "treeBytes")
    {
        return Err("CONVERTED_SOURCE_EVIDENCE_PACKAGE_IDENTITY_INVALID".into());
    }

    let runs = document["taskRuns"]
        .as_array()
        .ok_or("CONVERTED_SOURCE_EVIDENCE_TASK_RUNS_INVALID")?;
    if runs.len() != SEQUENCE.len() {
        return Err("CONVERTED_SOURCE_EVIDENCE_TASK_RUNS_INVALID".into());
    }
    let installation = &document["installationTaskRun"];
    common::exact_keys(
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
        return Err("CONVERTED_SOURCE_EVIDENCE_INSTALL_RUN_INVALID".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    common::validate_task_id(&installation["taskRunId"], &mut ids)?;
    for (index, run) in runs.iter().enumerate() {
        common::exact_keys(run, &["capabilityId", "output", "status", "taskRunId"])?;
        if run["capabilityId"] != SEQUENCE[index] || run["status"] != "succeeded" {
            return Err("CONVERTED_SOURCE_EVIDENCE_TASK_RUNS_INVALID".into());
        }
        common::validate_task_id(&run["taskRunId"], &mut ids)?;
        validate_output(
            index,
            &run["output"],
            source,
            dependencies,
            pins,
            &profile_value,
            case_id,
        )?;
    }
    let final_run = &runs[5];
    let conversion = &document["conversion"];
    common::exact_keys(
        conversion,
        &["capabilityId", "output", "status", "taskRunId"],
    )?;
    if conversion["capabilityId"] != final_run["capabilityId"]
        || conversion["status"] != final_run["status"]
        || conversion["taskRunId"] != final_run["taskRunId"]
        || conversion["output"] != final_run["output"]
    {
        return Err("CONVERTED_SOURCE_EVIDENCE_CONVERSION_RECORD_MISMATCH".into());
    }

    Ok(VerifiedHandoff {
        case_id: case_id.into(),
        producer_source_case_id: text(pins, "sourceCaseId").into(),
        plugin_id: plugin_id.into(),
        plugin_version: version.into(),
        artifact_kind: text(pins, "artifactKind").into(),
        handoff_status: text(pins, "handoffStatus").into(),
        native_ui_consumer_supported: false,
        fixture_root: root.to_path_buf(),
        installed_package_path: installed,
        manifest_sha256: raw_sha256,
        source_revision: text(pins, "sourceRevision").into(),
        source_manifest_sha256: text(pins, "sourceManifestSha256").into(),
        source_file_count: number(pins, "sourceFileCount"),
        source_bytes: number(pins, "sourceBytes"),
        source_inventory_sha256: text(pins, "sourceInventorySha256").into(),
        dependency_set_id_sha256: text(pins, "dependencySetIdSha256").into(),
        dependency_tree_sha256: text(pins, "dependencyTreeSha256").into(),
        dependency_tree_bytes: number(pins, "dependencyTreeBytes"),
        installed_package_tree_sha256: text(pins, "installedPackageTreeSha256").into(),
        tree_entries: number(pins, "treeEntries"),
        tree_files: number(pins, "treeFiles"),
        tree_bytes: number(pins, "treeBytes"),
    })
}

fn validate_output(
    index: usize,
    output: &Value,
    source: &Value,
    dependencies: &Value,
    pins: &Value,
    profile: &Value,
    case_id: &str,
) -> Result<(), String> {
    let revision = text(pins, "sourceRevision");
    let set = text(pins, "dependencySetIdSha256");
    let node = text(pins, "nodeBinarySha256");
    let toolchain = text(pins, "toolchainFingerprintSha256");
    match index {
        0 | 3 => {
            common::exact_keys(
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
            let prepared = index == 3;
            if output["status"] != "eligible"
                || output["sourceRevision"] != source["sourceRevision"]
                || output["sourceRevision"] != revision
                || output["dependencySetIdSha256"] != set
                || output["nodeBinarySha256"] != node
                || output["nodeBinaryBytes"] != number(pins, "nodeBinaryBytes")
                || output["toolchainFingerprintSha256"] != toolchain
                || output["dependencySetPrepared"] != prepared
                || output["dependencyClosureVerified"] != false
                || output["businessUsabilityVerified"] != false
                || output["lifecyclesSkipped"] != true
                || output["packageCount"] != number(pins, "packageCount")
                || output["planSha256"] != text(pins, "planSha256")
                || output["skippedOptionalCount"] != number(pins, "skippedOptionalCount")
                || output["missingCount"]
                    != if prepared {
                        0
                    } else {
                        number(pins, "packageCount")
                    }
                || output["cachedBytes"]
                    != if prepared {
                        number(pins, "archiveBytes")
                    } else {
                        0
                    }
                || output["archiveBytes"]
                    != if prepared {
                        json!(number(pins, "archiveBytes"))
                    } else {
                        Value::Null
                    }
                || output["target"] != json!({"cpu":"arm64","os":"darwin"})
                || output["toolchainHashElapsedMs"]
                    .as_u64()
                    .is_none_or(|value| value > 120_000)
                || (prepared
                    && (output["dependencyTreeSha256"] != dependencies["treeSha256"]
                        || output["dependencyTreeBytes"] != dependencies["treeBytes"]))
                || (!prepared
                    && (!output["dependencyTreeSha256"].is_null()
                        || !output["dependencyTreeBytes"].is_null()))
            {
                return Err("CONVERTED_SOURCE_EVIDENCE_INSPECTION_INVALID".into());
            }
        }
        1 => {
            common::exact_keys(
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
                || output["sourceRevision"] != revision
                || output["dependencySetIdSha256"] != set
                || output["packageCount"] != number(pins, "packageCount")
                || output["cachedArchiveCount"] != 0
                || output["fetchedArchiveCount"] != number(pins, "fetchedArchiveCount")
                || output["verifiedArchiveBytes"] != number(pins, "archiveBytes")
                || output["dependencySetPrepared"] != false
                || output["businessUsabilityVerified"] != false
                || output["lifecyclesSkipped"] != true
                || output["elapsedMs"]
                    .as_u64()
                    .is_none_or(|value| value > 120_000)
            {
                return Err("CONVERTED_SOURCE_EVIDENCE_FETCH_INVALID".into());
            }
        }
        2 => {
            common::exact_keys(
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
                || output["archiveBytes"] != number(pins, "archiveBytes")
                || output["fileCount"] != number(pins, "preparedFileCount")
                || output["unpackedBytes"] != number(pins, "unpackedBytes")
                || output["manifestSha256"] != text(pins, "preparedManifestSha256")
                || output["sourceRevision"] != revision
                || output["dependencySetIdSha256"] != set
                || output["treeSha256"] != dependencies["treeSha256"]
                || output["treeBytes"] != dependencies["treeBytes"]
                || output["treeEntries"] != dependencies["treeEntries"]
                || output["treeFiles"] != dependencies["treeFiles"]
                || output["nodeBinarySha256"] != node
                || output["nodeBinaryBytes"] != number(pins, "nodeBinaryBytes")
                || output["toolchainFingerprintSha256"] != toolchain
                || output["packageCount"] != number(pins, "packageCount")
                || output["dependencyClosureVerified"] != false
                || output["businessUsabilityVerified"] != false
                || output["toolchainHashElapsedMs"]
                    .as_u64()
                    .is_none_or(|value| value > 120_000)
                || output["workerElapsedMs"]
                    .as_u64()
                    .is_none_or(|value| value > 120_000)
            {
                return Err("CONVERTED_SOURCE_EVIDENCE_PREPARE_INVALID".into());
            }
        }
        4 => {
            if case_id == DEEPREAD_CASE_ID {
                common::exact_keys(
                    output,
                    &[
                        "buildSteps",
                        "manifestSelection",
                        "manifestSha256",
                        "pluginId",
                        "sourceRevision",
                        "status",
                    ],
                )?;
                if output["manifestSelection"] != "public"
                    || output["manifestSha256"] != text(pins, "selectedPublicManifestSha256")
                {
                    return Err("CONVERTED_SOURCE_EVIDENCE_MANIFEST_SELECTION_INVALID".into());
                }
            } else {
                common::exact_keys(
                    output,
                    &["buildSteps", "pluginId", "sourceRevision", "status"],
                )?;
            }
            if output["status"] != "eligible"
                || output["sourceRevision"] != revision
                || output["pluginId"] != profile["id"]
                || output["buildSteps"] != json!([{"kind":"typecheck"},{"kind":"viteBuild"}])
            {
                return Err("CONVERTED_SOURCE_EVIDENCE_BUILD_INSPECTION_INVALID".into());
            }
        }
        5 => {
            if case_id == DEEPREAD_CASE_ID {
                common::exact_keys(
                    output,
                    &[
                        "buildSteps",
                        "businessOperationVerified",
                        "dependencyClosureVerified",
                        "dependencySetIdSha256",
                        "dependencyTreeSha256",
                        "installed",
                        "manifestSelection",
                        "manifestSha256",
                        "pluginId",
                        "sourceRevision",
                        "toolchainFingerprintSha256",
                    ],
                )?;
                if output["manifestSelection"] != "public"
                    || output["manifestSha256"] != text(pins, "selectedPublicManifestSha256")
                {
                    return Err("CONVERTED_SOURCE_EVIDENCE_MANIFEST_SELECTION_INVALID".into());
                }
            } else {
                common::exact_keys(
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
            }
            if output["pluginId"] != profile["id"]
                || output["sourceRevision"] != revision
                || output["dependencySetIdSha256"] != set
                || output["dependencyTreeSha256"] != dependencies["treeSha256"]
                || output["toolchainFingerprintSha256"] != toolchain
                || output["businessOperationVerified"] != false
                || output["dependencyClosureVerified"] != false
                || output["installed"] != true
                || output["buildSteps"] != json!([{"kind":"typecheck"},{"kind":"viteBuild"}])
            {
                return Err("CONVERTED_SOURCE_EVIDENCE_CONVERSION_INVALID".into());
            }
        }
        _ => return Err("CONVERTED_SOURCE_EVIDENCE_TASK_RUNS_INVALID".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn complete_fixture() -> Value {
        let root = "/fixture/tetris";
        let fixture =
            include_str!("../../../tests/fixtures/converted-tetris-evidence-shape-v1.json")
                .replace("__FIXTURE_ROOT__", root)
                .replace("__SOURCE_ROOT__", "/fixture/fixed-head-tetris");
        serde_json::from_str(&fixture).unwrap()
    }

    fn validate_fixture(document: &Value) -> Result<VerifiedHandoff, String> {
        let pins = crate::plugin_source_build::converted_source_registry::handoff(CASE_ID).unwrap();
        validate_document_for_case(
            document,
            Path::new("/fixture/tetris"),
            "a".repeat(64),
            &pins,
            CASE_ID,
            "/fixture/fixed-head-tetris",
        )
    }

    fn todo_fixture() -> Value {
        let fixture =
            include_str!("../../../tests/fixtures/converted-todo-source-evidence-shape-v1.json")
                .replace("__FIXTURE_ROOT__", "/fixture/todo")
                .replace("__SOURCE_ROOT__", "/fixture/fixed-head-todo-neo");
        serde_json::from_str(&fixture).unwrap()
    }

    fn deepread_fixture() -> Value {
        let fixture = include_str!(
            "../../../tests/fixtures/converted-deepread-source-evidence-shape-v1.json"
        )
        .replace("__FIXTURE_ROOT__", "/fixture/deepread")
        .replace("__SOURCE_ROOT__", "/fixture/fixed-head-deepread-public");
        serde_json::from_str(&fixture).unwrap()
    }

    fn validate_deepread_fixture(document: &Value) -> Result<VerifiedHandoff, String> {
        let pins = crate::plugin_source_build::converted_source_registry::handoff(DEEPREAD_CASE_ID)
            .unwrap();
        let raw_sha256 = text(&pins, "manifestSha256").to_owned();
        validate_document_for_case(
            document,
            Path::new("/fixture/deepread"),
            raw_sha256,
            &pins,
            DEEPREAD_CASE_ID,
            "/fixture/fixed-head-deepread-public",
        )
    }

    fn validate_todo_fixture(document: &Value) -> Result<VerifiedHandoff, String> {
        let pins =
            crate::plugin_source_build::converted_source_registry::handoff(TODO_CASE_ID).unwrap();
        let raw_sha256 = text(&pins, "manifestSha256").to_owned();
        // The source-derived fixture sanitizes only private paths and TaskRun IDs;
        // the actual raw artifact SHA remains separately pinned in the registry.
        validate_document_for_case(
            document,
            Path::new("/fixture/todo"),
            raw_sha256,
            &pins,
            TODO_CASE_ID,
            "/fixture/fixed-head-todo-neo",
        )
    }

    #[test]
    fn accepts_complete_fixed_tetris_evidence_shape_without_claiming_ui_readiness() {
        let verified = validate_fixture(&complete_fixture()).unwrap();
        assert_eq!(verified.case_id, CASE_ID);
        assert_eq!(verified.producer_source_case_id, "fixed-head-tetris");
        assert_eq!(verified.plugin_id, "tetris");
        assert_eq!(verified.plugin_version, "1.0.0");
        assert_eq!(
            verified.installed_package_path,
            PathBuf::from("/fixture/tetris/app-data/plugins/tetris")
        );
        assert!(!verified.native_ui_consumer_supported);
    }

    #[test]
    fn accepts_the_complete_todo_success_shape_only_as_conversion_evidence() {
        let verified = validate_todo_fixture(&todo_fixture()).unwrap();
        assert_eq!(verified.case_id, TODO_CASE_ID);
        assert_eq!(verified.producer_source_case_id, "fixed-head-todo-neo");
        assert_eq!(verified.plugin_id, "todo-neo");
        assert_eq!(verified.plugin_version, "0.0.1");
        assert_eq!(
            verified.manifest_sha256,
            "00caf5f09ca76b91aa660e34ff0383bbfe1ec0258dd94d80c98adf7c31e722c9"
        );
        assert_eq!(
            verified.installed_package_tree_sha256,
            "203ea9df26e6be26c4844930b14a6413e59113f5ab571e814d3b96d76de0789f"
        );
        assert_eq!(verified.tree_files, 8);
        assert_eq!(verified.tree_entries, 10);
        assert_eq!(verified.tree_bytes, 1_158_207);
        assert!(!verified.native_ui_consumer_supported);
    }

    #[test]
    fn deepread_success_shape_remains_evidence_only_and_pinned_to_the_public_source() {
        let original = deepread_fixture();
        let verified = validate_deepread_fixture(&original).unwrap();
        assert_eq!(verified.case_id, DEEPREAD_CASE_ID);
        assert_eq!(
            verified.producer_source_case_id,
            "fixed-head-deepread-public"
        );
        assert_eq!(verified.plugin_id, "deepread");
        assert_eq!(verified.plugin_version, "1.1.2");
        assert_eq!(verified.tree_files, 9);
        assert_eq!(verified.tree_bytes, 546293);
        assert!(!verified.native_ui_consumer_supported);
        assert_eq!(original["businessUsabilityVerified"], false);
        assert_eq!(original["nativeUiConsumerSupported"], false);
        let mut cross_case = original.clone();
        cross_case["sourceCaseId"] = json!("fixed-head-todo-neo");
        assert!(validate_deepread_fixture(&cross_case).is_err());
        let mut wrong_inspection = original.clone();
        wrong_inspection["taskRuns"][4]["output"]["manifestSelection"] = json!("root");
        assert!(validate_deepread_fixture(&wrong_inspection).is_err());
        let mut wrong_conversion = original.clone();
        wrong_conversion["taskRuns"][5]["output"]["manifestSha256"] = json!("0".repeat(64));
        wrong_conversion["conversion"]["output"] =
            wrong_conversion["taskRuns"][5]["output"].clone();
        assert!(validate_deepread_fixture(&wrong_conversion).is_err());
        let mut promoted = original;
        promoted["businessUsabilityVerified"] = json!(true);
        assert!(validate_deepread_fixture(&promoted).is_err());
    }

    #[test]
    fn todo_evidence_rejects_cross_case_identity_and_success_flag_drift() {
        let original = todo_fixture();
        let mut cross_case = original.clone();
        cross_case["sourceCaseId"] = json!("fixed-head-tetris");
        assert!(validate_todo_fixture(&cross_case).is_err());
        let mut ui_claim = original.clone();
        ui_claim["nativeUiConsumerSupported"] = json!(true);
        assert!(validate_todo_fixture(&ui_claim).is_err());
        let mut business_claim = original.clone();
        business_claim["businessUsabilityVerified"] = json!(true);
        assert!(validate_todo_fixture(&business_claim).is_err());
        let mut runtime_drift = original.clone();
        runtime_drift["pluginIdentity"]["runtime"] = json!("web");
        assert!(validate_todo_fixture(&runtime_drift).is_err());
        let mut non_quiescent = original;
        non_quiescent["pendingPermissionRequestCount"] = json!(1);
        assert!(validate_todo_fixture(&non_quiescent).is_err());
    }

    #[test]
    fn rejects_cross_case_claims_flags_duplicate_runs_and_non_quiescent_state() {
        let original = complete_fixture();

        let mut cross_case = original.clone();
        cross_case["sourceCaseId"] = json!("fixed-head-my-calculator");
        assert!(validate_fixture(&cross_case).is_err());

        let mut ui_claim = original.clone();
        ui_claim["nativeUiConsumerSupported"] = json!(true);
        assert!(validate_fixture(&ui_claim).is_err());

        let mut business_claim = original.clone();
        business_claim["businessUsabilityVerified"] = json!(true);
        assert!(validate_fixture(&business_claim).is_err());

        let mut duplicate_task = original.clone();
        let import_run_id = duplicate_task["installationTaskRun"]["taskRunId"].clone();
        duplicate_task["taskRuns"][0]["taskRunId"] = import_run_id;
        assert!(validate_fixture(&duplicate_task).is_err());

        let mut unfinished_run = original.clone();
        unfinished_run["taskRuns"][4]["status"] = json!("running");
        assert!(validate_fixture(&unfinished_run).is_err());

        let mut mismatched_revision = original.clone();
        mismatched_revision["taskRuns"][5]["output"]["sourceRevision"] = json!("0".repeat(64));
        assert!(validate_fixture(&mismatched_revision).is_err());

        let mut active = original.clone();
        active["activeTaskRunCount"] = json!(1);
        assert!(validate_fixture(&active).is_err());

        let mut pending = original;
        pending["pendingPermissionRequestCount"] = json!(1);
        assert!(validate_fixture(&pending).is_err());
    }

    #[test]
    fn accepts_fixed_tetris_conversion_without_claiming_business_success() {
        let pins = crate::plugin_source_build::converted_source_registry::handoff(CASE_ID).unwrap();
        let profile =
            crate::plugin_source_build::converted_source_registry::profile(CASE_ID).unwrap();
        let dependencies = json!({"treeSha256":text(&pins,"dependencyTreeSha256"),
            "toolchainFingerprintSha256":text(&pins,"toolchainFingerprintSha256")});
        let output = json!({"buildSteps":[{"kind":"typecheck"},{"kind":"viteBuild"}],
            "businessOperationVerified":false,"dependencyClosureVerified":false,
            "dependencySetIdSha256":text(&pins,"dependencySetIdSha256"),
            "dependencyTreeSha256":text(&pins,"dependencyTreeSha256"),"installed":true,
            "pluginId":profile["id"],"sourceRevision":text(&pins,"sourceRevision"),
            "toolchainFingerprintSha256":text(&pins,"toolchainFingerprintSha256")});
        validate_output(
            5,
            &output,
            &json!({}),
            &dependencies,
            &pins,
            &profile,
            CASE_ID,
        )
        .unwrap();
        let mut false_claim = output;
        false_claim["businessOperationVerified"] = json!(true);
        assert!(validate_output(
            5,
            &false_claim,
            &json!({}),
            &dependencies,
            &pins,
            &profile,
            CASE_ID
        )
        .is_err());
    }
}
