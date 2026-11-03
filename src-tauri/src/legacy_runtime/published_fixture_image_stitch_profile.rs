//! Exact catalog/profile gate for one Git-HEAD Image Stitch package.
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const CASE_ID: &str = "local-image-stitch-head";
const PLUGIN_ID: &str = "image-stitch";
const VERSION: &str = "1.0.0";
const FEATURE: &str = "image-stitch-files";
const REGISTRY_SHA256: &str = "80d3e8b53684f3cf45371b5945d97e9862d99a1dc3e0378353d61f996ad47bcd";
const MANIFEST_SHA256: &str = "5ad33e18647fd550be3169eca955aa87b2c1f5fb330cbefaac1a94acfdb6e66b";

pub(super) fn page_document_profile_matches(profile: &Value) -> bool {
    profile["caseId"] == CASE_ID
        && profile["id"] == PLUGIN_ID
        && profile["version"] == VERSION
        && profile["featureCode"] == FEATURE
        && profile["runtime"] == "web"
        && profile["dataAccess"] == true
        && profile["dialogAccess"] == "open_and_save"
        && profile["pathAccess"] == "none"
        && profile["verifyDataPersistence"] == false
        && profile["sourceKind"] == "local_full_directory"
        && profile["sourceCommit"] == "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
        && profile["sourceTree"] == "629b6c70b86f28d8f775ced7202bfc2de9b244d5"
        && profile["directorySha256"]
            == "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee"
        && profile["fileCount"] == 5
}

pub(super) fn reviewed_profile(manifest: &Value) -> Result<Value, String> {
    let registry_bytes =
        include_bytes!("../../../tests/fixtures/local-original-image-stitch-cases.json");
    let registry_digest = format!("{:x}", Sha256::digest(registry_bytes));
    if registry_digest != REGISTRY_SHA256 {
        return Err("Image Stitch fixture registry raw pin mismatch".into());
    }
    let registry: Value = serde_json::from_slice(registry_bytes)
        .map_err(|_| "Invalid Image Stitch fixture registry")?;
    let profile = registry["cases"]
        .as_array()
        .and_then(|cases| cases.iter().find(|value| value["caseId"] == CASE_ID))
        .ok_or("Image Stitch fixture profile missing")?;
    let manifest_bytes = include_bytes!("../../../tests/fixtures/image-stitch-head-plugin.json");
    let manifest_digest = format!("{:x}", Sha256::digest(manifest_bytes));
    if manifest_digest != MANIFEST_SHA256 {
        return Err("Image Stitch HEAD manifest raw pin mismatch".into());
    }
    let expected_manifest: Value = serde_json::from_slice(manifest_bytes)
        .map_err(|_| "Invalid Image Stitch HEAD manifest fixture")?;
    if profile["id"] != PLUGIN_ID
        || profile["version"] != VERSION
        || profile["featureCode"] != FEATURE
        || profile["runtime"] != "web"
        || profile["dataAccess"] != true
        || profile["dialogAccess"] != "open_and_save"
        || profile["pathAccess"] != "none"
        || profile["verifyDataPersistence"] != false
        || profile["sourceKind"] != "local_full_directory"
        || profile["sourceCommit"] != "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
        || profile["sourceTree"] != "629b6c70b86f28d8f775ced7202bfc2de9b244d5"
        || profile["directorySha256"]
            != "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee"
        || profile["fileCount"] != 5
        || manifest != &expected_manifest
    {
        return Err("Image Stitch profile or fixed HEAD manifest identity rejected".into());
    }
    Ok(profile.clone())
}

pub(super) fn fixture_modes_match(profile: &Value, chooser_requested: bool) -> Result<(), String> {
    if chooser_requested
        && (profile["caseId"] != CASE_ID
            || profile["id"] != PLUGIN_ID
            || profile["featureCode"] != FEATURE
            || profile["dialogAccess"] != "open_and_save")
    {
        return Err("Fixture-only Image Stitch chooser cannot be used by this package".into());
    }
    Ok(())
}

