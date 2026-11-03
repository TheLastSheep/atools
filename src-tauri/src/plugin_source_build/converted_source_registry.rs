//! Shared path-free pins for converted-source profiles and their retained artifacts.
use serde_json::Value;
use std::sync::OnceLock;

const REGISTRY: &str = include_str!("../../../tests/fixtures/converted-source-cases.json");
const REQUIRED_CASES: [&str; 2] = ["converted-my-calculator-source", "converted-tetris-source"];
const CASES: [&str; 4] = [
    "converted-my-calculator-source",
    "converted-tetris-source",
    "converted-todo-neo-source",
    "converted-deepread-source",
];

static DOCUMENT: OnceLock<Value> = OnceLock::new();

pub(crate) fn profile(case_id: &str) -> Result<Value, String> {
    let (profile, _) = records(case_id)?;
    Ok(profile.clone())
}

pub(crate) fn handoff(case_id: &str) -> Result<Value, String> {
    let (_, handoff) = records(case_id)?;
    Ok(handoff.clone())
}

pub(crate) fn validate_artifact_digest(
    case_id: &str,
    actual: &str,
    expected: &str,
) -> Result<(), String> {
    if actual != expected {
        return Err("CONVERTED_HANDOFF_SHA_MISMATCH".into());
    }
    let pinned = handoff(case_id)?;
    if pinned["manifestSha256"].as_str() != Some(actual) {
        return Err("CONVERTED_HANDOFF_SHA_NOT_PINNED".into());
    }
    Ok(())
}

pub(crate) fn is_case(case_id: &str) -> bool {
    CASES.contains(&case_id)
}

fn records(case_id: &str) -> Result<(&'static Value, &'static Value), String> {
    let document =
        DOCUMENT.get_or_init(|| serde_json::from_str(REGISTRY).unwrap_or_else(|_| Value::Null));
    validate_document(document)?;
    if !CASES.contains(&case_id) {
        return Err("CONVERTED_SOURCE_CASE_UNKNOWN".into());
    }
    let profiles = document["cases"].as_array().ok_or_else(invalid)?;
    let mut selected = profiles.iter().filter(|item| item["caseId"] == case_id);
    let profile = selected.next().ok_or("CONVERTED_SOURCE_CASE_NOT_PINNED")?;
    if selected.next().is_some() {
        return Err("CONVERTED_SOURCE_CASE_DUPLICATE".into());
    }
    let handoff = document["handoffs"]
        .get(case_id)
        .ok_or("CONVERTED_SOURCE_CASE_NOT_PINNED")?;
    validate_pair(case_id, profile, handoff)?;
    Ok((profile, handoff))
}

fn validate_document(document: &Value) -> Result<(), String> {
    exact(document, &["cases", "handoffs", "schemaVersion"])?;
    if document["schemaVersion"] != 2 {
        return Err(invalid());
    }
    let profiles = document["cases"].as_array().ok_or_else(invalid)?;
    let pins = document["handoffs"].as_object().ok_or_else(invalid)?;
    if profiles.len() != pins.len()
        || profiles.len() < REQUIRED_CASES.len()
        || profiles.len() > CASES.len()
    {
        return Err(invalid());
    }
    if pins.keys().any(|id| !CASES.contains(&id.as_str())) {
        return Err(invalid());
    }
    let mut ids = std::collections::BTreeSet::new();
    for profile in profiles {
        let id = profile["caseId"].as_str().ok_or_else(invalid)?;
        if !CASES.contains(&id) || !ids.insert(id) || !pins.contains_key(id) {
            return Err(invalid());
        }
        validate_pair(id, profile, &pins[id])?;
        if profile.to_string().contains("/private/") || pins[id].to_string().contains("/private/") {
            return Err(invalid());
        }
    }
    if REQUIRED_CASES.iter().any(|id| !ids.contains(id)) {
        return Err(invalid());
    }
    Ok(())
}

