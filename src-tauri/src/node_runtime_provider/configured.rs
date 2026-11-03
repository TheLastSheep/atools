#[cfg(target_os = "macos")]
use atools_plugin::sidecar::node_runtime_cache::NodeTarget;
use atools_plugin::sidecar::node_runtime_cache::{
    CachedNode, NodeRuntimeCacheError, RuntimeSignaturePolicy,
};
use atools_plugin::sidecar::{CompressedNodeRuntimeProvider, NodeRuntimeSelector};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod macos;

const APP_IDENTIFIER: &str = "dev.atools.desktop";
const APPROVED_ENTITLEMENTS_SHA256: &str =
    "3726221a606dae99b53f3f561754842b0e18fad422c134479e4a5fa9a5f466a4";

struct BundledRuntimeProvider {
    resource_directory: Option<PathBuf>,
    app_bundle: Option<PathBuf>,
    identifier_matches: bool,
    policy: RuntimeSignaturePolicy,
}

impl CompressedNodeRuntimeProvider for BundledRuntimeProvider {
    fn ensure_node(&self, cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        #[cfg(target_os = "macos")]
        {
            let resource_directory = self
                .resource_directory
                .as_deref()
                .ok_or(NodeRuntimeCacheError::InvalidCacheEntry)?;
            let app_bundle = self
                .app_bundle
                .as_deref()
                .ok_or(NodeRuntimeCacheError::InvalidCacheEntry)?;
            if !self.identifier_matches || self.policy.expected_team_id.is_empty() {
                return Err(NodeRuntimeCacheError::SignatureRejected);
            }
            macos::verify_app_bundle(
                app_bundle,
                resource_directory,
                APP_IDENTIFIER,
                &self.policy.expected_team_id,
                cancelled,
            )
            .map_err(|_| NodeRuntimeCacheError::SignatureRejected)?;
            let target = current_target().ok_or(NodeRuntimeCacheError::UnsupportedPlatform)?;
            let verifier = macos::CodesignVerifier;
            atools_plugin::sidecar::node_runtime_cache::ensure_compressed_node(
                resource_directory,
                target,
                &self.policy,
                &verifier,
                cancelled,
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = cancelled;
            Err(NodeRuntimeCacheError::UnsupportedPlatform)
        }
    }
}

pub(super) fn for_app<R: Runtime>(app: &AppHandle<R>) -> NodeRuntimeSelector {
    let team_id = option_env!("ATOOLS_NODE_RUNTIME_EXPECTED_TEAM_ID")
        .unwrap_or_default()
        .to_owned();
    let resource_root = app.path().resource_dir().ok();
    let resource_directory = app
        .path()
        .resolve("node-runtime/compressed", BaseDirectory::Resource)
        .ok();
    let app_bundle = resource_root
        .as_deref()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(PathBuf::from);
    let provider = BundledRuntimeProvider {
        resource_directory,
        app_bundle,
        identifier_matches: app.config().identifier == APP_IDENTIFIER,
        policy: RuntimeSignaturePolicy {
            expected_team_id: team_id,
            approved_entitlements_sha256: APPROVED_ENTITLEMENTS_SHA256.to_owned(),
        },
    };
    NodeRuntimeSelector::with_compressed_provider(Arc::new(provider))
}

#[cfg(target_os = "macos")]
fn current_target() -> Option<NodeTarget> {
    #[cfg(target_arch = "aarch64")]
    {
        Some(NodeTarget::Aarch64AppleDarwin)
    }
    #[cfg(target_arch = "x86_64")]
    {
        Some(NodeTarget::X86_64AppleDarwin)
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    {
        None
    }
}
