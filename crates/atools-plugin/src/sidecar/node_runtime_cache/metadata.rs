use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{NodeRuntimeCacheError as Error, NodeTarget, RuntimeSignaturePolicy};

pub(super) const MAX_METADATA_BYTES: usize = 16 * 1024;
pub(super) const MAX_LICENSE_BYTES: u64 = 5 * 1024 * 1024;
pub(super) const MAX_COMPRESSED_BYTES: u64 = 80 * 1024 * 1024;
pub(super) const MAX_SIGNED_BINARY_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const MIN_SIGNED_BINARY_BYTES: u64 = 1024 * 1024;
pub(super) const STREAM_BYTES: usize = 64 * 1024;
pub(super) const METADATA_NAME: &str = "compressed-runtime.json";
pub(super) const LICENSE_NAME: &str = "NODE-LICENSE";

#[cfg(test)]
#[path = "../node_runtime_cache_metadata_tests.rs"]
mod tests;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimePin {
    pub version: String,
    pub release_line: String,
    #[serde(rename = "minimumMacOS")]
    pub minimum_macos: String,
    pub source: String,
    pub targets: TargetPins,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TargetPins {
    #[serde(rename = "aarch64-apple-darwin")]
    pub arm64: TargetPin,
    #[serde(rename = "x86_64-apple-darwin")]
    pub x64: TargetPin,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TargetPin {
    pub archive: String,
    pub sha256: String,
    pub binary_sha256: String,
    pub binary_bytes: u64,
    pub license_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PayloadMetadata {
    pub schema_version: u8,
    pub version: String,
    pub target: String,
    #[serde(rename = "minimumMacOS")]
    pub minimum_macos: String,
    pub pin_sha256: String,
    pub archive: String,
    pub archive_url: String,
    pub archive_sha256: String,
    pub upstream_binary_sha256: String,
    pub upstream_binary_bytes: u64,
    pub license_sha256: String,
    pub publisher_team_id: String,
    pub entitlements_sha256: String,
    pub signed_binary_sha256: String,
    pub signed_binary_bytes: u64,
    pub compressed: CompressedMetadata,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CompressedMetadata {
    pub format: String,
    pub level: u8,
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug)]
pub(super) struct ValidatedPayload {
    pub target: NodeTarget,
    pub version: String,
    pub pin_sha256: String,
    pub metadata_sha256: String,
    pub compressed_name: String,
    pub compressed_sha256: String,
    pub compressed_bytes: u64,
    pub signed_sha256: String,
    pub signed_bytes: u64,
    pub license_sha256: String,
    pub entitlements_sha256: String,
}

pub(super) fn validate(
    metadata_bytes: &[u8],
    pin_bytes: &[u8],
    target: NodeTarget,
    policy: &RuntimeSignaturePolicy,
) -> Result<ValidatedPayload, Error> {
    if metadata_bytes.len() > MAX_METADATA_BYTES
        || !valid_team(&policy.expected_team_id)
        || !valid_hash(&policy.approved_entitlements_sha256)
    {
        return Err(Error::InvalidMetadata);
    }
    let metadata: PayloadMetadata =
        serde_json::from_slice(metadata_bytes).map_err(|_| Error::InvalidMetadata)?;
    let canonical = serde_json::to_vec_pretty(&metadata).map_err(|_| Error::InvalidMetadata)?;
    if canonical.len() + 1 != metadata_bytes.len()
        || metadata_bytes[..canonical.len()] != canonical
        || metadata_bytes[canonical.len()] != b'\n'
    {
        return Err(Error::InvalidMetadata);
    }
    let pin: RuntimePin = serde_json::from_slice(pin_bytes).map_err(|_| Error::InvalidMetadata)?;
    let pin_sha = sha256(pin_bytes);
    let selected = match target {
        NodeTarget::Aarch64AppleDarwin => &pin.targets.arm64,
        NodeTarget::X86_64AppleDarwin => &pin.targets.x64,
    };
    let target_name = target.as_str();
    let expected_url = format!(
        "https://nodejs.org/dist/{}/{}",
        pin.version, selected.archive
    );
    let expected_archive = format!(
        "node-{}-darwin-{}.tar.gz",
        pin.version,
        if target == NodeTarget::Aarch64AppleDarwin {
            "arm64"
        } else {
            "x64"
        }
    );
    if selected.archive != expected_archive
        || !valid_release(&pin.version)
        || pin.release_line != "22 LTS"
        || pin.source != format!("https://nodejs.org/dist/{}/SHASUMS256.txt", pin.version)
        || !valid_hash(&selected.sha256)
        || !valid_hash(&selected.binary_sha256)
        || !valid_hash(&selected.license_sha256)
        || !(MIN_SIGNED_BINARY_BYTES..=MAX_SIGNED_BINARY_BYTES).contains(&selected.binary_bytes)
        || metadata.schema_version != 2
        || metadata.target != target_name
        || metadata.version != pin.version
        || metadata.minimum_macos != pin.minimum_macos
        || metadata.pin_sha256 != pin_sha
        || metadata.archive != selected.archive
        || metadata.archive_url != expected_url
        || metadata.archive_sha256 != selected.sha256
        || metadata.upstream_binary_sha256 != selected.binary_sha256
        || metadata.upstream_binary_bytes != selected.binary_bytes
        || metadata.license_sha256 != selected.license_sha256
        || metadata.publisher_team_id != policy.expected_team_id
        || metadata.entitlements_sha256 != policy.approved_entitlements_sha256
        || !valid_hash(&metadata.signed_binary_sha256)
        || !(MIN_SIGNED_BINARY_BYTES..=MAX_SIGNED_BINARY_BYTES)
            .contains(&metadata.signed_binary_bytes)
        || metadata.compressed.format != "gzip"
        || metadata.compressed.level != 6
        || metadata.compressed.file != format!("node-{target_name}.gz")
        || !valid_hash(&metadata.compressed.sha256)
        || !(1..=MAX_COMPRESSED_BYTES).contains(&metadata.compressed.bytes)
    {
        return Err(Error::InvalidMetadata);
    }
    Ok(ValidatedPayload {
        target,
        version: metadata.version,
        pin_sha256: metadata.pin_sha256,
        metadata_sha256: sha256(metadata_bytes),
        compressed_name: metadata.compressed.file,
        compressed_sha256: metadata.compressed.sha256,
        compressed_bytes: metadata.compressed.bytes,
        signed_sha256: metadata.signed_binary_sha256,
        signed_bytes: metadata.signed_binary_bytes,
        license_sha256: metadata.license_sha256,
        entitlements_sha256: metadata.entitlements_sha256,
    })
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_team(value: &str) -> bool {
    value.len() == 10
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn valid_release(value: &str) -> bool {
    let Some(version) = value.strip_prefix('v') else {
        return false;
    };
    let mut parts = version.split('.');
    matches!((parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(a), Some(b), Some(c), None) if [a,b,c].iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
}