fn validate_pair(case_id: &str, profile: &Value, pins: &Value) -> Result<(), String> {
    let mut profile_keys = vec![
        "caseId",
        "dataAccess",
        "directorySha256",
        "featureCode",
        "fileCount",
        "frameOperations",
        "id",
        "pathAccess",
        "runtime",
        "searchQuery",
        "sourceKind",
        "title",
        "verifyDataPersistence",
        "version",
    ];
    if case_id == "converted-deepread-source" {
        profile_keys.push("dialogAccess");
    }
    exact(profile, &profile_keys)?;
    let mut pin_keys = vec![
        "archiveBytes",
        "artifactFileName",
        "artifactKind",
        "dependencySetIdSha256",
        "dependencyTreeBytes",
        "dependencyTreeEntries",
        "dependencyTreeFiles",
        "dependencyTreeSha256",
        "handoffStatus",
        "installedPackageTreeSha256",
        "manifestSha256",
        "nativeUiConsumerSupported",
        "nodeBinaryBytes",
        "nodeBinarySha256",
        "packageCount",
        "planSha256",
        "pluginMain",
        "pluginPreload",
        "preparedFileCount",
        "preparedManifestSha256",
        "skippedOptionalCount",
        "sourceBytes",
        "sourceCaseId",
        "sourceFileCount",
        "sourceInventorySha256",
        "sourceManifestSha256",
        "sourceRevision",
        "toolchainFingerprintSha256",
        "treeBytes",
        "treeEntries",
        "treeFiles",
        "unpackedBytes",
        "upstreamHead",
        "fetchedArchiveCount",
    ];
    if case_id == "converted-deepread-source" {
        pin_keys.push("selectedPublicManifestSha256");
    }
    exact(pins, &pin_keys)?;
    let expected = match case_id {
        "converted-my-calculator-source" => (
            "my-calculator",
            "1.0.1",
            "converted_ui_handoff_v1",
            "ready_for_native_ui_fixture",
            true,
            "fixed-head-my-calculator",
        ),
        "converted-tetris-source" => (
            "tetris",
            "1.0.0",
            "converted_source_evidence",
            "conversion_evidence_only",
            false,
            "fixed-head-tetris",
        ),
        "converted-todo-neo-source" => (
            "todo-neo",
            "0.0.1",
            "converted_source_evidence",
            "conversion_evidence_only",
            false,
            "fixed-head-todo-neo",
        ),
        "converted-deepread-source" => (
            "deepread",
            "1.1.2",
            "converted_source_evidence",
            "conversion_evidence_only",
            false,
            "fixed-head-deepread-public",
        ),
        _ => return Err("CONVERTED_SOURCE_CASE_UNKNOWN".into()),
    };
    let expected_preload = match case_id {
        "converted-my-calculator-source"
        | "converted-todo-neo-source"
        | "converted-deepread-source" => Value::String("preload/services.js".into()),
        "converted-tetris-source" => Value::Null,
        _ => return Err("CONVERTED_SOURCE_CASE_UNKNOWN".into()),
    };
    if profile["caseId"] != case_id
        || profile["id"] != expected.0
        || profile["version"] != expected.1
        || profile["sourceKind"] != "converted_handoff_directory"
        || profile["directorySha256"] != pins["installedPackageTreeSha256"]
        || profile["fileCount"] != pins["treeFiles"]
        || pins["artifactKind"] != expected.2
        || pins["handoffStatus"] != expected.3
        || pins["nativeUiConsumerSupported"] != expected.4
        || pins["sourceCaseId"] != expected.5
        || pins["pluginMain"] != "index.html"
        || pins["pluginPreload"] != expected_preload
        || pins["artifactFileName"]
            != if expected.4 {
                "converted-ui-handoff-v1.json"
            } else {
                "converted-source-evidence-v1.json"
            }
        || !valid_hash(&pins["manifestSha256"])
        || !valid_hash(&pins["sourceRevision"])
        || !valid_hash(&pins["sourceManifestSha256"])
        || !valid_hash(&pins["sourceInventorySha256"])
        || !valid_hash(&pins["dependencySetIdSha256"])
        || !valid_hash(&pins["dependencyTreeSha256"])
        || !valid_hash(&pins["nodeBinarySha256"])
        || !valid_hash(&pins["toolchainFingerprintSha256"])
        || !valid_hash(&pins["installedPackageTreeSha256"])
        || !valid_hash(&pins["planSha256"])
        || !valid_hash(&pins["preparedManifestSha256"])
        || pins["upstreamHead"].as_str().is_none_or(|head| {
            head.len() != 40
                || !head
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        || !positive_integer(&pins["sourceFileCount"])
        || !positive_integer(&pins["sourceBytes"])
        || !positive_integer(&pins["archiveBytes"])
        || !positive_integer(&pins["preparedFileCount"])
        || !positive_integer(&pins["unpackedBytes"])
        || !positive_integer(&pins["fetchedArchiveCount"])
        || !positive_integer(&pins["nodeBinaryBytes"])
        || !positive_integer(&pins["packageCount"])
        || !positive_integer(&pins["dependencyTreeBytes"])
        || !positive_integer(&pins["dependencyTreeEntries"])
        || !positive_integer(&pins["dependencyTreeFiles"])
        || !positive_integer(&pins["treeBytes"])
        || !positive_integer(&pins["treeEntries"])
        || !positive_integer(&pins["treeFiles"])
    {
        return Err(invalid());
    }
    if case_id == CASES[1]
        && (profile["runtime"] != "web"
            || profile["dataAccess"] != true
            || profile["pathAccess"] != "none"
            || profile["featureCode"] != "tetris"
            || profile["title"] != "俄罗斯方块"
            || profile["searchQuery"] != "tetris"
            || profile["frameOperations"] != "tests/components/nativeTetrisFrameOperations.js"
            || pins["artifactFileName"] != "converted-source-evidence-v1.json")
    {
        return Err(invalid());
    }
    if case_id == CASES[0]
        && (profile["runtime"] != "node"
            || profile["dataAccess"] != false
            || profile["title"] != "计算器"
            || profile["searchQuery"] != "calc"
            || profile["pathAccess"] != "standard"
            || pins["artifactFileName"] != "converted-ui-handoff-v1.json")
    {
        return Err(invalid());
    }
    if case_id == CASES[2]
        && (profile["runtime"] != "web"
            || profile["dataAccess"] != true
            || profile["pathAccess"] != "none"
            || profile["featureCode"] != "todo"
            || profile["title"] != "Todo"
            || profile["searchQuery"] != "ToDo 待办"
            || profile["verifyDataPersistence"] != true
            || profile["frameOperations"]
                != "tests/components/nativePublishedTodoFrameOperations.js"
            || pins["pluginMain"] != "index.html"
            || pins["pluginPreload"] != "preload/services.js")
    {
        return Err(invalid());
    }
    if case_id == CASES[3]
        && (profile["runtime"] != "web"
            || profile["dataAccess"] != true
            || profile["pathAccess"] != "none"
            || profile["dialogAccess"] != "open"
            || profile["featureCode"] != "deepread"
            || profile["title"] != "DeepRead 深读"
            || profile["searchQuery"] != "DeepRead"
            || profile["verifyDataPersistence"] != true
            || profile["frameOperations"]
                != "tests/components/nativePublishedDeepReadFrameOperations.js"
            || pins["pluginMain"] != "index.html"
            || pins["pluginPreload"] != "preload/services.js"
            || pins["selectedPublicManifestSha256"]
                != "1ad7c1b5ddd7ce687878d8aca0da319d9f75ef6d77e101ed8a706d6a1d268192")
    {
        return Err(invalid());
    }
    Ok(())
}

fn exact(value: &Value, keys: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid());
    }
    Ok(())
}

