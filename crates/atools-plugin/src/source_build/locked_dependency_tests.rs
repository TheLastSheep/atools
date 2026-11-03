use super::locked_dependency::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};

fn fixture() -> (Vec<u8>, Vec<u8>, String) {
    let archive = b"pinned deterministic archive";
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(archive)));
    let package = json!({
        "dependencies":{"@demo/core":"^1.2.0"}
    });
    let lock = json!({
        "name":"fixture","lockfileVersion":3,
        "packages":{
            "":{"dependencies":{"@demo/core":"^1.2.0"}},
            "node_modules/@demo/core":{
                "name":"@demo/core","version":"1.2.4",
                "resolved":"https://registry.npmjs.org/@demo/core/-/core-1.2.4.tgz",
                "integrity":integrity
            },
            "node_modules/optional-native":{
                "version":"3.0.0","optional":true,"cpu":["arm64"],
                "resolved":"https://registry.npmjs.org/optional-native/-/optional-native-3.0.0.tgz",
                "integrity":integrity
            }
        }
    });
    (
        serde_json::to_vec(&package).unwrap(),
        serde_json::to_vec(&lock).unwrap(),
        integrity,
    )
}
fn plan(package: &[u8], lock: &[u8]) -> Result<LockedDependencyPlanV1, LockedDependencyError> {
    build_locked_dependency_plan(
        package,
        lock,
        &"a".repeat(64),
        BuildTargetV1 {
            os: "darwin".into(),
            cpu: "x64".into(),
        },
        &"b".repeat(64),
    )
}

#[test]
fn maps_rust_host_names_to_npm_platform_names_explicitly() {
    use super::locked_dependency::target_from_host;
    assert_eq!(
        target_from_host("macos", "aarch64").unwrap(),
        BuildTargetV1 {
            os: "darwin".into(),
            cpu: "arm64".into()
        }
    );
    assert_eq!(
        target_from_host("windows", "x86_64").unwrap(),
        BuildTargetV1 {
            os: "win32".into(),
            cpu: "x64".into()
        }
    );
    assert_eq!(
        target_from_host("linux", "x86_64").unwrap(),
        BuildTargetV1 {
            os: "linux".into(),
            cpu: "x64".into()
        }
    );
    assert_eq!(
        target_from_host("freebsd", "x86_64"),
        Err(LockedDependencyError::InvalidTarget)
    );
}

#[test]
fn builds_canonical_lock_plan_and_skips_only_incompatible_optional_target() {
    let (package, lock, _) = fixture();
    let plan = plan(&package, &lock).unwrap();
    assert_eq!(plan.package_count, 1);
    assert_eq!(plan.packages[0].package_path, "node_modules/@demo/core");
    assert_eq!(plan.packages[0].integrity.algorithm, "sha512");
    assert!(verify_archive_integrity(
        &plan.packages[0],
        b"pinned deterministic archive"
    ));
    assert!(!verify_archive_integrity(
        &plan.packages[0],
        b"different archive"
    ));
    assert_eq!(plan.skipped_optional[0].reason, "target_cpu_mismatch");
    assert!(verify_plan_checksum(&plan).unwrap());
    let mut tampered = plan.clone();
    tampered.packages[0].version = "1.2.5".into();
    assert!(!verify_plan_checksum(&tampered).unwrap());
    assert!(serde_json::to_vec(&plan).unwrap().len() <= MAX_PLAN_JSON_BYTES);
}

#[test]
fn handles_observed_netbsd_and_openharmony_optional_platform_markers_fail_closed_otherwise() {
    let (package, lock, _) = fixture();
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    parsed["packages"]["node_modules/optional-native"]["os"] = json!(["netbsd"]);
    let first_plan = plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap();
    assert_eq!(first_plan.skipped_optional[0].reason, "target_os_mismatch");

    parsed["packages"]["node_modules/optional-native"]["os"] = json!(["openharmony"]);
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap())
            .unwrap()
            .skipped_optional[0]
            .reason,
        "target_os_mismatch"
    );

    parsed["packages"]["node_modules/optional-native"]["os"] = json!(["future-os"]);
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
        LockedDependencyError::UnsupportedPackage
    );
}

