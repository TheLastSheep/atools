//! One asynchronous selection path for Node sidecars and CJS preload bridges.
//!
//! A configured compressed provider is strict: it is consulted only after an
//! explicit `ATOOLS_NODE_BINARY` override, and any provider error is terminal.
//! `None` means no compressed runtime is configured; `Some` means required.
//! Only the trusted host knows whether its app profile expects the payload and
//! should configure a provider accordingly. Worker cancellation is cooperative:
//! dropping this future signals the worker, which may still be cleaning up.

use super::node_runtime;
use super::node_runtime_cache::{CachedNode, NodeRuntimeCacheError};
use super::supervisor::SidecarError;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// First-use decompression and signature/cache preparation budget. This is
/// separate from the sidecar process/bootstrap startup deadline.
pub const NODE_RUNTIME_PREPARATION_BUDGET: Duration = Duration::from_secs(15);

/// Trusted host adapter for an app-bundled compressed Node payload.
///
/// Implementations must call the signed cache API with a fixed resource path,
/// Team/entitlements policy and verifier. A configured provider must reject an
/// absent or invalid required payload rather than falling back to PATH.
pub trait CompressedNodeRuntimeProvider: Send + Sync + 'static {
    fn ensure_node(&self, cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError>;
}

#[derive(Clone, Default)]
pub struct NodeRuntimeSelector {
    compressed: Option<Arc<dyn CompressedNodeRuntimeProvider>>,
}

impl std::fmt::Debug for NodeRuntimeSelector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NodeRuntimeSelector")
            .field("compressed_provider_configured", &self.compressed.is_some())
            .finish()
    }
}

impl NodeRuntimeSelector {
    /// Keep the existing workstation resolver when no signed payload is configured.
    pub fn system_default() -> Self {
        Self::default()
    }

    /// Configure strict use of the host-owned app payload after explicit override.
    pub fn with_compressed_provider(
        provider: Arc<dyn CompressedNodeRuntimeProvider>,
    ) -> Self {
        Self {
            compressed: Some(provider),
        }
    }

    /// Resolve asynchronously; dropping this future signals cooperative cancellation.
    pub async fn resolve_node_binary(&self) -> Result<PathBuf, SidecarError> {
        self.resolve_node_binary_with_cancellation(Arc::new(AtomicBool::new(false)))
            .await
    }

    /// Resolve for a new process while keeping cold runtime preparation outside
    /// the process startup deadline. The legacy resolver still uses the supplied
    /// startup budget; a configured compressed provider gets the bounded
    /// preparation budget above.
    pub async fn resolve_node_binary_for_startup(
        &self,
        cancelled: Arc<AtomicBool>,
        process_startup_budget: Duration,
    ) -> Result<PathBuf, SidecarError> {
        let selection_budget = if self.compressed.is_some() {
            NODE_RUNTIME_PREPARATION_BUDGET
        } else {
            process_startup_budget
        };
        self.resolve_node_binary_with_budget(cancelled, Some(selection_budget)).await
    }

    /// Resolve while observing an operation-owned cancellation flag.
    pub async fn resolve_node_binary_with_cancellation(
        &self,
        cancelled: Arc<AtomicBool>,
    ) -> Result<PathBuf, SidecarError> {
        let budget = self
            .compressed
            .as_ref()
            .map(|_| NODE_RUNTIME_PREPARATION_BUDGET);
        self.resolve_node_binary_with_budget(cancelled, budget).await
    }

    async fn resolve_node_binary_with_budget(
        &self,
        cancelled: Arc<AtomicBool>,
        budget: Option<Duration>,
    ) -> Result<PathBuf, SidecarError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(SidecarError::Cancelled);
        }
        if let Some(budget) = budget {
            if budget.is_zero() {
                cancelled.store(true, Ordering::Release);
                return Err(SidecarError::Timeout(0));
            }
        }
        let started = tokio::time::Instant::now();
        let mut guard = CancelOnDrop::new(cancelled.clone());
        let selector = self.clone();
        let worker_cancelled = Arc::clone(&cancelled);
        let mut worker = tokio::task::spawn_blocking(move || selector.resolve_blocking(&worker_cancelled));
        let joined = match budget {
            Some(budget) => match tokio::time::timeout(budget, &mut worker).await {
                Ok(joined) => joined,
                Err(_) => {
                    cancelled.store(true, Ordering::Release);
                    let _worker_result = worker.await.map_err(|_| SidecarError::Spawn("Node runtime selection worker failed during cancellation cleanup".into()))?;
                    guard.disarm();
                    return Err(SidecarError::Timeout(budget.as_millis().min(u64::MAX as u128) as u64));
                }
            },
            None => worker.await,
        };
        let result = joined
            .map_err(|_| SidecarError::Spawn("Node runtime selection worker failed".into()))?;
        if let Some(budget) = budget {
            if started.elapsed() >= budget {
                guard.disarm();
                return Err(SidecarError::Timeout(budget.as_millis().min(u64::MAX as u128) as u64));
            }
        }
        guard.disarm();
        finish_selection(result, &cancelled)
    }

    fn resolve_blocking(&self, cancelled: &AtomicBool) -> Result<PathBuf, SidecarError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(SidecarError::Cancelled);
        }

        #[cfg(target_os = "macos")]
        if let Some(provider) = self.compressed.as_deref() {
            return select_with_compressed_provider(
                node_runtime::resolve_explicit_node_binary(),
                Some(provider),
                cancelled,
                || node_runtime::resolve_node_binary(),
            );
        }

        #[cfg(not(target_os = "macos"))]
        if self.compressed.is_some() {
            return reject_unsupported_compressed_provider(
                node_runtime::resolve_explicit_node_binary(),
            );
        }

        // Compressed runtime integration is macOS-only; development and other
        // platforms retain the existing resolver and its explicit override rules.
        let _ = &self.compressed;
        node_runtime::resolve_node_binary()
    }
}

#[cfg(not(target_os = "macos"))]
fn reject_unsupported_compressed_provider(
    explicit: Result<Option<PathBuf>, SidecarError>,
) -> Result<PathBuf, SidecarError> {
    if let Some(path) = explicit? {
        return Ok(path);
    }
    Err(SidecarError::Spawn(
        "Bundled Node runtime provider is unsupported on this platform".into(),
    ))
}

fn finish_selection(
    result: Result<PathBuf, SidecarError>,
    cancelled: &AtomicBool,
) -> Result<PathBuf, SidecarError> {
    if cancelled.load(Ordering::Acquire) {
        Err(SidecarError::Cancelled)
    } else {
        result
    }
}

fn select_with_compressed_provider(
    explicit: Result<Option<PathBuf>, SidecarError>,
    provider: Option<&dyn CompressedNodeRuntimeProvider>,
    cancelled: &AtomicBool,
    fallback: impl FnOnce() -> Result<PathBuf, SidecarError>,
) -> Result<PathBuf, SidecarError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(SidecarError::Cancelled);
    }
    if let Some(path) = explicit? {
        return Ok(path);
    }
    if let Some(provider) = provider {
        return provider
            .ensure_node(cancelled)
            .map(|node| node.path)
            .map_err(|error| {
                if matches!(error, NodeRuntimeCacheError::Cancelled) {
                    SidecarError::Cancelled
                } else {
                    SidecarError::Spawn(
                        "Bundled Node runtime is invalid or unavailable".into(),
                    )
                }
            });
    }
    fallback()
}

struct CancelOnDrop {
    cancelled: Arc<AtomicBool>,
    armed: bool,
}

impl CancelOnDrop {
    fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancelled.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
#[path = "node_runtime_selection_tests.rs"]
mod tests;
