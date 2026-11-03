//! Explicit manifest identity for the fixed DeepRead public-tree source case.
use super::case::{self, SourceCase};
use serde_json::Value;

pub(super) const DEEPREAD_PUBLIC: SourceCase = SourceCase {
    case_id: "fixed-head-deepread-public",
    report_profile: "fixed-head-deepread-public",
    plugin_manifest_path: "public/plugin.json",
    plugin_manifest_sha256: "1ad7c1b5ddd7ce687878d8aca0da319d9f75ef6d77e101ed8a706d6a1d268192",
    plugin_version: "1.1.2",
    plugin_main: "index.html",
    plugin_source_main: "index.html",
    feature_code: "deepread",
    feature_codes: &[
        "deepread",
        "deepread-import",
        "deepread-search-books",
        "deepread-prev-page",
        "deepread-next-page",
        "deepread-toggle-show",
        "deepread-close",
        "deepread-toggle-auto",
        "deepread-toggle-stealth",
    ],
    manifest_selection: Some("public"),
    manifest_effective_runtime: Some("web"),
    plugin_preload: Some("preload/services.js"),
    // Preserve the historical case classifier: preload presence is separate from
    // the selected manifest's declared/effective runtime used below.
    ..case::DEEPREAD
};

pub(super) fn add_inspection_selection(case: SourceCase, input: &mut Value) {
    if let Some(selection) = case.manifest_selection {
        input["manifestSelection"] = serde_json::json!(selection);
    }
}

pub(super) fn add_conversion_selection(case: SourceCase, input: &mut Value) {
    if let Some(selection) = case.manifest_selection {
        input["manifestSelection"] = serde_json::json!(selection);
        input["expectedManifestSha256"] = serde_json::json!(case.plugin_manifest_sha256);
    }
}

pub(super) fn selected_identity_matches(case: SourceCase, output: &Value) -> bool {
    let (Some(selection), Some(runtime)) =
        (case.manifest_selection, case.manifest_effective_runtime)
    else {
        return case.manifest_selection.is_none() && case.manifest_effective_runtime.is_none();
    };
    let expected_identity = serde_json::json!({
        "id": case.plugin_id,
        "version": case.plugin_version,
        "main": case.plugin_main,
        "preload": case.plugin_preload,
        "runtime": runtime,
        "featureCodes": case.feature_codes,
    });
    output.get("manifestSelection").and_then(Value::as_str) == Some(selection)
        && output.get("manifestSha256").and_then(Value::as_str) == Some(case.plugin_manifest_sha256)
        && output.get("manifestIdentity") == Some(&expected_identity)
}

