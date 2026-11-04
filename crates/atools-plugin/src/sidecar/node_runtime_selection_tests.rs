use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::time::Duration;

struct ResultProvider {
    calls: AtomicUsize,
    fail: bool,
}

impl CompressedNodeRuntimeProvider for ResultProvider {
    fn ensure_node(&self, _cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            Err(NodeRuntimeCacheError::InvalidPayload)
        } else {
            Ok(cached("/cache/node"))
        }
    }
}

fn cached(path: &str) -> CachedNode {
    CachedNode {
        path: PathBuf::from(path),
        target: super::super::node_runtime_cache::NodeTarget::Aarch64AppleDarwin,
        sha256: "a".repeat(64),
        bytes: 1,
    }
}

#[test]
fn explicit_override_precedes_provider_and_invalid_override_never_falls_back() {
    let provider = ResultProvider {
        calls: AtomicUsize::new(0),
        fail: false,
    };
    let cancel = AtomicBool::new(false);
    let fallback_calls = AtomicUsize::new(0);
    let explicit = select_with_compressed_provider(
        Ok(Some(PathBuf::from("/explicit/node"))),
        Some(&provider),
        &cancel,
        || {
            fallback_calls.fetch_add(1, Ordering::SeqCst);
            Ok(PathBuf::from("/path/node"))
        },
    )
    .unwrap();
    assert_eq!(explicit, PathBuf::from("/explicit/node"));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);

    let invalid = select_with_compressed_provider(
        Err(SidecarError::Spawn("invalid explicit override".into())),
        Some(&provider),
        &cancel,
        || {
            fallback_calls.fetch_add(1, Ordering::SeqCst);
            Ok(PathBuf::from("/path/node"))
        },
    );
    assert!(matches!(invalid, Err(SidecarError::Spawn(_))));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fallback_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn configured_provider_failure_is_terminal_but_absent_provider_uses_legacy_fallback() {
    let provider = ResultProvider {
        calls: AtomicUsize::new(0),
        fail: true,
    };
    let cancel = AtomicBool::new(false);
    let fallback_calls = AtomicUsize::new(0);
    let invalid_payload =
        select_with_compressed_provider(Ok(None), Some(&provider), &cancel, || {
            fallback_calls.fetch_add(1, Ordering::SeqCst);
            Ok(PathBuf::from("/path/node"))
        });
    assert!(matches!(invalid_payload, Err(SidecarError::Spawn(_))));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fallback_calls.load(Ordering::SeqCst), 0);

    let fallback = select_with_compressed_provider(Ok(None), None, &cancel, || {
        fallback_calls.fetch_add(1, Ordering::SeqCst);
        Ok(PathBuf::from("/path/node"))
    })
    .unwrap();
    assert_eq!(fallback, PathBuf::from("/path/node"));
    assert_eq!(fallback_calls.load(Ordering::SeqCst), 1);
}

struct CancelThenSuccessProvider {
    calls: Arc<AtomicUsize>,
}

impl CompressedNodeRuntimeProvider for CancelThenSuccessProvider {
    fn ensure_node(&self, cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        cancelled.store(true, Ordering::Release);
        Ok(cached("/cache/node"))
    }
}

