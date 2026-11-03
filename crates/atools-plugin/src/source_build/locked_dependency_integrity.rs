//! Strict npm registry URL and Subresource Integrity parsing for lock metadata.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256, Sha512};
use url::Url;

use super::locked_dependency::LockedDependencyError;

const REGISTRY_HOST: &str = "registry.npmjs.org";
const LOCK_MIRROR_HOST: &str = "registry.npmmirror.com";

/// Normalize a raw lockfile URL for the canonical npm registry fetch boundary.
/// Only the exact supported lockfile mirror authority is mapped; delivery
/// remains on npmjs.org because the serialized plan and fetch worker accept it only.
pub(super) fn normalize_lock_registry_url(input: &str) -> Result<String, LockedDependencyError> {
    if let Ok(canonical) = validate_registry_url(input) {
        return Ok(canonical);
    }
    validate_registry_url_for_host(input, LOCK_MIRROR_HOST)?;
    let suffix = input
        .strip_prefix("https://registry.npmmirror.com")
        .ok_or(LockedDependencyError::InvalidRegistryUrl)?;
    validate_registry_url(&format!("https://{REGISTRY_HOST}{suffix}"))
}

pub(super) fn validate_registry_url(input: &str) -> Result<String, LockedDependencyError> {
    validate_registry_url_for_host(input, REGISTRY_HOST)
}

fn validate_registry_url_for_host(
    input: &str,
    expected_host: &str,
) -> Result<String, LockedDependencyError> {
    if input.len() > 2048 || input.chars().any(char::is_control) {
        return Err(LockedDependencyError::InvalidRegistryUrl);
    }
    let parsed = Url::parse(input).map_err(|_| LockedDependencyError::InvalidRegistryUrl)?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some(expected_host)
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.as_str() != input
    {
        return Err(LockedDependencyError::InvalidRegistryUrl);
    }
    let segments = parsed
        .path_segments()
        .ok_or(LockedDependencyError::InvalidRegistryUrl)?;
    let mut count = 0;
    for segment in segments {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('%') {
            // Encoded path delimiters and double-encoding are unsupported.
            return Err(LockedDependencyError::InvalidRegistryUrl);
        }
        count += 1;
    }
    if count < 2 || !parsed.path().ends_with(".tgz") {
        return Err(LockedDependencyError::InvalidRegistryUrl);
    }
    Ok(input.to_owned())
}

pub(super) fn parse_integrity(
    value: &str,
) -> Result<super::locked_dependency::PackageIntegrityV1, LockedDependencyError> {
    let mut chosen = None;
    for token in value.split_ascii_whitespace() {
        let (algorithm, encoded) = token
            .split_once('-')
            .ok_or(LockedDependencyError::InvalidIntegrity)?;
        if encoded.contains('?') {
            return Err(LockedDependencyError::InvalidIntegrity);
        }
        if !matches!(algorithm, "sha512" | "sha256") {
            continue;
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| LockedDependencyError::InvalidIntegrity)?;
        if STANDARD.encode(&bytes) != encoded {
            return Err(LockedDependencyError::InvalidIntegrity);
        }
        let expected = if algorithm == "sha512" { 64 } else { 32 };
        if bytes.len() != expected {
            return Err(LockedDependencyError::InvalidIntegrity);
        }
        let candidate = super::locked_dependency::PackageIntegrityV1 {
            algorithm: algorithm.to_owned(),
            digest_hex: hex(&bytes),
        };
        if candidate.algorithm == "sha512" {
            return Ok(candidate);
        }
        chosen.get_or_insert(candidate);
    }
    chosen.ok_or(LockedDependencyError::MissingIntegrity)
}

pub(super) fn verify_archive_integrity(
    integrity: &super::locked_dependency::PackageIntegrityV1,
    archive_bytes: &[u8],
) -> bool {
    let actual: Vec<u8> = match integrity.algorithm.as_str() {
        "sha512" => Sha512::digest(archive_bytes).to_vec(),
        "sha256" => Sha256::digest(archive_bytes).to_vec(),
        _ => return false,
    };
    hex(&actual) == integrity.digest_hex
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
