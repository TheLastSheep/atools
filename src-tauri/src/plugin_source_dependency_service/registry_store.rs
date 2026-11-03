use super::{
    archive_store::{validate_id, ArchiveStore},
    identity,
};
use atools_plugin::source_build::{
    dependency_set_id_sha256, verify_dependency_receipt, DependencySetReceiptV1,
    LockedDependencyPlanV1, OwnedDependencyRootHandle,
};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr, os::unix::fs::MetadataExt, path::Path, sync::atomic::AtomicBool, time::Instant,
};

const HOST_RECEIPT: &str = ".atools-host-receipt-v1.json";
const WORKER_MANIFEST: &str = ".atools-dependency-set-v1.json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkerManifest {
    schema_version: u32,
    set_id_sha256: String,
    plan_sha256: String,
    source_revision_sha256: String,
    package_lock_sha256: String,
    target: ManifestTarget,
    packages: Vec<ManifestPackage>,
    skipped_optional_count: usize,
    package_count: usize,
    archive_bytes: u64,
    unpacked_bytes: u64,
    file_count: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ManifestTarget {
    os: String,
    cpu: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ManifestPackage {
    package_path: String,
    name: String,
    version: String,
    archive_id_sha256: String,
    archive_bytes: u64,
    unpacked_bytes: u64,
    file_count: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HostSetReceiptV1 {
    schema_version: u32,
    set_id_sha256: String,
    plan_sha256: String,
    worker_receipt: DependencySetReceiptV1,
    tree_sha256: String,
    tree_entries: u64,
    tree_files: u64,
    tree_bytes: u64,
}

pub(super) struct VerifiedSet {
    pub set_id: String,
    pub dependency_home: std::path::PathBuf,
    pub receipt: DependencySetReceiptV1,
    pub tree_sha256: String,
    pub tree_entries: u64,
    pub tree_files: u64,
    pub tree_bytes: u64,
}

pub(super) fn verify_existing(
    store: &ArchiveStore,
    plan: &LockedDependencyPlanV1,
    cancelled: &AtomicBool,
) -> Result<Option<VerifiedSet>, String> {
    verify_existing_since(store, plan, cancelled, Instant::now())
}

pub(super) fn verify_existing_since(
    store: &ArchiveStore,
    plan: &LockedDependencyPlanV1,
    cancelled: &AtomicBool,
    started: Instant,
) -> Result<Option<VerifiedSet>, String> {
    let set_id = dependency_set_id_sha256(plan).map_err(|_| "SOURCE_DEPENDENCY_PLAN_INVALID")?;
    validate_id(&set_id)?;
    let sets = store.sets();
    let name = OsStr::new(&set_id);
    let Some(meta) = sets.child_metadata_optional(name)? else {
        return Ok(None);
    };
    if meta.st_mode & libc::S_IFMT != libc::S_IFDIR
        || meta.st_uid != unsafe { libc::geteuid() }
        || meta.st_mode & 0o077 != 0
    {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let directory = sets.open_directory(name, Some(&meta))?;
    let receipt_bytes = ArchiveStore::read_bounded_child(&directory, HOST_RECEIPT, 16 * 1024)?;
    let host_receipt: HostSetReceiptV1 =
        serde_json::from_slice(&receipt_bytes).map_err(|_| "SOURCE_DEPENDENCY_SET_INVALID")?;
    if host_receipt.schema_version != 1
        || host_receipt.set_id_sha256 != set_id
        || host_receipt.plan_sha256 != plan.plan_sha256
        || host_receipt.tree_sha256.len() != 64
        || !host_receipt
            .tree_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let receipt = host_receipt.worker_receipt;
    let handle = OwnedDependencyRootHandle {
        set_id_sha256: receipt.set_id_sha256.clone(),
        manifest_sha256: receipt.manifest_sha256.clone(),
    };
    if !verify_dependency_receipt(plan, &receipt, &handle)
        .map_err(|_| "SOURCE_DEPENDENCY_SET_INVALID")?
    {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let manifest_bytes =
        ArchiveStore::read_bounded_child(&directory, WORKER_MANIFEST, 1024 * 1024)?;
    if identity::sha256(&manifest_bytes) != receipt.manifest_sha256 {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let manifest: WorkerManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| "SOURCE_DEPENDENCY_SET_INVALID")?;
    if !manifest_matches(&manifest, plan, &receipt) {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let dependency_home = store.set_path(&set_id);
    let set_root = super::super::staging::Directory::absolute(&dependency_home)?;
    let node_modules = set_root
        .child_metadata_optional(OsStr::new("node_modules"))?
        .ok_or("SOURCE_DEPENDENCY_SET_INVALID")?;
    if node_modules.st_mode & libc::S_IFMT != libc::S_IFDIR
        || node_modules.st_uid != unsafe { libc::geteuid() }
        || node_modules.st_mode & 0o7022 != 0
    {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let _ = set_root.open_directory(OsStr::new("node_modules"), Some(&node_modules))?;
    let inventory = super::tree_inventory::calculate_since(&set_root, cancelled, started)?;
    if inventory.sha256 != host_receipt.tree_sha256
        || inventory.entries != host_receipt.tree_entries
        || inventory.files != host_receipt.tree_files
        || inventory.bytes != host_receipt.tree_bytes
        || !store
            .sets()
            .is_same_child(OsStr::new(&set_id), &set_root.metadata()?)?
    {
        return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
    }
    Ok(Some(VerifiedSet {
        set_id,
        dependency_home,
        receipt,
        tree_sha256: inventory.sha256,
        tree_entries: inventory.entries,
        tree_files: inventory.files,
        tree_bytes: inventory.bytes,
    }))
}

pub(super) fn publish_verified_stage<F>(
    store: &ArchiveStore,
    workspace: super::super::staging::Workspace,
    plan: &LockedDependencyPlanV1,
    receipt: DependencySetReceiptV1,
    cancelled: &AtomicBool,
    stage_started: Instant,
    before_publish: F,
) -> Result<VerifiedSet, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let set_id = dependency_set_id_sha256(plan).map_err(|_| "SOURCE_DEPENDENCY_PLAN_INVALID")?;
    let root = workspace.root_directory()?;
    match verify_staged(workspace.root.as_path(), plan, &receipt)? {
        true => {}
        false => return Err("SOURCE_DEPENDENCY_SET_INVALID".into()),
    }
    let inventory = super::tree_inventory::calculate_since(&root, cancelled, stage_started)?;
    let host_receipt = HostSetReceiptV1 {
        schema_version: 1,
        set_id_sha256: set_id.clone(),
        plan_sha256: plan.plan_sha256.clone(),
        worker_receipt: receipt,
        tree_sha256: inventory.sha256.clone(),
        tree_entries: inventory.entries,
        tree_files: inventory.files,
        tree_bytes: inventory.bytes,
    };
    let bytes = serde_json::to_vec(&host_receipt).map_err(|_| "SOURCE_DEPENDENCY_SET_INVALID")?;
    if bytes.len() > 16 * 1024 {
        return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
    }
    let cache_bytes = store.cache_totals_since(cancelled, stage_started)?;
    let candidate_cache_bytes = cache_bytes
        .checked_add(inventory.bytes)
        .and_then(|value| value.checked_add(bytes.len() as u64))
        .ok_or("SOURCE_DEPENDENCY_CACHE_LIMIT")?;
    if candidate_cache_bytes > super::archive_store::GLOBAL_CACHE_LIMIT {
        return Err("SOURCE_DEPENDENCY_CACHE_LIMIT".into());
    }
    store.write_receipt_file(&root, &bytes)?;
    let current = super::tree_inventory::calculate_since(&root, cancelled, stage_started)?;
    if current != inventory {
        return Err("SOURCE_DEPENDENCY_SET_CHANGED".into());
    }
    before_publish()?;
    match workspace.publish_to(store.sets(), std::ffi::OsStr::new(&set_id)) {
        Ok(()) => {}
        Err(error) if error == "SourceBuildDestinationExists" => {
            if verify_existing_since(store, plan, cancelled, stage_started)?.is_none() {
                return Err("SOURCE_DEPENDENCY_SET_INVALID".into());
            }
        }
        Err(error) => return Err(error),
    }
    verify_existing_since(store, plan, cancelled, stage_started)?
        .ok_or_else(|| "SOURCE_DEPENDENCY_SET_INVALID".into())
}

fn verify_staged(
    root: &Path,
    plan: &LockedDependencyPlanV1,
    receipt: &DependencySetReceiptV1,
) -> Result<bool, String> {
    let directory = super::super::staging::Directory::absolute(root)?;
    let manifest_bytes =
        ArchiveStore::read_bounded_child(&directory, WORKER_MANIFEST, 1024 * 1024)?;
    if manifest_bytes.len() > 1024 * 1024
        || identity::sha256(&manifest_bytes) != receipt.manifest_sha256
    {
        return Ok(false);
    }
    let manifest: WorkerManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| "SOURCE_DEPENDENCY_SET_INVALID")?;
    Ok(manifest_matches(&manifest, plan, receipt))
}

fn manifest_matches(
    manifest: &WorkerManifest,
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
        || manifest.package_count != plan.package_count
        || manifest.skipped_optional_count != plan.skipped_optional.len()
        || manifest.packages.len() != plan.packages.len()
        || manifest.archive_bytes != receipt.archive_bytes
        || manifest.unpacked_bytes != receipt.unpacked_bytes
        || manifest.file_count != receipt.file_count
    {
        return false;
    }
    let identities_match =
        manifest
            .packages
            .iter()
            .zip(&plan.packages)
            .all(|(actual, expected)| {
                actual.package_path == expected.package_path
                    && actual.name == expected.name
                    && actual.version == expected.version
                    && actual.archive_id_sha256 == expected.archive_id_sha256
            });
    let totals = manifest
        .packages
        .iter()
        .try_fold((0u64, 0u64, 0u64), |sum, item| {
            Some((
                sum.0.checked_add(item.archive_bytes)?,
                sum.1.checked_add(item.unpacked_bytes)?,
                sum.2.checked_add(item.file_count)?,
            ))
        });
    identities_match
        && totals
            == Some((
                manifest.archive_bytes,
                manifest.unpacked_bytes,
                manifest.file_count,
            ))
}
