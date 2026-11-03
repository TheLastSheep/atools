use super::Sessions;
use atools_plugin::sidecar::{
    node_runtime_cache::{CachedNode, NodeRuntimeCacheError},
    CompressedNodeRuntimeProvider, NodeRuntimeSelector,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::Duration;
use tokio::runtime::{Builder, Runtime};

const CLIENT: &str = "atools-ui";

struct CountingRejectProvider(Arc<AtomicUsize>);

impl CompressedNodeRuntimeProvider for CountingRejectProvider {
    fn ensure_node(&self, _cancelled: &AtomicBool) -> Result<CachedNode, NodeRuntimeCacheError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        // Reaching the resolver is the red signal. Fail before a child can spawn.
        Err(NodeRuntimeCacheError::InvalidPayload)
    }
}

struct BlockingWorkerRelease(Option<mpsc::Sender<()>>);

impl BlockingWorkerRelease {
    fn occupy_only_blocking_worker(runtime: &Runtime) -> Self {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        runtime.spawn_blocking(move || {
            entered_tx
                .send(())
                .expect("test observes the blocking worker");
            release_rx
                .recv()
                .expect("test releases the blocking worker");
        });
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the single blocking worker entered its gate");
        Self(Some(release_tx))
    }

    fn release(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}

impl Drop for BlockingWorkerRelease {
    fn drop(&mut self) {
        self.release();
    }
}

fn test_runtime() -> Runtime {
    Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .expect("isolated Tokio runtime")
}

fn sessions(provider_calls: Arc<AtomicUsize>) -> Arc<Sessions> {
    Arc::new(Sessions::with_node_runtime_selector(
        NodeRuntimeSelector::with_compressed_provider(Arc::new(CountingRejectProvider(
            provider_calls,
        ))),
    ))
}

fn assert_provider_can_observe_resolution() {
    assert!(
        std::env::var_os("ATOOLS_NODE_BINARY").is_none(),
        "run this focused test group with ATOOLS_NODE_BINARY unset so the injected provider observes Node resolution"
    );
}

fn wait_until(runtime: &Runtime, predicate: impl Fn() -> bool, message: &'static str) {
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{message}"));
    });
}

fn wait_for_entry_selection_to_be_queued(runtime: &Runtime, sessions: &Sessions) {
    wait_until(
        runtime,
        || sessions.transition.try_lock().is_err(),
        "open must hold transition while awaiting its queued spawn_blocking select_entry",
    );
}

fn assert_fixture_selects_a_real_node_entry(plugin: &atools_core::Plugin) {
    super::super::node_entry::select_entry(plugin)
        .expect("the fixture must reach the real Node entry selection path");
}

fn intent_with_task_run(sessions: &Sessions, owner: &str, plugin_id: &str, run_id: &str) -> String {
    let id = sessions
        .create_intent(owner.into(), CLIENT.into(), plugin_id.into())
        .expect("create UI intent");
    *sessions
        .intents
        .lock()
        .get(&id)
        .expect("intent remains registered before claim")
        .run_id
        .lock() = Some(run_id.into());
    id
}

async fn join_open_and_close(
    opening: tokio::task::JoinHandle<
        Result<Arc<super::Session>, super::super::node_startup_diagnostic::LegacyRuntimeError>,
    >,
    closing: tokio::task::JoinHandle<Vec<String>>,
) -> (
    Result<Arc<super::Session>, super::super::node_startup_diagnostic::LegacyRuntimeError>,
    Vec<String>,
) {
    let (opening, closing) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(opening, closing)
    })
    .await
    .expect("open and close complete after releasing the blocking worker");
    (
        opening.expect("open task does not panic"),
        closing.expect("close task does not panic"),
    )
}