#[test]
fn rejects_external_registry_credentials_queries_fragments_and_encoded_path_ambiguity() {
    let (package, lock, _) = fixture();
    for url in [
        "https://user@registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
        "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz?x=1",
        "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz#x",
        "https://evil.example/pkg/-/pkg-1.0.0.tgz",
        "https://registry.npmjs.org/pkg/%2Fother.tgz",
    ] {
        let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
        parsed["packages"]["node_modules/@demo/core"]["resolved"] = json!(url);
        let bytes = serde_json::to_vec(&parsed).unwrap();
        assert_eq!(
            plan(&package, &bytes).unwrap_err(),
            LockedDependencyError::InvalidRegistryUrl,
            "{url}"
        );
    }
}

#[test]
fn requires_sri_and_direct_root_spec_to_match_lock() {
    let (package, lock, _) = fixture();
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    parsed["packages"]["node_modules/@demo/core"]
        .as_object_mut()
        .unwrap()
        .remove("integrity");
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
        LockedDependencyError::MissingIntegrity
    );
    parsed["packages"]["node_modules/@demo/core"]["integrity"] = "sha512-YQ==".into();
    parsed["packages"][""]["dependencies"]["@demo/core"] = "^9.0.0".into();
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
        LockedDependencyError::DirectDependencyMismatch
    );
}

#[test]
fn rejects_duplicate_keys_and_unsafe_package_paths_but_skips_lifecycle_scripts() {
    let (package, lock, _) = fixture();
    let duplicate=br#"{"lockfileVersion":3,"lockfileVersion":3,"packages":{"":{"dependencies":{"@demo/core":"^1.2.0"}}}}"#;
    assert_eq!(
        plan(&package, duplicate).unwrap_err(),
        LockedDependencyError::DuplicateJsonKey
    );
    for bad_path in [
        "node_modules/../escape",
        "node_modules/pkg\\alias",
        "node_modules//pkg",
        "node_modules/@Bad/core",
        "node_modules/@scope",
        "node_modules/@scope/pkg/extra",
        "node_modules/@demo/core/node_modules/child/extra",
    ] {
        let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
        let entry = parsed["packages"]
            .as_object_mut()
            .unwrap()
            .remove("node_modules/@demo/core")
            .unwrap();
        parsed["packages"][bad_path] = entry;
        assert!(
            plan(&package, &serde_json::to_vec(&parsed).unwrap()).is_err(),
            "{bad_path}"
        );
    }
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    parsed["packages"]["node_modules/@demo/core"]["hasInstallScript"] = json!(true);
    let lifecycle_plan = plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap();
    assert!(
        lifecycle_plan
            .packages
            .iter()
            .find(|item| item.name == "@demo/core")
            .unwrap()
            .lifecycle_scripts_skipped
    );
}

#[test]
fn lock_graph_uses_nearest_ancestor_and_rejects_unmatched_root_sections() {
    let (package, lock, _) = fixture();
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    parsed["packages"]["node_modules/@demo/core"]["dependencies"] = json!({"child":"^1.0.0"});
    parsed["packages"]["node_modules/@demo/core/node_modules/child"] = json!({
        "version":"1.2.0",
        "resolved":"https://registry.npmjs.org/child/-/child-1.2.0.tgz",
        "integrity":parsed["packages"]["node_modules/@demo/core"]["integrity"].clone()
    });
    parsed["packages"]["node_modules/child"] = json!({
        "version":"2.0.0",
        "resolved":"https://registry.npmjs.org/child/-/child-2.0.0.tgz",
        "integrity":parsed["packages"]["node_modules/@demo/core"]["integrity"].clone()
    });
    assert!(plan(&package, &serde_json::to_vec(&parsed).unwrap()).is_ok());
    parsed["packages"]["node_modules/@demo/core/node_modules/child"]["version"] = json!("2.1.0");
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
        LockedDependencyError::LockMismatch
    );

    let mut extra_root: Value = serde_json::from_slice(&lock).unwrap();
    extra_root["packages"][""]["optionalDependencies"] = json!({"not-in-package-json":"1.0.0"});
    assert_eq!(
        plan(&package, &serde_json::to_vec(&extra_root).unwrap()).unwrap_err(),
        LockedDependencyError::DirectDependencyMismatch
    );
}

#[test]
fn absent_optional_peer_is_not_treated_as_a_mandatory_install() {
    let (package, lock, _) = fixture();
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    parsed["packages"]["node_modules/@demo/core"]["peerDependencies"] =
        json!({"optional-peer":"*"});
    parsed["packages"]["node_modules/@demo/core"]["peerDependenciesMeta"] =
        json!({"optional-peer":{"optional":true}});
    assert!(plan(&package, &serde_json::to_vec(&parsed).unwrap()).is_ok());
}