pub(super) fn conversion_input_identity_matches(case: SourceCase, evidence: &Value) -> bool {
    match (
        case.manifest_selection,
        evidence.get("manifestInputIdentity"),
    ) {
        (None, None) => true,
        (Some(selection), Some(identity)) => {
            identity.get("manifestSelection").and_then(Value::as_str) == Some(selection)
                && identity
                    .get("expectedManifestSha256")
                    .and_then(Value::as_str)
                    == Some(case.plugin_manifest_sha256)
                && identity.as_object().is_some_and(|object| object.len() == 2)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn public_manifest() -> Value {
        json!({"name":"deepread","version":"1.1.2","main":"index.html",
            "preload":"preload/services.js","features":[
                {"code":"deepread"},{"code":"deepread-import"},{"code":"deepread-search-books"},
                {"code":"deepread-prev-page"},{"code":"deepread-next-page"},
                {"code":"deepread-toggle-show"},{"code":"deepread-close"},
                {"code":"deepread-toggle-auto"},{"code":"deepread-toggle-stealth"}]})
    }

    fn public_inspection_summary() -> Value {
        json!({"manifestSelection":"public",
            "manifestSha256":DEEPREAD_PUBLIC.plugin_manifest_sha256,
            "manifestIdentity":{"id":"deepread","version":"1.1.2","main":"index.html",
                "preload":"preload/services.js","runtime":"web","featureCodes":[
                    "deepread","deepread-import","deepread-search-books","deepread-prev-page",
                    "deepread-next-page","deepread-toggle-show","deepread-close",
                    "deepread-toggle-auto","deepread-toggle-stealth"]}})
    }

    #[test]
    fn public_case_is_exactly_pinned_and_keeps_legacy_preload_classification() {
        assert_eq!(DEEPREAD_PUBLIC.case_id, "fixed-head-deepread-public");
        assert_eq!(DEEPREAD_PUBLIC.source_root, case::DEEPREAD.source_root);
        assert_eq!(
            DEEPREAD_PUBLIC.source_manifest_sha256,
            case::DEEPREAD.source_manifest_sha256
        );
        assert_eq!(
            DEEPREAD_PUBLIC.inventory_sha256,
            case::DEEPREAD.inventory_sha256
        );
        assert_eq!(DEEPREAD_PUBLIC.file_count, 24);
        assert_eq!(DEEPREAD_PUBLIC.source_bytes, 668_051);
        assert_eq!(DEEPREAD_PUBLIC.plugin_manifest_path, "public/plugin.json");
        assert_eq!(
            DEEPREAD_PUBLIC.plugin_manifest_sha256,
            "1ad7c1b5ddd7ce687878d8aca0da319d9f75ef6d77e101ed8a706d6a1d268192"
        );
        assert_eq!(DEEPREAD_PUBLIC.plugin_version, "1.1.2");
        assert_eq!(DEEPREAD_PUBLIC.plugin_main, "index.html");
        assert_eq!(DEEPREAD_PUBLIC.plugin_preload, Some("preload/services.js"));
        assert_eq!(DEEPREAD_PUBLIC.feature_codes.len(), 9);
        assert_eq!(DEEPREAD_PUBLIC.runtime, "node");
        assert_eq!(DEEPREAD_PUBLIC.manifest_selection, Some("public"));
        assert_eq!(DEEPREAD_PUBLIC.manifest_effective_runtime, Some("web"));
        assert!(!DEEPREAD_PUBLIC.native_ui_consumer_supported);
        assert!(case::validate_plugin_manifest_value(DEEPREAD_PUBLIC, &public_manifest()).is_ok());
        assert_eq!(
            case::case_by_id("fixed-head-deepread-public").unwrap(),
            DEEPREAD_PUBLIC
        );
    }

    #[test]
    fn selector_and_expected_manifest_hash_are_opt_in_and_paired() {
        for legacy in [
            case::CALCULATOR,
            case::TETRIS,
            case::TODO_NEO,
            case::DEEPREAD,
        ] {
            let mut inspection = json!({"sourcePath":"/fixed/source"});
            add_inspection_selection(legacy, &mut inspection);
            assert_eq!(inspection, json!({"sourcePath":"/fixed/source"}));
            let mut conversion = json!({"sourcePath":"/fixed/source","expectedRevision":"rev"});
            add_conversion_selection(legacy, &mut conversion);
            assert_eq!(
                conversion,
                json!({"sourcePath":"/fixed/source","expectedRevision":"rev"})
            );
            assert!(selected_identity_matches(legacy, &json!({})));
            assert!(conversion_input_identity_matches(legacy, &json!({})));
            assert!(!conversion_input_identity_matches(
                legacy,
                &json!({
                "manifestInputIdentity":{"manifestSelection":"public",
                    "expectedManifestSha256":"unexpected"}})
            ));
        }

        let mut inspection = json!({"sourcePath":"/fixed/source"});
        add_inspection_selection(DEEPREAD_PUBLIC, &mut inspection);
        assert_eq!(
            inspection,
            json!({"sourcePath":"/fixed/source","manifestSelection":"public"})
        );
        let mut conversion = json!({"sourcePath":"/fixed/source","expectedRevision":"rev"});
        add_conversion_selection(DEEPREAD_PUBLIC, &mut conversion);
        assert_eq!(
            conversion,
            json!({"sourcePath":"/fixed/source","expectedRevision":"rev",
            "manifestSelection":"public","expectedManifestSha256":DEEPREAD_PUBLIC.plugin_manifest_sha256})
        );
        let actual_taskrun_input = json!({"manifestInputIdentity":{"manifestSelection":"public",
            "expectedManifestSha256":DEEPREAD_PUBLIC.plugin_manifest_sha256}});
        assert!(conversion_input_identity_matches(
            DEEPREAD_PUBLIC,
            &actual_taskrun_input
        ));
        assert!(!conversion_input_identity_matches(
            DEEPREAD_PUBLIC,
            &json!({})
        ));
        assert!(!conversion_input_identity_matches(
            DEEPREAD_PUBLIC,
            &json!({
            "manifestInputIdentity":{"manifestSelection":"root",
                "expectedManifestSha256":DEEPREAD_PUBLIC.plugin_manifest_sha256}})
        ));
    }

    #[test]
    fn inspector_must_return_the_exact_public_manifest_identity() {
        let mut output = public_inspection_summary();
        assert!(selected_identity_matches(DEEPREAD_PUBLIC, &output));
        output["manifestSelection"] = json!("root");
        assert!(!selected_identity_matches(DEEPREAD_PUBLIC, &output));
        output["manifestSelection"] = json!("public");
        output["manifestSha256"] = json!("0".repeat(64));
        assert!(!selected_identity_matches(DEEPREAD_PUBLIC, &output));
        output = public_inspection_summary();
        output["manifestIdentity"]["runtime"] = json!("node");
        assert!(!selected_identity_matches(DEEPREAD_PUBLIC, &output));
        output = public_inspection_summary();
        output["manifestIdentity"]["featureCodes"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert!(!selected_identity_matches(DEEPREAD_PUBLIC, &output));
    }
}