#[test]
fn cancellation_after_worker_completion_discards_a_successful_result() {
    let cancelled = AtomicBool::new(false);
    let provider = CancelThenSuccessProvider {
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let result = provider
        .ensure_node(&cancelled)
        .map(|node| node.path)
        .map_err(|_| SidecarError::Spawn("test provider failed".into()));
    assert!(matches!(
        finish_selection(result, &cancelled),
        Err(SidecarError::Cancelled)
    ));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn async_selector_discards_provider_success_when_cancelled_before_join() {
    // An explicit override takes priority and would bypass this provider fixture.
    if std::env::var_os("ATOOLS_NODE_BINARY").is_some() {
        return;
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let selector =
        NodeRuntimeSelector::with_compressed_provider(Arc::new(CancelThenSuccessProvider {
            calls: Arc::clone(&calls),
        }));
    let result = selector
        .resolve_node_binary_with_cancellation(Arc::new(AtomicBool::new(false)))
        .await;
    assert!(matches!(result, Err(SidecarError::Cancelled)));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[cfg(not(target_os = "macos"))]
#[test]
fn configured_compressed_provider_fails_closed_off_macos_after_explicit_override() {
    let unsupported = reject_unsupported_compressed_provider(Ok(None));
    assert!(matches!(unsupported, Err(SidecarError::Spawn(_))));

    let explicit =
        reject_unsupported_compressed_provider(Ok(Some(PathBuf::from("/explicit/node")))).unwrap();
    assert_eq!(explicit, PathBuf::from("/explicit/node"));

    let invalid = reject_unsupported_compressed_provider(Err(SidecarError::Spawn(
        "invalid explicit override".into(),
    )));
    assert!(matches!(invalid, Err(SidecarError::Spawn(_))));
}

struct PanicProvider;

impl CompressedNodeRuntimeProvider for PanicProvider {
    fn ensure_node(&self, _cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        panic!("zero startup budget must not invoke runtime selection")
    }
}

#[tokio::test]
async fn zero_startup_budget_times_out_before_sidecar_spawn() {
    use super::super::{SidecarLaunchSpec, SidecarProcess};
    use atools_core::{PluginRuntimeKind, PluginRuntimeTransport};
    use std::collections::BTreeMap;

    let spec = SidecarLaunchSpec {
        plugin_id: "zero-startup-budget-test".into(),
        plugin_dir: PathBuf::from("/tmp/b306-nonexistent-plugin-root"),
        entry: PathBuf::from("/tmp/b306-nonexistent-plugin-root/missing.js"),
        runtime: PluginRuntimeKind::Rust,
        transport: PluginRuntimeTransport::JsonRpcStdio,
        args: Vec::new(),
        env: BTreeMap::new(),
        startup_timeout: Duration::ZERO,
        request_timeout: Duration::from_secs(1),
    };
    let selector = NodeRuntimeSelector::with_compressed_provider(Arc::new(PanicProvider));
    let result = SidecarProcess::spawn_with_node_runtime_selector(
        spec,
        selector,
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    assert!(matches!(result, Err(SidecarError::Timeout(0))));
}

#[cfg(target_os = "macos")]
struct GatedProvider {
    entered: tokio::sync::mpsc::UnboundedSender<()>,
    released: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
impl CompressedNodeRuntimeProvider for GatedProvider {
    fn ensure_node(&self, cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        let _ = self.entered.send(());
        while !self.released.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(NodeRuntimeCacheError::Cancelled);
        }
        Ok(cached("/cache/node"))
    }
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "current_thread")]
async fn blocking_selection_does_not_block_async_heartbeat() {
    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let released = Arc::new(AtomicBool::new(false));
    let selector = NodeRuntimeSelector::with_compressed_provider(Arc::new(GatedProvider {
        entered: entered_tx,
        released: Arc::clone(&released),
    }));
    let ticks = Arc::new(AtomicUsize::new(0));
    let heartbeat_ticks = Arc::clone(&ticks);
    let heartbeat = tokio::spawn(async move {
        loop {
            heartbeat_ticks.fetch_add(1, Ordering::Relaxed);
            tokio::task::yield_now().await;
        }
    });
    let resolution = tokio::spawn(async move { selector.resolve_node_binary().await });
    tokio::time::timeout(Duration::from_secs(2), entered_rx.recv())
        .await
        .expect("blocking provider should start without blocking the runtime")
        .expect("provider signal");
    assert!(
        ticks.load(Ordering::Relaxed) > 0,
        "async heartbeat ran while provider was blocked"
    );
    released.store(true, Ordering::Release);
    assert_eq!(
        resolution.await.unwrap().unwrap(),
        PathBuf::from("/cache/node")
    );
    heartbeat.abort();
}

#[cfg(target_os = "macos")]
struct CancelledProvider {
    entered: mpsc::Sender<()>,
    finished: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
impl CompressedNodeRuntimeProvider for CancelledProvider {
    fn ensure_node(&self, cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        let _ = self.entered.send(());
        while !cancelled.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
        self.finished.store(true, Ordering::Release);
        Err(NodeRuntimeCacheError::Cancelled)
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn dropping_resolution_signals_worker_and_worker_reaches_terminal_state() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let selector = NodeRuntimeSelector::with_compressed_provider(Arc::new(CancelledProvider {
        entered: entered_tx,
        finished: Arc::clone(&finished),
    }));
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let task = tokio::spawn(async move {
        selector
            .resolve_node_binary_with_cancellation(worker_cancelled)
            .await
    });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .unwrap()
        .expect("provider should begin");
    task.abort();
    let _ = task.await;
    assert!(
        cancelled.load(Ordering::Acquire),
        "future drop signals cooperative cancellation"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !finished.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("blocking worker reaches terminal state after observing cancellation");
    assert!(finished.load(Ordering::Acquire));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn selection_timeout_signals_worker_and_waits_for_terminal_observation() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let selector = NodeRuntimeSelector::with_compressed_provider(Arc::new(CancelledProvider {
        entered: entered_tx,
        finished: Arc::clone(&finished),
    }));
    let entered =
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)));
    let timeout = tokio::time::timeout(Duration::from_millis(10), selector.resolve_node_binary());
    let (timed_out, entered) = tokio::join!(timeout, entered);
    assert!(entered.unwrap().is_ok(), "the blocking provider started");
    assert!(
        timed_out.is_err(),
        "the provider remains pending until cancellation"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !finished.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("timed-out worker reaches terminal state after observing cancellation");
    assert!(finished.load(Ordering::Acquire));
}

#[cfg(target_os = "macos")]
struct BriefProvider;

#[cfg(target_os = "macos")]
impl CompressedNodeRuntimeProvider for BriefProvider {
    fn ensure_node(&self, _cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        std::thread::sleep(Duration::from_millis(25));
        Ok(cached("/cache/node"))
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn configured_runtime_preparation_is_separate_from_process_startup_budget() {
    if std::env::var_os("ATOOLS_NODE_BINARY").is_some() {
        return;
    }
    let selector = NodeRuntimeSelector::with_compressed_provider(Arc::new(BriefProvider));
    let selected = selector
        .resolve_node_binary_for_startup(Arc::new(AtomicBool::new(false)), Duration::from_millis(1))
        .await
        .expect("compressed runtime preparation uses its own bounded phase");
    assert_eq!(selected, PathBuf::from("/cache/node"));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn operation_cancellation_reaches_and_joins_runtime_preparation() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let selector = NodeRuntimeSelector::with_compressed_provider(Arc::new(CancelledProvider {
        entered: entered_tx,
        finished: Arc::clone(&finished),
    }));
    let cancelled = Arc::new(AtomicBool::new(false));
    let task_cancelled = Arc::clone(&cancelled);
    let task = tokio::spawn(async move {
        selector
            .resolve_node_binary_for_startup(task_cancelled, Duration::from_millis(1_500))
            .await
    });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .unwrap()
        .expect("provider started");
    cancelled.store(true, Ordering::Release);
    assert!(matches!(task.await.unwrap(), Err(SidecarError::Cancelled)));
    assert!(
        finished.load(Ordering::Acquire),
        "operation waits for cooperative worker completion"
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn bounded_selection_timeout_cancels_worker_and_observes_terminal_state() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let selector = NodeRuntimeSelector::with_compressed_provider(Arc::new(CancelledProvider {
        entered: entered_tx,
        finished: Arc::clone(&finished),
    }));
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let entered =
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)));
    let resolution = tokio::spawn(async move {
        selector
            .resolve_node_binary_with_budget(worker_cancelled, Some(Duration::from_millis(10)))
            .await
    });
    assert!(entered.await.unwrap().is_ok(), "provider started");
    assert!(matches!(
        resolution.await.unwrap(),
        Err(SidecarError::Timeout(10))
    ));
    assert!(
        cancelled.load(Ordering::Acquire),
        "timeout signals cooperative cancellation"
    );
    assert!(
        finished.load(Ordering::Acquire),
        "timeout is not returned until blocking cleanup is terminal"
    );
}