#[test]
fn ui_named_intent_remains_registered_and_owner_close_cancels_queued_selection() {
    assert_provider_can_observe_resolution();
    let (_directory, plugin) = super::super::session_tests::fixture();
    assert_fixture_selects_a_real_node_entry(&plugin);

    let provider_calls = Arc::new(AtomicUsize::new(0));
    let sessions = sessions(Arc::clone(&provider_calls));
    let owner = "window:main:startup-ui-cancel";
    let intent_id = intent_with_task_run(&sessions, owner, &plugin.id, "run-ui-cancel");
    let intent = sessions
        .take_intent(Some(&intent_id), CLIENT, &plugin.id)
        .expect("claim UI intent");
    let cancelled = Arc::clone(&intent.cancelled);
    assert!(
        sessions.intents.lock().contains_key(&intent_id),
        "take_intent clones a named intent and leaves it visible to window close"
    );

    let runtime = test_runtime();
    let mut blocker = BlockingWorkerRelease::occupy_only_blocking_worker(&runtime);
    let opening_sessions = Arc::clone(&sessions);
    let opening =
        runtime.spawn(async move { opening_sessions.open(&plugin, "tool".into(), intent).await });
    wait_for_entry_selection_to_be_queued(&runtime, &sessions);

    let closing_sessions = Arc::clone(&sessions);
    let closing = runtime.spawn(async move { closing_sessions.close_owner(owner, None).await });
    wait_until(
        &runtime,
        || {
            sessions.cancelled_owners.lock().contains_key(owner)
                && cancelled.load(Ordering::Acquire)
                && !sessions.intents.lock().contains_key(&intent_id)
        },
        "window close must cancel and remove the still-registered UI intent before waiting on transition",
    );

    blocker.release();
    let (opened, closed_runs) = runtime.block_on(join_open_and_close(opening, closing));
    assert!(opened.is_err(), "the cancelled UI open is rejected");
    assert_eq!(closed_runs, vec!["run-ui-cancel"]);
    assert_eq!(provider_calls.load(Ordering::SeqCst), 0);
    assert!(sessions.sessions.read().is_empty());
    assert!(sessions.openings.lock().is_empty());
}

#[test]
fn owner_tombstone_cancels_agent_open_without_a_registered_intent() {
    assert_provider_can_observe_resolution();
    let (_directory, plugin) = super::super::session_tests::fixture();
    assert_fixture_selects_a_real_node_entry(&plugin);

    let provider_calls = Arc::new(AtomicUsize::new(0));
    let sessions = sessions(Arc::clone(&provider_calls));
    let intent = sessions
        .take_intent(None, "late-agent", &plugin.id)
        .expect("create direct Agent owner intent");
    let owner = intent.owner.clone();
    assert!(sessions.intents.lock().is_empty());

    let runtime = test_runtime();
    let mut blocker = BlockingWorkerRelease::occupy_only_blocking_worker(&runtime);
    let opening_sessions = Arc::clone(&sessions);
    let opening =
        runtime.spawn(async move { opening_sessions.open(&plugin, "tool".into(), intent).await });
    wait_for_entry_selection_to_be_queued(&runtime, &sessions);

    let closing_sessions = Arc::clone(&sessions);
    let closing_owner = owner.clone();
    let closing =
        runtime.spawn(async move { closing_sessions.close_owner(&closing_owner, None).await });
    wait_until(
        &runtime,
        || sessions.cancelled_owners.lock().contains_key(&owner),
        "owner close must install its tombstone before waiting on transition",
    );

    blocker.release();
    let (opened, closed_runs) = runtime.block_on(join_open_and_close(opening, closing));
    assert!(opened.is_err(), "the cancelled Agent open is rejected");
    assert!(
        closed_runs.is_empty(),
        "a direct Agent open has no UI TaskRun ID"
    );
    assert_eq!(
        provider_calls.load(Ordering::SeqCst),
        0,
        "an owner tombstone must be rechecked before Node runtime resolution"
    );
    assert!(sessions.sessions.read().is_empty());
    assert!(sessions.openings.lock().is_empty());
}

#[test]
fn stop_all_cancels_agent_open_while_entry_selection_is_queued() {
    assert_provider_can_observe_resolution();
    let (_directory, plugin) = super::super::session_tests::fixture();
    assert_fixture_selects_a_real_node_entry(&plugin);

    let provider_calls = Arc::new(AtomicUsize::new(0));
    let sessions = sessions(Arc::clone(&provider_calls));
    let intent = sessions
        .take_intent(None, "shutdown-agent", &plugin.id)
        .expect("create direct Agent owner intent");

    let runtime = test_runtime();
    let mut blocker = BlockingWorkerRelease::occupy_only_blocking_worker(&runtime);
    let opening_sessions = Arc::clone(&sessions);
    let opening =
        runtime.spawn(async move { opening_sessions.open(&plugin, "tool".into(), intent).await });
    wait_for_entry_selection_to_be_queued(&runtime, &sessions);

    let stopping_sessions = Arc::clone(&sessions);
    let stopping = runtime.spawn(async move { stopping_sessions.stop_all().await });
    wait_until(
        &runtime,
        || sessions.stopping.load(Ordering::Acquire),
        "stop_all must publish stopping before waiting on transition",
    );

    blocker.release();
    let (opened, stopped) = runtime
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                tokio::join!(opening, stopping)
            })
            .await
        })
        .expect("open and stop_all complete after releasing the blocking worker");
    assert!(opened.expect("open task does not panic").is_err());
    stopped.expect("stop_all task does not panic");
    assert_eq!(
        provider_calls.load(Ordering::SeqCst),
        0,
        "stopping must be rechecked before Node runtime resolution"
    );
    assert!(sessions.sessions.read().is_empty());
    assert!(sessions.openings.lock().is_empty());
}
