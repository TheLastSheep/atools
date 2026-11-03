use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};

fn lock_inputs(mirror: bool) -> (Vec<u8>, Vec<u8>) {
    let archive = b"registry-independent pinned archive bytes";
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(archive)));
    let host = if mirror {
        "registry.npmmirror.com"
    } else {
        "registry.npmjs.org"
    };
    let package = json!({"dependencies":{"plain":"1.0.0","@demo/core":"1.0.0"}});
    let lock = json!({
        "name":"fixture", "lockfileVersion":3,
        "packages":{
            "":{"dependencies":{"plain":"1.0.0","@demo/core":"1.0.0"}},
            "node_modules/plain":{
                "name":"plain","version":"1.0.0",
                "resolved":format!("https://{host}/plain/-/plain-1.0.0.tgz"),
                "integrity":integrity
            },
            "node_modules/@demo/core":{
                "name":"@demo/core","version":"1.0.0",
                "resolved":format!("https://{host}/@demo/core/-/core-1.0.0.tgz"),
                "integrity":integrity
            }
        }
    });
    (
        serde_json::to_vec(&package).unwrap(),
        serde_json::to_vec(&lock).unwrap(),
    )
}

fn build(package: &[u8], lock: &[u8]) -> LockedDependencyPlanV1 {
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
    .unwrap()
}

#[test]
fn raw_mirror_lock_maps_scoped_and_unscoped_urls_without_rewriting_source_identity() {
    let (package, mirror_lock) = lock_inputs(true);
    let untouched_lock = mirror_lock.clone();
    let (canonical_package, canonical_lock) = lock_inputs(false);
    let mirror_plan = build(&package, &mirror_lock);
    let canonical_plan = build(&canonical_package, &canonical_lock);

    assert_eq!(mirror_lock, untouched_lock);
    assert_eq!(mirror_plan.package_json_sha256, sha256_hex(&package));
    assert_eq!(mirror_plan.package_lock_sha256, sha256_hex(&mirror_lock));
    assert_eq!(mirror_plan.source_revision_sha256, "a".repeat(64));
    assert_ne!(
        mirror_plan.package_lock_sha256,
        canonical_plan.package_lock_sha256
    );
    assert_eq!(mirror_plan.packages.len(), 2);
    for (actual, expected) in mirror_plan.packages.iter().zip(&canonical_plan.packages) {
        assert_eq!(actual.package_path, expected.package_path);
        assert_eq!(actual.resolved_url, expected.resolved_url);
        assert!(actual
            .resolved_url
            .starts_with("https://registry.npmjs.org/"));
        assert_eq!(actual.integrity, expected.integrity);
        assert!(verify_archive_integrity(
            actual,
            b"registry-independent pinned archive bytes"
        ));
        assert_eq!(actual.archive_id_sha256, expected.archive_id_sha256);
    }
    assert!(verify_plan_checksum(&mirror_plan).unwrap());
}

#[test]
fn mirror_ingestion_rejects_noncanonical_or_ambiguous_urls() {
    for raw in [
        "https://registry.npmmirror.com.evil.example/pkg/-/pkg-1.0.0.tgz",
        "https://evil.registry.npmmirror.com/pkg/-/pkg-1.0.0.tgz",
        "https://user@registry.npmmirror.com/pkg/-/pkg-1.0.0.tgz",
        "https://user:secret@registry.npmmirror.com/pkg/-/pkg-1.0.0.tgz",
        "http://registry.npmmirror.com/pkg/-/pkg-1.0.0.tgz",
        "https://registry.npmmirror.com:443/pkg/-/pkg-1.0.0.tgz",
        "https://registry.npmmirror.com/pkg/-/pkg-1.0.0.tgz?download=1",
        "https://registry.npmmirror.com/pkg/-/pkg-1.0.0.tgz#fragment",
        "https://registry.npmmirror.com/pkg/%2Fother.tgz",
        "https://registry.npmmirror.com/pkg\\..\\other.tgz",
        "https://REGISTRY.NPMMIRROR.COM/pkg/-/pkg-1.0.0.tgz",
    ] {
        assert_eq!(
            normalize_lock_registry_url(raw),
            Err(LockedDependencyError::InvalidRegistryUrl),
            "{raw}"
        );
    }
}

#[test]
fn serialized_plan_rejects_mirror_even_with_a_valid_recomputed_checksum() {
    let (package, lock) = lock_inputs(false);
    let mut plan = build(&package, &lock);
    let plain = plan
        .packages
        .iter_mut()
        .find(|package| package.name == "plain")
        .unwrap();
    plain.resolved_url = plain
        .resolved_url
        .replace("registry.npmjs.org", "registry.npmmirror.com");
    let mirror_url = plain.resolved_url.clone();
    plan.plan_sha256 = plan_checksum(&plan).unwrap();
    assert_eq!(
        normalize_lock_registry_url(&mirror_url).unwrap(),
        "https://registry.npmjs.org/plain/-/plain-1.0.0.tgz"
    );
    assert_eq!(
        validate_registry_url(&mirror_url),
        Err(LockedDependencyError::InvalidRegistryUrl)
    );
    assert!(!verify_plan_checksum(&plan).unwrap());

    let mut lock_value: Value = serde_json::from_slice(&lock).unwrap();
    lock_value["packages"]["node_modules/plain"]["resolved"] = json!(mirror_url);
    let mirror_bytes = serde_json::to_vec(&lock_value).unwrap();
    let ingested = build(&package, &mirror_bytes);
    assert_eq!(
        ingested
            .packages
            .iter()
            .find(|package| package.name == "plain")
            .unwrap()
            .resolved_url,
        "https://registry.npmjs.org/plain/-/plain-1.0.0.tgz"
    );
    assert_eq!(
        ingested.package_lock_sha256,
        format!("{:x}", Sha256::digest(&mirror_bytes))
    );
}
