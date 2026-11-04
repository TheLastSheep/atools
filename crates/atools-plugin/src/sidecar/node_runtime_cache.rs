//! Explicit, offline cache API for the signed compressed Node resource.
//!
//! This module is not enabled automatically. A trusted host may opt in through
//! `NodeRuntimeSelector` by providing the app-bundled resource directory and a
//! mandatory platform verifier; configured-provider failures are terminal.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use thiserror::Error;

#[cfg(target_os = "macos")]
mod gzip;
#[cfg(target_os = "macos")]
mod lock;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod metadata;
#[cfg(target_os = "macos")]
mod unix;

#[cfg(all(test, target_os = "macos"))]
#[path = "node_runtime_cache_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeTarget {
    Aarch64AppleDarwin,
    X86_64AppleDarwin,
}

impl NodeTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Aarch64AppleDarwin => "aarch64-apple-darwin",
            Self::X86_64AppleDarwin => "x86_64-apple-darwin",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeSignaturePolicy {
    pub expected_team_id: String,
    pub approved_entitlements_sha256: String,
}

/// The host must verify the actual Mach-O signature, Team, runtime, timestamp,
/// and embedded fixed entitlements for `opened_binary`. If verification uses
/// `absolute_path`, it must confirm that path names the same opened inode.
/// Returning `Err` is fail-closed. Tests use a synthetic verifier and are not
/// evidence of a release signature.
pub trait RuntimeSignatureVerifier: Send + Sync {
    fn verify_signed_binary(
        &self,
        absolute_path: &Path,
        opened_binary: &File,
        target: NodeTarget,
        expected_team_id: &str,
        approved_entitlements_sha256: &str,
        cancelled: &AtomicBool,
    ) -> Result<(), ()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedNode {
    pub path: PathBuf,
    pub target: NodeTarget,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Error)]
pub enum NodeRuntimeCacheError {
    #[error("compressed Node runtime cache is unsupported on this platform")]
    UnsupportedPlatform,
    #[error("compressed Node runtime metadata is invalid")]
    InvalidMetadata,
    #[error("compressed Node runtime payload is invalid")]
    InvalidPayload,
    #[error("compressed Node runtime cache entry is invalid")]
    InvalidCacheEntry,
    #[error("compressed Node signature verification failed")]
    SignatureRejected,
    #[error("compressed Node runtime preparation was cancelled")]
    Cancelled,
    #[error("compressed Node runtime exceeded a fixed resource limit")]
    LimitExceeded,
    #[error("compressed Node runtime cache operation failed: {0}")]
    Io(#[from] std::io::Error),
}

/// Ensures the exact host-selected signed runtime is available in the private
/// application cache. This API performs no resource lookup, shell call, network
/// access, or fallback selection.
pub fn ensure_compressed_node(
    resource_directory: &Path,
    target: NodeTarget,
    policy: &RuntimeSignaturePolicy,
    verifier: &dyn RuntimeSignatureVerifier,
    cancelled: &AtomicBool,
) -> Result<CachedNode, NodeRuntimeCacheError> {
    #[cfg(target_os = "macos")]
    {
        macos::ensure(resource_directory, target, policy, verifier, cancelled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (resource_directory, target, policy, verifier, cancelled);
        Err(NodeRuntimeCacheError::UnsupportedPlatform)
    }
}
