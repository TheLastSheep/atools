use atools_plugin::source_build::{
    build_locked_dependency_plan, current_build_target, LockedDependencyPlanV1,
};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub(super) const PACKAGE_JSON_LIMIT: u64 = 256 * 1024;
pub(super) const PACKAGE_LOCK_LIMIT: u64 = 1024 * 1024;

pub(super) struct SourceIdentity {
    pub root: PathBuf,
    pub revision: String,
    pub package_json: Vec<u8>,
    pub package_lock: Vec<u8>,
}

pub(super) fn read_source(root: &Path, cancelled: &AtomicBool) -> Result<SourceIdentity, String> {
    if !cfg!(target_os = "macos") {
        return Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into());
    }
    let root = super::super::staging::canonical_directory(root)?;
    let (revision, _) = super::super::staging::source_digest(&root, cancelled)?;
    let package_json =
        super::super::staging::read_regular(&root.join("package.json"), PACKAGE_JSON_LIMIT)?;
    let package_lock =
        super::super::staging::read_regular(&root.join("package-lock.json"), PACKAGE_LOCK_LIMIT)?;
    let (after, _) = super::super::staging::source_digest(&root, cancelled)?;
    if revision != after {
        return Err("SOURCE_DEPENDENCY_SOURCE_CHANGED".into());
    }
    Ok(SourceIdentity {
        root,
        revision,
        package_json,
        package_lock,
    })
}

pub(super) fn build_plan(
    source: &SourceIdentity,
    toolchain_fingerprint: &str,
) -> Result<LockedDependencyPlanV1, String> {
    build_locked_dependency_plan(
        &source.package_json,
        &source.package_lock,
        &source.revision,
        current_build_target().map_err(|error| error.code())?,
        toolchain_fingerprint,
    )
    .map_err(|error| error.code().to_owned())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}