fn valid_hash(value: &Value) -> bool {
    value.as_str().is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn positive_integer(value: &Value) -> bool {
    value.as_u64().is_some_and(|number| number > 0)
}

fn invalid() -> String {
    "CONVERTED_SOURCE_REGISTRY_INVALID".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn all_profiles_and_handoffs_are_bound_without_private_paths() {
        for id in CASES {
            let profile = profile(id).unwrap();
            let handoff = handoff(id).unwrap();
            assert_eq!(
                profile["directorySha256"],
                handoff["installedPackageTreeSha256"]
            );
            assert_eq!(profile["fileCount"], handoff["treeFiles"]);
            assert!(!profile.to_string().contains("/private/tmp/"));
            assert!(!handoff.to_string().contains("/private/tmp/"));
        }
        let tetris = profile(REQUIRED_CASES[1]).unwrap();
        assert_eq!(tetris["runtime"], "web");
        assert_eq!(tetris["dataAccess"], true);
        assert_eq!(tetris["pathAccess"], "none");
        assert_eq!(
            handoff(CASES[1]).unwrap()["sourceCaseId"],
            "fixed-head-tetris"
        );
    }

    #[test]
    fn unknown_or_duplicate_registry_cases_fail_closed() {
        assert!(profile("converted-unknown").is_err());
        let mut document: Value = serde_json::from_str(REGISTRY).unwrap();
        let duplicate = document["cases"][0].clone();
        document["cases"].as_array_mut().unwrap().push(duplicate);
        assert!(validate_document(&document).is_err());
        assert!(!document.to_string().contains("/private/tmp/"));
    }

    #[test]
    fn todo_record_is_bound_to_real_evidence_but_never_promoted_to_ui_ready() {
        let case = "converted-todo-neo-source";
        assert!(is_case(case));
        let profile = profile(case).unwrap();
        let pins = handoff(case).unwrap();
        assert_eq!(profile["id"], "todo-neo");
        assert_eq!(profile["version"], "0.0.1");
        assert_eq!(profile["runtime"], "web");
        assert_eq!(profile["verifyDataPersistence"], true);
        assert_eq!(
            profile["directorySha256"],
            pins["installedPackageTreeSha256"]
        );
        assert_eq!(pins["sourceCaseId"], "fixed-head-todo-neo");
        assert_eq!(pins["artifactKind"], "converted_source_evidence");
        assert_eq!(pins["handoffStatus"], "conversion_evidence_only");
        assert_eq!(pins["nativeUiConsumerSupported"], false);
        assert_eq!(
            validate_artifact_digest(
                case,
                pins["manifestSha256"].as_str().unwrap(),
                pins["manifestSha256"].as_str().unwrap()
            ),
            Ok(())
        );
        assert!(validate_artifact_digest(case, &"a".repeat(64), &"a".repeat(64)).is_err());
    }

    #[test]
    fn deepread_public_record_keeps_conversion_flags_false_and_separates_import_feature() {
        let case = "converted-deepread-source";
        let profile = profile(case).unwrap();
        let pins = handoff(case).unwrap();
        assert_eq!(profile["id"], "deepread");
        assert_eq!(profile["featureCode"], "deepread");
        assert_eq!(profile["pathAccess"], "none");
        assert_eq!(profile["dialogAccess"], "open");
        assert_eq!(pins["sourceCaseId"], "fixed-head-deepread-public");
        assert_eq!(
            pins["manifestSha256"],
            "bee1ad2c73542544deafd51aaca04d89ccda8fad0da1288ea8183a84f68771bc"
        );
        assert_eq!(pins["nativeUiConsumerSupported"], false);
        assert_eq!(pins["handoffStatus"], "conversion_evidence_only");
        assert_eq!(
            validate_artifact_digest(
                case,
                pins["manifestSha256"].as_str().unwrap(),
                pins["manifestSha256"].as_str().unwrap()
            ),
            Ok(())
        );
    }

    #[test]
    fn deepread_profile_rejects_path_or_dialog_scope_drift() {
        let mut document: Value = serde_json::from_str(REGISTRY).unwrap();
        let index = document["cases"]
            .as_array()
            .unwrap()
            .iter()
            .position(|profile| profile["caseId"] == "converted-deepread-source")
            .unwrap();
        document["cases"][index]["pathAccess"] = json!("standard");
        assert!(validate_document(&document).is_err());
        document["cases"][index]["pathAccess"] = json!("none");
        document["cases"][index]["dialogAccess"] = json!("save");
        assert!(validate_document(&document).is_err());
    }

    #[test]
    fn caller_matching_digest_must_also_match_the_case_artifact_pin() {
        let payload = b"tampered converted handoff payload";
        let caller_digest = format!("{:x}", Sha256::digest(payload));
        for id in CASES {
            let pinned = handoff(id).unwrap()["manifestSha256"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_ne!(caller_digest, pinned);
            assert!(validate_artifact_digest(id, &caller_digest, &caller_digest).is_err());
            validate_artifact_digest(id, &pinned, &pinned).unwrap();
        }
        assert!(validate_artifact_digest(CASES[0], "actual", "different").is_err());
    }
}
