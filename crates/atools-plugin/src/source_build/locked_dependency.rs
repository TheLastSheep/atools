//! Bounded, metadata-only planning for an app-owned npm dependency set.
//!
//! This does not download or extract packages. A separate host worker must
//! verify each archive's SRI bytes before safe extraction and must never run
//! package lifecycle scripts.
use std::collections::{BTreeMap, BTreeSet};

use super::locked_dependency_integrity::{
    normalize_lock_registry_url, parse_integrity, sha256_hex, validate_registry_url,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
#[path = "locked_dependency_package.rs"]
mod locked_dependency_package;
#[path = "locked_dependency_range.rs"]
mod locked_dependency_range;
#[path = "locked_dependency_strict_json.rs"]
mod strict_json;

const MAX_PACKAGE_JSON_BYTES: usize = 256 * 1024;
const MAX_LOCK_BYTES: usize = 1024 * 1024;
pub const MAX_PLAN_JSON_BYTES: usize = 1024 * 1024;
const MAX_PACKAGES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BuildTargetV1 {
    pub os: String,
    pub cpu: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PackageIntegrityV1 {
    pub algorithm: String,
    pub digest_hex: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LockedPackageV1 {
    /// Canonical path relative to the owned set root, including `node_modules/`.
    pub package_path: String,
    pub name: String,
    pub version: String,
    /// Validated lock metadata for the private fetch worker; never user-facing.
    pub resolved_url: String,
    pub integrity: PackageIntegrityV1,
    pub archive_id_sha256: String,
    /// Informational only. The worker never executes lifecycle hooks.
    pub lifecycle_scripts_skipped: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkippedOptionalPackageV1 {
    pub package_path: String,
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LockedDependencyPlanV1 {
    pub schema_version: u32,
    pub source_revision_sha256: String,
    pub package_json_sha256: String,
    pub package_lock_sha256: String,
    pub toolchain_fingerprint_sha256: String,
    pub target: BuildTargetV1,
    pub lockfile_version: u32,
    pub package_count: usize,
    pub packages: Vec<LockedPackageV1>,
    pub skipped_optional: Vec<SkippedOptionalPackageV1>,
    /// SHA-256 of canonical JSON for all other fields (this field omitted).
    pub plan_sha256: String,
}

/// An opaque identity passed between trusted host components. It deliberately
/// contains no path; filesystem descriptors remain owned by the host worker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OwnedDependencyRootHandle {
    pub set_id_sha256: String,
    pub manifest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DependencySetReceiptV1 {
    pub schema_version: u32,
    pub set_id_sha256: String,
    pub manifest_sha256: String,
    pub source_revision_sha256: String,
    pub package_lock_sha256: String,
    pub target: BuildTargetV1,
    pub package_count: usize,
    pub archive_bytes: u64,
    pub unpacked_bytes: u64,
    pub file_count: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LockedDependencyError {
    InputTooLarge,
    InvalidJson,
    DuplicateJsonKey,
    InvalidTarget,
    InvalidRevision,
    UnsupportedLock,
    PackageLimit,
    InvalidPackagePath,
    UnsupportedPackage,
    InvalidRegistryUrl,
    MissingIntegrity,
    InvalidIntegrity,
    UnsupportedRange,
    DirectDependencyMismatch,
    LockMismatch,
    PlanTooLarge,
}

impl LockedDependencyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InputTooLarge => "dependency_metadata_limit",
            Self::InvalidJson | Self::DuplicateJsonKey => "dependency_metadata_invalid",
            Self::InvalidTarget => "dependency_target_unsupported",
            Self::InvalidRevision => "dependency_source_revision_invalid",
            Self::UnsupportedLock => "dependency_lock_unsupported",
            Self::PackageLimit => "dependency_package_limit",
            Self::InvalidPackagePath => "dependency_path_invalid",
            Self::UnsupportedPackage => "dependency_package_unsupported",
            Self::InvalidRegistryUrl => "dependency_registry_url_invalid",
            Self::MissingIntegrity | Self::InvalidIntegrity => "dependency_integrity_invalid",
            Self::UnsupportedRange => "dependency_spec_unsupported",
            Self::DirectDependencyMismatch | Self::LockMismatch => "dependency_lock_mismatch",
            Self::PlanTooLarge => "dependency_plan_limit",
        }
    }
}

/// Map Rust's host target constants to npm's package platform vocabulary.
/// npm lock metadata uses `darwin`/`win32`, while Rust reports `macos`/`windows`.
pub fn current_build_target() -> Result<BuildTargetV1, LockedDependencyError> {
    target_from_host(std::env::consts::OS, std::env::consts::ARCH)
}

pub(super) fn target_from_host(
    os: &str,
    arch: &str,
) -> Result<BuildTargetV1, LockedDependencyError> {
    let os = match os {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        _ => return Err(LockedDependencyError::InvalidTarget),
    };
    let cpu = match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return Err(LockedDependencyError::InvalidTarget),
    };
    Ok(BuildTargetV1 {
        os: os.to_owned(),
        cpu: cpu.to_owned(),
    })
}

pub fn build_locked_dependency_plan(
    package_json_bytes: &[u8],
    package_lock_bytes: &[u8],
    source_revision_sha256: &str,
    target: BuildTargetV1,
    toolchain_fingerprint_sha256: &str,
) -> Result<LockedDependencyPlanV1, LockedDependencyError> {
    if package_json_bytes.len() > MAX_PACKAGE_JSON_BYTES
        || package_lock_bytes.len() > MAX_LOCK_BYTES
    {
        return Err(LockedDependencyError::InputTooLarge);
    }
    if !valid_sha256(source_revision_sha256) || !valid_sha256(toolchain_fingerprint_sha256) {
        return Err(LockedDependencyError::InvalidRevision);
    }
    validate_target(&target)?;
    let package = strict_json::parse_unique_json(package_json_bytes)?;
    let lock = strict_json::parse_unique_json(package_lock_bytes)?;
    if lock.get("lockfileVersion").and_then(Value::as_u64) != Some(3) {
        return Err(LockedDependencyError::UnsupportedLock);
    }
    let lock_packages = lock
        .get("packages")
        .and_then(Value::as_object)
        .ok_or(LockedDependencyError::InvalidJson)?;
    validate_direct_dependencies(&package, &lock)?;
    if lock_packages.len().saturating_sub(1) > MAX_PACKAGES {
        return Err(LockedDependencyError::PackageLimit);
    }

    let mut packages = Vec::with_capacity(lock_packages.len().saturating_sub(1));
    let mut skipped_optional = Vec::new();
    for (package_path, entry) in lock_packages {
        if package_path.is_empty() {
            continue;
        }
        validate_package_path(package_path)?;
        let path_name = package_name_from_path(package_path)
            .ok_or(LockedDependencyError::InvalidPackagePath)?;
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&path_name);
        if name != path_name {
            return Err(LockedDependencyError::InvalidPackagePath);
        }
        let version = entry
            .get("version")
            .and_then(Value::as_str)
            .filter(|value| valid_package_version(value))
            .ok_or(LockedDependencyError::UnsupportedPackage)?;
        if optional_lock_bool(entry, "link")? || optional_lock_bool(entry, "inBundle")? {
            return Err(LockedDependencyError::UnsupportedPackage);
        }
        let optional = optional_lock_bool(entry, "optional")?;
        let lifecycle_scripts_skipped = optional_lock_bool(entry, "hasInstallScript")?;
        let skip_reason = target_skip_reason(entry, &target)?;
        if let Some(reason) = skip_reason {
            if !optional {
                return Err(LockedDependencyError::UnsupportedPackage);
            }
            skipped_optional.push(SkippedOptionalPackageV1 {
                package_path: package_path.clone(),
                name: name.to_owned(),
                reason: reason.to_owned(),
            });
            continue;
        }
        let resolved = entry
            .get("resolved")
            .and_then(Value::as_str)
            .ok_or(LockedDependencyError::UnsupportedPackage)?;
        let resolved_url = normalize_lock_registry_url(resolved)?;
        let integrity_text = entry
            .get("integrity")
            .and_then(Value::as_str)
            .ok_or(LockedDependencyError::MissingIntegrity)?;
        let integrity = parse_integrity(integrity_text)?;
        let archive_id_sha256 =
            sha256_hex(format!("{}:{}", integrity.algorithm, integrity.digest_hex).as_bytes());
        packages.push(LockedPackageV1 {
            package_path: package_path.clone(),
            name: name.to_owned(),
            version: version.to_owned(),
            resolved_url,
            integrity,
            archive_id_sha256,
            lifecycle_scripts_skipped,
        });
    }
    validate_dependency_edges(lock_packages, &packages, &skipped_optional)?;
    packages.sort_by(|left, right| left.package_path.cmp(&right.package_path));
    skipped_optional.sort_by(|left, right| left.package_path.cmp(&right.package_path));
    let mut plan = LockedDependencyPlanV1 {
        schema_version: 1,
        source_revision_sha256: source_revision_sha256.to_owned(),
        package_json_sha256: sha256_hex(package_json_bytes),
        package_lock_sha256: sha256_hex(package_lock_bytes),
        toolchain_fingerprint_sha256: toolchain_fingerprint_sha256.to_owned(),
        target,
        lockfile_version: 3,
        package_count: packages.len(),
        packages,
        skipped_optional,
        plan_sha256: String::new(),
    };
    plan.plan_sha256 = plan_checksum(&plan)?;
    let encoded = serde_json::to_vec(&plan).map_err(|_| LockedDependencyError::InvalidJson)?;
    if encoded.len() > MAX_PLAN_JSON_BYTES {
        return Err(LockedDependencyError::PlanTooLarge);
    }
    Ok(plan)
}

/// Recompute the plan checksum at a trust boundary before a worker consumes it.
/// Verify exact compressed archive bytes against the plan's selected SRI digest.
/// The worker must call this before extracting each archive.
pub fn verify_archive_integrity(package: &LockedPackageV1, archive_bytes: &[u8]) -> bool {
    super::locked_dependency_integrity::verify_archive_integrity(&package.integrity, archive_bytes)
}

pub fn verify_plan_checksum(plan: &LockedDependencyPlanV1) -> Result<bool, LockedDependencyError> {
    if plan.schema_version != 1
        || plan.lockfile_version != 3
        || plan.package_count != plan.packages.len()
        || plan.packages.len() + plan.skipped_optional.len() > MAX_PACKAGES
        || !valid_sha256(&plan.source_revision_sha256)
        || !valid_sha256(&plan.package_json_sha256)
        || !valid_sha256(&plan.package_lock_sha256)
        || !valid_sha256(&plan.toolchain_fingerprint_sha256)
        || !valid_sha256(&plan.plan_sha256)
        || validate_target(&plan.target).is_err()
    {
        return Ok(false);
    }
    let mut previous: Option<&str> = None;
    let mut seen = BTreeSet::new();
    for package in &plan.packages {
        if validate_package_path(&package.package_path).is_err()
            || package_name_from_path(&package.package_path).as_deref()
                != Some(package.name.as_str())
            || !valid_package_version(&package.version)
            || validate_registry_url(&package.resolved_url).is_err()
            || !valid_integrity(&package.integrity)
            || !valid_sha256(&package.archive_id_sha256)
            || package.archive_id_sha256
                != sha256_hex(
                    format!(
                        "{}:{}",
                        package.integrity.algorithm, package.integrity.digest_hex
                    )
                    .as_bytes(),
                )
            || previous.is_some_and(|prior| prior >= package.package_path.as_str())
            || !seen.insert(package.package_path.as_str())
        {
            return Ok(false);
        }
        previous = Some(&package.package_path);
    }
    let mut previous_skipped: Option<&str> = None;
    for skipped in &plan.skipped_optional {
        if validate_package_path(&skipped.package_path).is_err()
            || package_name_from_path(&skipped.package_path).as_deref()
                != Some(skipped.name.as_str())
            || !matches!(
                skipped.reason.as_str(),
                "target_os_mismatch" | "target_cpu_mismatch"
            )
            || previous_skipped.is_some_and(|prior| prior >= skipped.package_path.as_str())
            || !seen.insert(skipped.package_path.as_str())
        {
            return Ok(false);
        }
        previous_skipped = Some(&skipped.package_path);
    }
    let bytes = serde_json::to_vec(plan).map_err(|_| LockedDependencyError::InvalidJson)?;
    if bytes.len() > MAX_PLAN_JSON_BYTES {
        return Err(LockedDependencyError::PlanTooLarge);
    }
    Ok(plan_checksum(plan)? == plan.plan_sha256)
}

pub fn dependency_set_id_sha256(
    plan: &LockedDependencyPlanV1,
) -> Result<String, LockedDependencyError> {
    if !verify_plan_checksum(plan)? {
        return Err(LockedDependencyError::LockMismatch);
    }
    let material = serde_json::json!({
        "schemaVersion": 1,
        "sourceRevisionSha256": plan.source_revision_sha256,
        "packageLockSha256": plan.package_lock_sha256,
        "target": plan.target,
        "toolchainFingerprintSha256": plan.toolchain_fingerprint_sha256,
        "planSha256": plan.plan_sha256,
        "archives": plan.packages.iter().map(|package| serde_json::json!({
            "packagePath": package.package_path,
            "archiveIdSha256": package.archive_id_sha256,
        })).collect::<Vec<_>>(),
        "skippedOptional": plan.skipped_optional,
    });
    let bytes = serde_json::to_vec(&canonicalize(material))
        .map_err(|_| LockedDependencyError::InvalidJson)?;
    Ok(sha256_hex(&bytes))
}

pub fn verify_dependency_receipt(
    plan: &LockedDependencyPlanV1,
    receipt: &DependencySetReceiptV1,
    handle: &OwnedDependencyRootHandle,
) -> Result<bool, LockedDependencyError> {
    let set_id = dependency_set_id_sha256(plan)?;
    Ok(receipt.schema_version == 1
        && receipt.set_id_sha256 == set_id
        && handle.set_id_sha256 == set_id
        && receipt.manifest_sha256 == handle.manifest_sha256
        && valid_sha256(&receipt.manifest_sha256)
        && receipt.source_revision_sha256 == plan.source_revision_sha256
        && receipt.package_lock_sha256 == plan.package_lock_sha256
        && receipt.target == plan.target
        && receipt.package_count == plan.package_count)
}

fn plan_checksum(plan: &LockedDependencyPlanV1) -> Result<String, LockedDependencyError> {
    let mut value = serde_json::to_value(plan).map_err(|_| LockedDependencyError::InvalidJson)?;
    let object = value
        .as_object_mut()
        .ok_or(LockedDependencyError::InvalidJson)?;
    object.remove("planSha256");
    let canonical = canonicalize(value);
    let bytes = serde_json::to_vec(&canonical).map_err(|_| LockedDependencyError::InvalidJson)?;
    if bytes.len() > MAX_PLAN_JSON_BYTES {
        return Err(LockedDependencyError::PlanTooLarge);
    }
    Ok(sha256_hex(&bytes))
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(object) => {
            let sorted = object.into_iter().collect::<BTreeMap<_, _>>();
            let mut output = Map::new();
            for (key, value) in sorted {
                output.insert(key, canonicalize(value));
            }
            Value::Object(output)
        }
        value => value,
    }
}

use locked_dependency_package::{
    optional_lock_bool, package_name_from_path, target_skip_reason, valid_integrity,
    valid_package_version, valid_sha256, validate_dependency_edges, validate_direct_dependencies,
    validate_package_path, validate_target,
};

#[cfg(test)]
#[path = "locked_dependency_registry_tests.rs"]
mod registry_url_tests;
