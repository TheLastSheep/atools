//! Explicit, permission-gated preparation of locked source-build dependencies.
//! This service never runs npm or package lifecycle scripts.
//! The materializer currently has a macOS-only filesystem/sandbox implementation.
mod fallback_policy;
mod registry;

#[cfg(target_os = "macos")]
mod archive_store;
#[cfg(target_os = "macos")]
mod cache_inventory;
#[cfg(target_os = "macos")]
mod converted_package;
#[cfg(target_os = "macos")]
mod diagnostics;
#[cfg(target_os = "macos")]
mod fetch;
#[cfg(target_os = "macos")]
mod identity;
#[cfg(target_os = "macos")]
mod materialize;
#[cfg(target_os = "macos")]
mod registry_store;
#[cfg(target_os = "macos")]
mod service;
#[cfg(target_os = "macos")]
mod toolchain_fingerprint;
#[cfg(target_os = "macos")]
mod tree_inventory;

#[cfg(not(target_os = "macos"))]
mod unsupported;

#[cfg(all(feature = "source-dependency-smoke", target_os = "macos"))]
pub(crate) mod native_smoke;

/// Platform-neutral result shape used by the conversion fallback.
/// The non-macOS facade returns a fixed unsupported error before producing one.
pub(super) struct ConversionDependencies {
    pub dependency_home: std::path::PathBuf,
    pub node_path: std::path::PathBuf,
    pub toolchain_fingerprint_sha256: String,
    pub dependency_set_id_sha256: String,
    pub dependency_tree_sha256: String,
}

pub(crate) use registry::{
    definitions, is_dependency_tool, is_mutating_tool, is_tool, FETCH, INSPECT, PREPARE,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConvertedPackageTree {
    pub sha256: String,
    pub entries: u64,
    pub files: u64,
    pub bytes: u64,
}

#[cfg(target_os = "macos")]
pub(in crate::plugin_source_build) use converted_package::{
    calculate_converted_package_tree, read_converted_handoff, read_converted_package_manifest,
    read_converted_source_evidence,
};
#[cfg(not(target_os = "macos"))]
pub(super) fn calculate_converted_package_tree(
    _: &std::path::Path,
) -> Result<ConvertedPackageTree, String> {
    Err("SOURCE_BUILD_PLATFORM_UNSUPPORTED".into())
}
#[cfg(not(target_os = "macos"))]
pub(super) fn read_converted_handoff(_: &std::path::Path) -> Result<Vec<u8>, String> {
    Err("SOURCE_BUILD_PLATFORM_UNSUPPORTED".into())
}
#[cfg(not(target_os = "macos"))]
pub(super) fn read_converted_source_evidence(_: &std::path::Path) -> Result<Vec<u8>, String> {
    Err("SOURCE_BUILD_PLATFORM_UNSUPPORTED".into())
}
#[cfg(not(target_os = "macos"))]
pub(super) fn read_converted_package_manifest(_: &std::path::Path) -> Result<Vec<u8>, String> {
    Err("SOURCE_BUILD_PLATFORM_UNSUPPORTED".into())
}
pub(super) use fallback_policy::allows_prepared_dependency_fallback as allows_conversion_fallback;

#[cfg(target_os = "macos")]
pub(super) use service::prepared_for_conversion;
#[cfg(not(target_os = "macos"))]
pub(super) use unsupported::prepared_for_conversion;

#[cfg(target_os = "macos")]
pub(crate) use service::{execute, request_cancel, state};
#[cfg(not(target_os = "macos"))]
pub(crate) use unsupported::{execute, request_cancel, state};