#[test]
fn orphan_optional_peer_metadata_does_not_create_a_dependency_edge() {
    let (package, lock, _) = fixture();
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    let integrity = parsed["packages"]["node_modules/@demo/core"]["integrity"].clone();
    parsed["packages"]["node_modules/debug"] = json!({
        "name":"debug",
        "version":"4.4.0",
        "resolved":"https://registry.npmjs.org/debug/-/debug-4.4.0.tgz",
        "integrity":integrity,
        "peerDependenciesMeta":{"supports-color":{"optional":true}}
    });

    let debug = &parsed["packages"]["node_modules/debug"];
    assert!(debug.get("peerDependencies").is_none());
    let plan = plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap();
    assert!(plan.packages.iter().any(|item| item.name == "debug"));
    assert!(!plan
        .packages
        .iter()
        .any(|item| item.name == "supports-color"));
}

#[test]
fn absent_required_peer_still_rejects_the_lock_graph() {
    let (package, lock, _) = fixture();
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    parsed["packages"]["node_modules/@demo/core"]["peerDependencies"] =
        json!({"missing-peer":"^1.0.0"});
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
        LockedDependencyError::LockMismatch
    );

    let integrity = parsed["packages"]["node_modules/@demo/core"]["integrity"].clone();
    parsed["packages"]["node_modules/@demo/core"]["peerDependencies"] =
        json!({"wrong-version-peer":"^1.0.0"});
    parsed["packages"]["node_modules/wrong-version-peer"] = json!({
        "name":"wrong-version-peer",
        "version":"2.0.0",
        "resolved":"https://registry.npmjs.org/wrong-version-peer/-/wrong-version-peer-2.0.0.tgz",
        "integrity":integrity
    });
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
        LockedDependencyError::LockMismatch
    );
}

#[test]
fn rejects_malformed_orphan_peer_metadata() {
    let (package, lock, _) = fixture();
    for metadata in [
        json!({"supports-color":[]}),
        json!({"supports-color":{"optional":"true"}}),
        json!({"supports-color":{"optional":true,"extra":false}}),
    ] {
        let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
        parsed["packages"]["node_modules/@demo/core"]["peerDependenciesMeta"] = metadata;
        assert_eq!(
            plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
            LockedDependencyError::UnsupportedPackage
        );
    }
}

#[test]
fn validates_root_peer_ranges_and_rejects_unsupported_installed_ranges() {
    let (package, lock, _) = fixture();
    let mut parsed: Value = serde_json::from_slice(&lock).unwrap();
    parsed["packages"][""]["peerDependencies"] = json!({"peer":"^1 || ^2"});
    parsed["packages"]["node_modules/peer"] = json!({
        "version":"2.0.0",
        "resolved":"https://registry.npmjs.org/peer/-/peer-2.0.0.tgz",
        "integrity":parsed["packages"]["node_modules/@demo/core"]["integrity"].clone()
    });
    assert!(plan(&package, &serde_json::to_vec(&parsed).unwrap()).is_ok());

    parsed["packages"]["node_modules/@demo/core"]["dependencies"] =
        json!({"peer":"git+https://example.test/repo"});
    assert_eq!(
        plan(&package, &serde_json::to_vec(&parsed).unwrap()).unwrap_err(),
        LockedDependencyError::UnsupportedRange
    );
}

#[test]
fn receipt_and_opaque_handle_bind_to_plan_identity() {
    let (package, lock, _) = fixture();
    let plan = plan(&package, &lock).unwrap();
    let set_id = dependency_set_id_sha256(&plan).unwrap();
    let manifest_sha = "c".repeat(64);
    let receipt = DependencySetReceiptV1 {
        schema_version: 1,
        set_id_sha256: set_id.clone(),
        manifest_sha256: manifest_sha.clone(),
        source_revision_sha256: plan.source_revision_sha256.clone(),
        package_lock_sha256: plan.package_lock_sha256.clone(),
        target: plan.target.clone(),
        package_count: plan.package_count,
        archive_bytes: 1,
        unpacked_bytes: 2,
        file_count: 3,
    };
    let handle = OwnedDependencyRootHandle {
        set_id_sha256: set_id,
        manifest_sha256: manifest_sha,
    };
    assert!(verify_dependency_receipt(&plan, &receipt, &handle).unwrap());
    let mut wrong = receipt.clone();
    wrong.package_lock_sha256 = "d".repeat(64);
    assert!(!verify_dependency_receipt(&plan, &wrong, &handle).unwrap());
    assert!(serde_json::to_value(handle).unwrap().get("path").is_none());
}
