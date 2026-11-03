use super::{parse_identity, PackageIdentity, PACKAGE_JSON_BYTES};

#[test]
fn accepts_unrecognized_standard_manifest_fields() {
    let identity = parse_identity(
        br#"{"name":"demo-fixture","version":"1.0.0","scripts":{"install":"node x"},"exports":{".":"./index.js"},"private":true}"#,
    )
    .unwrap();
    assert_eq!(
        identity,
        PackageIdentity {
            name: "demo-fixture".to_owned(),
            version: "1.0.0".to_owned(),
        }
    );
}

#[test]
fn rejects_missing_duplicate_or_non_string_identity_fields() {
    for bytes in [
        &br#"{"version":"1.0.0"}"#[..],
        &br#"{"name":"demo-fixture"}"#[..],
        &br#"{"name":"first","name":"second","version":"1.0.0"}"#[..],
        &br#"{"name":"demo-fixture","version":"1.0.0","version":"2.0.0"}"#[..],
        &br#"{"name":4,"version":"1.0.0"}"#[..],
        &br#"{"name":"demo-fixture","version":null}"#[..],
    ] {
        assert_eq!(
            parse_identity(bytes),
            Err("dependency_package_identity_invalid")
        );
    }
}

#[test]
fn rejects_empty_and_over_limit_metadata() {
    assert_eq!(
        parse_identity(b""),
        Err("dependency_package_identity_limit")
    );
    let bytes = vec![b' '; PACKAGE_JSON_BYTES as usize + 1];
    assert_eq!(
        parse_identity(&bytes),
        Err("dependency_package_identity_limit")
    );
}