pub(super) fn parse_chooser(
    args: &[String],
    profile: &Value,
    worker: bool,
    native_ui_input: bool,
    require_foreground: bool,
) -> Result<bool, String> {
    let matches: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == "--fixture-image-stitch-save")
        .map(|(index, _)| index)
        .collect();
    if matches.len() > 1
        || args
            .iter()
            .any(|arg| arg.starts_with("--fixture-image-stitch-save="))
    {
        return Err("Image Stitch fixture chooser flag is duplicated or malformed".into());
    }
    let requested = if let Some(index) = matches.first().copied() {
        if args
            .get(index + 1)
            .is_some_and(|value| !value.starts_with("--"))
        {
            return Err("Image Stitch fixture chooser flag does not accept a value".into());
        }
        true
    } else {
        false
    };
    if requested
        && (profile["caseId"] != CASE_ID || worker || native_ui_input || require_foreground)
    {
        return Err("Image Stitch fixture chooser requires its exact reviewed-package mode".into());
    }
    Ok(requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_image_stitch_profile_requires_all_three_real_manifest_features() {
        let registry: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/local-original-image-stitch-cases.json"
        ))
        .unwrap();
        let mut manifest: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/image-stitch-head-plugin.json"
        ))
        .unwrap();
        let expected = registry["cases"][0].clone();
        assert_eq!(reviewed_profile(&manifest).unwrap(), expected);
        assert!(page_document_profile_matches(&expected));
        fixture_modes_match(&expected, false).unwrap();
        fixture_modes_match(&expected, true).unwrap();
        for (key, value) in [
            ("sourceKind", json!("archive")),
            ("sourceTree", json!("0")),
            ("directorySha256", json!("0")),
            ("fileCount", json!(6)),
            ("dialogAccess", json!("save")),
        ] {
            let mut changed = expected.clone();
            changed[key] = value;
            assert!(!page_document_profile_matches(&changed));
        }
        manifest["features"][1]["code"] = serde_json::json!("wrong-feature");
        assert!(reviewed_profile(&manifest).is_err());
        assert!(fixture_modes_match(&json!({"caseId":"local-todo-neo","id":"todo-neo","featureCode":"todo","dialogAccess":"none"}), true).is_err());
        assert!(fixture_modes_match(
            &json!({"caseId":CASE_ID,"id":PLUGIN_ID,"featureCode":FEATURE,"dialogAccess":"save"}),
            true
        )
        .is_err());
    }

    #[test]
    fn chooser_requires_one_valueless_flag_only_for_the_exact_profile_and_direct_mode() {
        let profile: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/local-original-image-stitch-cases.json"
        ))
        .unwrap();
        let profile = profile["cases"][0].clone();
        let valid = vec!["--fixture-image-stitch-save".to_string()];
        assert_eq!(
            parse_chooser(&valid, &profile, false, false, false).unwrap(),
            true
        );
        assert_eq!(
            parse_chooser(&[], &profile, false, false, false).unwrap(),
            false
        );
        assert!(parse_chooser(
            &[valid[0].clone(), valid[0].clone()],
            &profile,
            false,
            false,
            false
        )
        .is_err());
        assert!(parse_chooser(
            &["--fixture-image-stitch-save=1".into()],
            &profile,
            false,
            false,
            false
        )
        .is_err());
        assert!(parse_chooser(
            &[valid[0].clone(), "unexpected".into()],
            &profile,
            false,
            false,
            false
        )
        .is_err());
        assert!(parse_chooser(&valid, &profile, true, false, false).is_err());
        assert!(parse_chooser(&valid, &profile, false, true, false).is_err());
        assert!(parse_chooser(&valid, &profile, false, false, true).is_err());
        let other = json!({"caseId":"local-random-data-head","id":"random-data","featureCode":"randomDataSettings","dialogAccess":"none"});
        assert_eq!(
            parse_chooser(&[], &other, false, false, false).unwrap(),
            false
        );
        assert!(parse_chooser(&valid, &other, false, false, false).is_err());
    }

    #[test]
    fn registered_raw_json_pins_are_exact() {
        let registry =
            include_bytes!("../../../tests/fixtures/local-original-image-stitch-cases.json");
        let manifest = include_bytes!("../../../tests/fixtures/image-stitch-head-plugin.json");
        assert_eq!(format!("{:x}", Sha256::digest(registry)), REGISTRY_SHA256);
        assert_eq!(format!("{:x}", Sha256::digest(manifest)), MANIFEST_SHA256);
    }
}
