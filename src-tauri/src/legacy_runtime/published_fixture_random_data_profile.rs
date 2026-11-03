//! Exact profile gate for the original Random Data package; no runtime authority is granted here.
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(super) const CASE_ID: &str = "local-random-data-head";
const PLUGIN_ID: &str = "random-data";
const VERSION: &str = "1.2.0";
const COMMIT: &str = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
const TREE: &str = "113232c852e07d88dce1e6ba69f3be51ead0f154";
const DIRECTORY_SHA256: &str = "6c62e8d69ff009636fe948694554722556799b4c5721dc865caf637bbaf02c95";
const MANIFEST_SHA256: &str = "b3baead7274dbcd6d6796ae06ff96f5b066e1076de7cc677a88c02a6f79d1ce8";

fn registered_profile() -> Result<Value, String> {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-random-data-cases.json"
    ))
    .map_err(|_| "Invalid Random Data fixture registry")?;
    let cases = registry["cases"]
        .as_array()
        .ok_or("Invalid Random Data fixture cases")?;
    let mut matches = cases.iter().filter(|profile| profile["caseId"] == CASE_ID);
    let profile = matches
        .next()
        .ok_or("Random Data fixture profile is missing")?;
    if matches.next().is_some()
        || cases.len() != 1
        || registry["schemaVersion"] != 1
        || registry["commit"] != COMMIT
        || registry["packageTree"] != TREE
        || profile["id"] != PLUGIN_ID
        || profile["version"] != VERSION
        || profile["sourceKind"] != "local_full_directory"
        || profile["sourceCommit"] != COMMIT
        || profile["sourceTree"] != TREE
        || profile["directorySha256"] != DIRECTORY_SHA256
        || profile["fileCount"] != 7
        || profile["featureCode"] != "randomDataSettings"
        || profile["searchQuery"] != "随机数据设置"
        || profile["title"] != "随机数据"
        || profile["runtime"] != "web"
        || profile["dataAccess"] != true
        || profile["verifyDataPersistence"] != true
        || profile["dialogAccess"] != "none"
        || profile["pathAccess"] != "none"
    {
        return Err("Random Data fixture registry differs from its fixed HEAD identity".into());
    }
    Ok(profile.clone())
}

pub(super) fn reviewed_profile(manifest: &Value) -> Result<Value, String> {
    let bytes = include_bytes!("../../../tests/fixtures/random-data-head-plugin.json");
    if format!("{:x}", Sha256::digest(bytes)) != MANIFEST_SHA256 {
        return Err("Pinned Random Data manifest fixture changed".into());
    }
    let pinned: Value =
        serde_json::from_slice(bytes).map_err(|_| "Invalid pinned Random Data manifest")?;
    if manifest != &pinned {
        return Err(
            "Selected Random Data manifest is not the exact registered original HEAD manifest"
                .into(),
        );
    }
    registered_profile()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Value {
        serde_json::from_slice(include_bytes!(
            "../../../tests/fixtures/random-data-head-plugin.json"
        ))
        .unwrap()
    }

    #[test]
    fn random_data_profile_is_exact_pinned_web_preload_with_data_only_persistence() {
        let profile = reviewed_profile(&manifest()).unwrap();
        assert_eq!(profile["caseId"], CASE_ID);
        assert_eq!(profile["id"], PLUGIN_ID);
        assert_eq!(profile["version"], VERSION);
        assert_eq!(profile["sourceCommit"], COMMIT);
        assert_eq!(profile["sourceTree"], TREE);
        assert_eq!(profile["directorySha256"], DIRECTORY_SHA256);
        assert_eq!(profile["runtime"], "web");
        assert_eq!(profile["dataAccess"], true);
        assert_eq!(profile["verifyDataPersistence"], true);
        assert_eq!(profile["pathAccess"], "none");
    }

    #[test]
    fn random_data_profile_rejects_identity_entry_preload_and_extra_feature_drift() {
        let good = manifest();
        for (key, value) in [
            ("name", serde_json::json!("other")),
            ("version", serde_json::json!("1.2.1")),
            ("title", serde_json::json!("Other")),
            ("main", serde_json::json!("other.html")),
            ("preload", serde_json::json!("other.js")),
        ] {
            let mut changed = good.clone();
            changed[key] = value;
            assert!(reviewed_profile(&changed).is_err(), "{key}");
        }
        let mut extra = good;
        extra["features"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"code":"other"}));
        assert!(reviewed_profile(&extra).is_err(), "extra feature");
    }
}
