use super::{scan, CandidateStatus, ManifestSelection};
use serde_json::json;
use std::path::Path;

fn fixture() -> (tempfile::TempDir, serde_json::Value) {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let manifest = json!({
        "name":"selection-fixture",
        "version":"1.2.3",
        "main":"index.html",
        "features":[{"code":"  custom feature  "}]
    });
    (root, manifest)
}

fn write_manifest(root: &Path, relative: &str, manifest: &serde_json::Value) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(manifest).unwrap()).unwrap();
}

#[test]
fn discovery_keeps_fixed_order_and_explicit_choice_never_falls_back() {
    let (root, manifest) = fixture();
    write_manifest(root.path(), "plugin.json", &manifest);
    write_manifest(root.path(), "public/plugin.json", &manifest);

    let default = scan(root.path(), None);
    assert_eq!(
        default.info.manifest_selection,
        Some(ManifestSelection::Root)
    );
    assert_eq!(default.info.manifest_candidates.len(), 2);
    assert_eq!(
        default.info.manifest_candidates[0].selection,
        ManifestSelection::Root
    );
    assert_eq!(
        default.info.manifest_candidates[1].selection,
        ManifestSelection::Public
    );
    assert!(default.info.manifest_differences.is_empty());

    let public = scan(root.path(), Some(ManifestSelection::Public));
    assert_eq!(
        public.info.manifest_selection,
        Some(ManifestSelection::Public)
    );
    assert_eq!(
        public.selected.unwrap().relative_path,
        Path::new("public/plugin.json")
    );

    std::fs::remove_file(root.path().join("public/plugin.json")).unwrap();
    let no_fallback = scan(root.path(), Some(ManifestSelection::Public));
    assert_eq!(
        no_fallback.info.manifest_selection,
        Some(ManifestSelection::Public)
    );
    assert_eq!(
        no_fallback.info.manifest_candidates[1].status,
        CandidateStatus::Missing
    );
    assert!(!no_fallback.selected.unwrap().valid);
}

#[test]
fn explicit_invalid_root_is_reported_without_selecting_valid_public_manifest() {
    let (root, manifest) = fixture();
    std::fs::write(root.path().join("plugin.json"), b"not-json").unwrap();
    write_manifest(root.path(), "public/plugin.json", &manifest);

    let scan = scan(root.path(), Some(ManifestSelection::Root));
    assert_eq!(scan.info.manifest_selection, Some(ManifestSelection::Root));
    assert_eq!(
        scan.info.manifest_candidates[0].status,
        CandidateStatus::Invalid
    );
    assert_eq!(
        scan.info.manifest_candidates[1].status,
        CandidateStatus::Valid
    );
    assert!(!scan.selected.unwrap().valid);
}

#[test]
fn identity_preserves_feature_whitespace_and_uses_effective_runtime_default() {
    let (root, manifest) = fixture();
    write_manifest(root.path(), "plugin.json", &manifest);

    let scan = scan(root.path(), None);
    let identity = scan.info.manifest_identity.unwrap();
    assert_eq!(identity.runtime, "web");
    assert_eq!(identity.feature_codes, vec!["  custom feature  "]);
}

#[test]
fn comparison_reports_only_differing_fields_in_contract_order() {
    let (root, left) = fixture();
    let mut right = left.clone();
    right["name"] = json!("other");
    right["version"] = json!("2.0.0");
    right["main"] = json!("other.html");
    right["preload"] = json!("preload.js");
    right["runtime"] = json!({"kind":"node","transport":"json_rpc_stdio"});
    right["features"][0]["code"] = json!("different");
    write_manifest(root.path(), "plugin.json", &left);
    write_manifest(root.path(), "public/plugin.json", &right);

    let scan = scan(root.path(), None);
    assert_eq!(
        scan.info.manifest_differences,
        vec![
            "id",
            "version",
            "main",
            "preload",
            "runtime",
            "featureCodes"
        ]
    );
}

#[test]
fn identity_field_byte_limits_are_utf8_bytes_and_feature_count_is_bounded() {
    let (root, mut manifest) = fixture();
    manifest["version"] = json!("界".repeat(86));
    write_manifest(root.path(), "plugin.json", &manifest);
    assert_eq!(
        scan(root.path(), None).info.manifest_candidates[0].status,
        CandidateStatus::Invalid
    );

    manifest["version"] = json!("1.2.3");
    manifest["features"] = json!((0..1001)
        .map(|index| json!({"code":format!("f{index}")}))
        .collect::<Vec<_>>());
    write_manifest(root.path(), "plugin.json", &manifest);
    assert_eq!(
        scan(root.path(), None).info.manifest_candidates[0].status,
        CandidateStatus::Invalid
    );
}

#[test]
fn feature_controls_and_identity_utf8_overflow_invalidate_whole_candidate() {
    let (root, mut manifest) = fixture();
    manifest["features"][0]["code"] = json!("bad\ncode");
    write_manifest(root.path(), "plugin.json", &manifest);
    assert_eq!(
        scan(root.path(), None).info.manifest_candidates[0].status,
        CandidateStatus::Invalid
    );

    manifest["features"][0]["code"] = json!("界".repeat(86));
    write_manifest(root.path(), "plugin.json", &manifest);
    assert_eq!(
        scan(root.path(), None).info.manifest_candidates[0].status,
        CandidateStatus::Invalid
    );
}

#[test]
fn malformed_extra_manifest_fields_do_not_leak_through_fixed_candidate_errors() {
    let (root, mut manifest) = fixture();
    manifest["runtime"] = json!({"kind":"rust"});
    write_manifest(root.path(), "plugin.json", &manifest);

    let scan = scan(root.path(), None);
    let candidate = &scan.info.manifest_candidates[0];
    assert_eq!(candidate.status, CandidateStatus::Invalid);
    assert_eq!(candidate.code, Some("manifest_invalid"));
    assert!(candidate.manifest_sha256.is_none());
    assert!(candidate.identity.is_none());
}

#[test]
fn invalid_installation_name_stays_manifest_invalid_and_keeps_internal_diagnostic() {
    let (root, mut manifest) = fixture();
    manifest["name"] = json!("...   ...");
    write_manifest(root.path(), "plugin.json", &manifest);

    let scan = scan(root.path(), None);
    let candidate = &scan.info.manifest_candidates[0];
    assert_eq!(candidate.status, CandidateStatus::Invalid);
    assert_eq!(candidate.code, Some("manifest_invalid"));
    assert!(candidate.manifest_sha256.is_none());
    assert!(candidate.identity.is_none());
    let selected = scan.selected.unwrap();
    assert!(!selected.valid);
    assert!(selected.invalid_plugin_id);
    assert!(selected.raw.is_none());
    assert!(selected.parsed.is_none());
}

#[test]
fn other_manifest_identity_failures_do_not_become_plugin_id_diagnostics() {
    let (root, mut manifest) = fixture();
    manifest["version"] = json!("");
    write_manifest(root.path(), "plugin.json", &manifest);

    let scan = scan(root.path(), None);
    assert_eq!(
        scan.info.manifest_candidates[0].code,
        Some("manifest_invalid")
    );
    assert!(!scan.selected.unwrap().invalid_plugin_id);
}
