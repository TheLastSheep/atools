//! Revalidate worker output before the host may publish its staging directory.
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use atools_plugin::source_build::{
    verify_dependency_receipt, verify_plan_checksum, DependencySetReceiptV1,
    LockedDependencyPlanV1, OwnedDependencyRootHandle, MAX_PLAN_JSON_BYTES,
};
use sha2::{Digest, Sha256};

use super::manifest::SetManifest;

const MANIFEST_NAME: &str = ".atools-dependency-set-v1.json";
const MANIFEST_MODE: u32 = 0o600;

pub(super) fn verify_stage_output(
    stage_root: &Path,
    plan_bytes: &[u8],
    receipt: &DependencySetReceiptV1,
) -> Result<(), &'static str> {
    if plan_bytes.is_empty() || plan_bytes.len() > MAX_PLAN_JSON_BYTES {
        return Err("dependency_worker_receipt_invalid");
    }
    let plan: LockedDependencyPlanV1 =
        serde_json::from_slice(plan_bytes).map_err(|_| "dependency_worker_receipt_invalid")?;
    if !verify_plan_checksum(&plan).map_err(|_| "dependency_worker_receipt_invalid")? {
        return Err("dependency_worker_receipt_invalid");
    }
    let handle = OwnedDependencyRootHandle {
        set_id_sha256: receipt.set_id_sha256.clone(),
        manifest_sha256: receipt.manifest_sha256.clone(),
    };
    if !verify_dependency_receipt(&plan, receipt, &handle)
        .map_err(|_| "dependency_worker_receipt_invalid")?
    {
        return Err("dependency_worker_receipt_invalid");
    }
    let (manifest, bytes) = read_manifest(stage_root)?;
    if sha256_hex(&bytes) != receipt.manifest_sha256 || !manifest_matches(&manifest, &plan, receipt)
    {
        return Err("dependency_worker_receipt_invalid");
    }
    Ok(())
}

fn read_manifest(stage_root: &Path) -> Result<(SetManifest, Vec<u8>), &'static str> {
    let path = stage_root.join(MANIFEST_NAME);
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    let mut file = options
        .open(path)
        .map_err(|_| "dependency_worker_manifest_unavailable")?;
    let before = file
        .metadata()
        .map_err(|_| "dependency_worker_manifest_unavailable")?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.permissions().mode() & 0o777 != MANIFEST_MODE
        || before.len() > MAX_PLAN_JSON_BYTES as u64
    {
        return Err("dependency_worker_manifest_invalid");
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take((MAX_PLAN_JSON_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "dependency_worker_manifest_invalid")?;
    let after = file
        .metadata()
        .map_err(|_| "dependency_worker_manifest_invalid")?;
    if bytes.is_empty() || bytes.len() > MAX_PLAN_JSON_BYTES || !same_file(&before, &after) {
        return Err("dependency_worker_manifest_invalid");
    }
    let manifest =
        serde_json::from_slice(&bytes).map_err(|_| "dependency_worker_manifest_invalid")?;
    Ok((manifest, bytes))
}

fn same_file(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.uid() == after.uid()
        && before.mode() == after.mode()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn manifest_matches(
    manifest: &SetManifest,
    plan: &LockedDependencyPlanV1,
    receipt: &DependencySetReceiptV1,
) -> bool {
    if manifest.schema_version != 1
        || manifest.set_id_sha256 != receipt.set_id_sha256
        || manifest.plan_sha256 != plan.plan_sha256
        || manifest.source_revision_sha256 != plan.source_revision_sha256
        || manifest.package_lock_sha256 != plan.package_lock_sha256
        || manifest.target.os != plan.target.os
        || manifest.target.cpu != plan.target.cpu
        || manifest.package_count != plan.packages.len()
        || manifest.skipped_optional_count != plan.skipped_optional.len()
        || manifest.packages.len() != plan.packages.len()
        || manifest.archive_bytes != receipt.archive_bytes
        || manifest.unpacked_bytes != receipt.unpacked_bytes
        || manifest.file_count != receipt.file_count
    {
        return false;
    }
    manifest
        .packages
        .iter()
        .zip(&plan.packages)
        .all(|(record, package)| {
            record.package_path == package.package_path
                && record.name == package.name
                && record.version == package.version
                && record.archive_id_sha256 == package.archive_id_sha256
        })
        && manifest
            .packages
            .iter()
            .try_fold((0u64, 0u64, 0u64), |totals, record| {
                Some((
                    totals.0.checked_add(record.archive_bytes)?,
                    totals.1.checked_add(record.unpacked_bytes)?,
                    totals.2.checked_add(record.file_count)?,
                ))
            })
            == Some((
                manifest.archive_bytes,
                manifest.unpacked_bytes,
                manifest.file_count,
            ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
