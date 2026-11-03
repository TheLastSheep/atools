use super::*;

fn fixture() -> (RuntimeSignaturePolicy, Vec<u8>) {
    let pin: RuntimePin = serde_json::from_slice(include_bytes!("../../../../resources/node-runtime/pin.json")).unwrap();
    let target = &pin.targets.arm64;
    let policy = RuntimeSignaturePolicy {
        expected_team_id: "HX7739G8FX".into(),
        approved_entitlements_sha256: "a".repeat(64),
    };
    let metadata = PayloadMetadata {
        schema_version: 2,
        version: pin.version.clone(),
        target: NodeTarget::Aarch64AppleDarwin.as_str().into(),
        minimum_macos: pin.minimum_macos.clone(),
        pin_sha256: sha256(include_bytes!("../../../../resources/node-runtime/pin.json")),
        archive: target.archive.clone(),
        archive_url: format!("https://nodejs.org/dist/{}/{}", pin.version, target.archive),
        archive_sha256: target.sha256.clone(),
        upstream_binary_sha256: target.binary_sha256.clone(),
        upstream_binary_bytes: target.binary_bytes,
        license_sha256: target.license_sha256.clone(),
        publisher_team_id: policy.expected_team_id.clone(),
        entitlements_sha256: policy.approved_entitlements_sha256.clone(),
        signed_binary_sha256: "b".repeat(64),
        signed_binary_bytes: MIN_SIGNED_BINARY_BYTES,
        compressed: CompressedMetadata { format: "gzip".into(), level: 6, file: format!("node-{}.gz", NodeTarget::Aarch64AppleDarwin.as_str()), sha256: "c".repeat(64), bytes: 12 },
    };
    let mut bytes = serde_json::to_vec_pretty(&metadata).unwrap();
    bytes.push(b'\n');
    (policy, bytes)
}

#[test]
fn accepts_exact_schema2_target_pin_and_entitlement_binding() {
    let (policy, metadata) = fixture();
    let payload = validate(&metadata, include_bytes!("../../../../resources/node-runtime/pin.json"), NodeTarget::Aarch64AppleDarwin, &policy).unwrap();
    assert_eq!(payload.target, NodeTarget::Aarch64AppleDarwin);
    assert_eq!(payload.signed_sha256, "b".repeat(64));
}

#[test]
fn rejects_unknown_schema_target_pin_and_entitlement_changes() {
    let (policy, metadata) = fixture();
    let mut unknown: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
    unknown["unexpected"] = serde_json::Value::Bool(true);
    let mut unknown_bytes = serde_json::to_vec_pretty(&unknown).unwrap();
    unknown_bytes.push(b'\n');
    assert!(matches!(validate(&unknown_bytes, include_bytes!("../../../../resources/node-runtime/pin.json"), NodeTarget::Aarch64AppleDarwin, &policy), Err(Error::InvalidMetadata)));

    let mut value: PayloadMetadata = serde_json::from_slice(&metadata).unwrap();
    value.target = NodeTarget::X86_64AppleDarwin.as_str().into();
    let mut changed = serde_json::to_vec_pretty(&value).unwrap(); changed.push(b'\n');
    assert!(matches!(validate(&changed, include_bytes!("../../../../resources/node-runtime/pin.json"), NodeTarget::Aarch64AppleDarwin, &policy), Err(Error::InvalidMetadata)));

    let mut wrong_pin = include_bytes!("../../../../resources/node-runtime/pin.json").to_vec();
    wrong_pin[0] ^= 1;
    assert!(matches!(validate(&metadata, &wrong_pin, NodeTarget::Aarch64AppleDarwin, &policy), Err(Error::InvalidMetadata)));
    let mut wrong_policy = policy; wrong_policy.approved_entitlements_sha256 = "d".repeat(64);
    assert!(matches!(validate(&metadata, include_bytes!("../../../../resources/node-runtime/pin.json"), NodeTarget::Aarch64AppleDarwin, &wrong_policy), Err(Error::InvalidMetadata)));
}
