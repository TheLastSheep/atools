use super::http::{BridgeServer, RequestHandler};
use super::sessions::{Intent, Session, Sessions};
use async_trait::async_trait;
use atools_core::Plugin;
use atools_plugin::loader::load_plugin_from_disk;
use atools_plugin::sidecar::SidecarStatus;
use serde_json::json;
use std::sync::{atomic::Ordering, Arc, Barrier};
use std::time::Duration;
use tempfile::TempDir;

struct UnusedHandler;
#[async_trait]
impl RequestHandler for UnusedHandler {
    fn authenticated(&self, _: &str) -> bool {
        false
    }
    async fn handle(&self, _: &str, _: serde_json::Value) -> Result<serde_json::Value, String> {
        panic!("the lifecycle listener fixture never dispatches requests")
    }
}

pub(super) async fn listener(runtime: &Sessions) -> String {
    let server = BridgeServer::start(Arc::new(UnusedHandler)).await.unwrap();
    let origin = server.origin.clone();
    *runtime.server.lock().await = Some(server);
    origin
}

pub(super) async fn assert_listener_closed(origin: &str) {
    let host = origin.strip_prefix("http://").unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while let Ok(stream) = tokio::net::TcpStream::connect(host).await {
            drop(stream);
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the idle listener must actually release its local port");
}

const CLIENT: &str = "atools-ui";

pub(super) fn fixture() -> (TempDir, Plugin) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("plugin.json"),
        json!({
            "name":"legacy-session-fixture", "version":"1.0.0", "main":"index.html",
            "preload":"preload.cjs", "features":[{"code":"fixture","cmds":["fixture"]}]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(directory.path().join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(
        directory.path().join("preload.cjs"),
        "require('node:process'); throw new Error('The preload must never execute inside Node');",
    )
    .unwrap();
    let plugin = load_plugin_from_disk(directory.path()).unwrap();
    (directory, plugin)
}

pub(super) fn intent(runtime: &Sessions, owner: &str, plugin: &Plugin) -> Intent {
    let id = runtime
        .create_intent(owner.into(), CLIENT.into(), plugin.id.clone())
        .unwrap();
    runtime.take_intent(Some(&id), CLIENT, &plugin.id).unwrap()
}

pub(super) async fn open(runtime: &Sessions, owner: &str, plugin: &Plugin) -> Arc<Session> {
    tokio::time::timeout(
        Duration::from_secs(3),
        runtime.open(
            plugin,
            "plugin.fixture.legacy_node".into(),
            intent(runtime, owner, plugin),
        ),
    )
    .await
    .expect("real Node session startup must remain bounded")
    .unwrap()
}

pub(super) async fn pid(session: &Session) -> u64 {
    let process = session
        .runtime
        .request("require", json!({"specifier":"node:process"}))
        .await
        .unwrap();
    let value = session
        .runtime
        .request(
            "get",
            json!({"handleId":process["handleId"],"property":"pid"}),
        )
        .await
        .unwrap();
    let pid = value["value"].as_u64().unwrap();
    assert!(pid > 0);
    pid
}

pub(super) async fn assert_stopped(session: &Session) {
    assert_eq!(
        session.runtime.status(),
        SidecarStatus::Stopped,
        "shutdown reports stopped only after the real child has been waited"
    );
    assert!(session
        .runtime
        .request("require", json!({"specifier":"node:process"}))
        .await
        .is_err());
}

#[tokio::test]
async fn zero_start_and_pending_authorization_do_not_allocate_a_node_or_listener() {
    let runtime = Sessions::default();
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
    let id = runtime
        .create_intent(
            "window:main:pending".into(),
            CLIENT.into(),
            "plugin-fixture".into(),
        )
        .unwrap();
    *runtime.intents.lock().get(&id).unwrap().run_id.lock() = Some("run-pending".into());
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(
        runtime.server.lock().await.is_none(),
        "requesting approval must not bind a port"
    );
    assert_eq!(
        runtime.close_owner("window:main:pending", None).await,
        vec!["run-pending"]
    );
    assert!(runtime.intents.lock().is_empty());
}

#[tokio::test]
async fn closing_an_owner_before_its_prepare_leaves_a_cancellation_tombstone() {
    let runtime = Sessions::default();
    let (_directory, plugin) = fixture();
    assert!(runtime
        .close_owner("window:main:closed", Some(&plugin.id))
        .await
        .is_empty());
    assert!(runtime
        .create_intent(
            "window:main:closed".into(),
            CLIENT.into(),
            plugin.id.clone()
        )
        .is_err());
    let late = runtime.take_intent(None, "late-agent", &plugin.id).unwrap();
    runtime.close_owner(&late.owner, None).await;
    assert!(
        runtime.open(&plugin, "tool".into(), late).await.is_err(),
        "an already captured intent must also respect the close tombstone"
    );
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
}

#[tokio::test]
async fn pending_intent_identity_checks_do_not_consume_it_and_concurrent_claims_have_one_winner() {
    let runtime = Arc::new(Sessions::default());
    let (_directory, plugin) = fixture();
    let id = runtime
        .create_intent("window:main:claim".into(), CLIENT.into(), plugin.id.clone())
        .unwrap();
    assert!(runtime
        .take_intent(Some("unknown"), CLIENT, &plugin.id)
        .is_err());
    assert!(runtime
        .take_intent(Some(&id), "other-client", &plugin.id)
        .is_err());
    assert!(runtime
        .take_intent(Some(&id), CLIENT, "other-plugin")
        .is_err());
    assert!(!runtime
        .intents
        .lock()
        .get(&id)
        .unwrap()
        .claimed
        .load(Ordering::Acquire));
    let barrier = Arc::new(Barrier::new(5));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let runtime = runtime.clone();
            let id = id.clone();
            let plugin_id = plugin.id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                runtime.take_intent(Some(&id), CLIENT, &plugin_id)
            })
        })
        .collect();
    barrier.wait();
    let mut winners: Vec<_> = workers
        .into_iter()
        .filter_map(|worker| worker.join().unwrap().ok())
        .collect();
    assert_eq!(winners.len(), 1);
    let session = runtime
        .open(&plugin, "tool".into(), winners.pop().unwrap())
        .await
        .unwrap();
    pid(&session).await;
    runtime.close_owner("window:main:claim", None).await;
    assert_stopped(&session).await;
}

#[tokio::test]
async fn close_returns_only_matching_pending_run_ids_and_cancels_captured_intents() {
    let runtime = Sessions::default();
    let first = runtime
        .create_intent("owner".into(), CLIENT.into(), "plugin-a".into())
        .unwrap();
    let second = runtime
        .create_intent("owner".into(), CLIENT.into(), "plugin-b".into())
        .unwrap();
    let other = runtime
        .create_intent("other-owner".into(), CLIENT.into(), "plugin-a".into())
        .unwrap();
    for (id, run) in [(&first, "run-a"), (&second, "run-b"), (&other, "run-other")] {
        *runtime.intents.lock().get(id).unwrap().run_id.lock() = Some(run.into());
    }
    let captured = runtime
        .take_intent(Some(&first), CLIENT, "plugin-a")
        .unwrap();
    assert_eq!(
        runtime.close_owner("owner", Some("plugin-a")).await,
        vec!["run-a"]
    );
    assert!(captured.cancelled.load(Ordering::Acquire));
    assert!(runtime
        .take_intent(Some(&first), CLIENT, "plugin-a")
        .is_err());
    assert!(runtime.intents.lock().contains_key(&second));
    assert!(runtime.intents.lock().contains_key(&other));
    assert_eq!(runtime.close_owner("owner", None).await, vec!["run-b"]);
    assert_eq!(
        runtime.close_owner("other-owner", None).await,
        vec!["run-other"]
    );
}

#[tokio::test]
async fn repeated_open_reuses_the_same_owner_process_and_close_reaps_it() {
    let runtime = Sessions::default();
    let (_directory, plugin) = fixture();
    let first = open(&runtime, "window:main:reuse", &plugin).await;
    let first_pid = pid(&first).await;
    let second = open(&runtime, "window:main:reuse", &plugin).await;
    assert_eq!(first.id, second.id);
    assert_eq!(first_pid, pid(&second).await);
    assert_eq!(runtime.sessions.read().len(), 1);
    runtime
        .close_owner("window:main:reuse", Some(&plugin.id))
        .await;
    assert!(runtime.get(&first.id).is_err());
    assert_stopped(&first).await;
    assert!(runtime.server.lock().await.is_none());
}

#[tokio::test]
async fn an_old_instance_close_cannot_stop_a_new_instance_of_the_same_plugin() {
    let runtime = Sessions::default();
    let (_directory, plugin) = fixture();
    let old = open(&runtime, "window:main:old-instance", &plugin).await;
    let new = open(&runtime, "window:main:new-instance", &plugin).await;
    assert_ne!(old.id, new.id);
    assert_ne!(pid(&old).await, pid(&new).await);
    runtime
        .close_owner("window:main:old-instance", Some(&plugin.id))
        .await;
    assert_stopped(&old).await;
    assert_eq!(runtime.sessions.read().len(), 1);
    assert_eq!(
        runtime.get(&new.id).unwrap().owner,
        "window:main:new-instance"
    );
    assert_eq!(new.runtime.status(), SidecarStatus::Running);
    pid(&new).await;
    runtime.close_owner("window:main:new-instance", None).await;
    assert_stopped(&new).await;
}

#[tokio::test]
async fn closing_while_real_node_is_starting_serializes_cleanup_and_rejects_late_open() {
    let runtime = Sessions::default();
    let (_directory, plugin) = fixture();
    let pending = intent(&runtime, "window:main:opening-race", &plugin);
    *pending.run_id.lock() = Some("run-opening-race".into());
    let cancel = pending.cancelled.clone();
    let (opened, runs) = tokio::time::timeout(Duration::from_secs(4), async {
        tokio::join!(runtime.open(&plugin, "tool".into(), pending), async {
            while !runtime
                .openings
                .lock()
                .contains_key("window:main:opening-race")
            {
                tokio::task::yield_now().await;
            }
            runtime
                .close_owner("window:main:opening-race", Some(&plugin.id))
                .await
        })
    })
    .await
    .expect("close must finish while startup owns the transition lock");
    assert!(opened.is_err());
    assert_eq!(runs, vec!["run-opening-race"]);
    assert!(cancel.load(Ordering::Acquire));
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
    assert!(runtime
        .create_intent("window:main:opening-race".into(), CLIENT.into(), plugin.id)
        .is_err());
}

#[tokio::test]
async fn remove_preserves_an_active_transport_and_closes_it_after_the_last_real_node() {
    let runtime = Sessions::default();
    let (_directory, plugin) = fixture();
    let first = open(&runtime, "window:main:first-removal", &plugin).await;
    let second = open(&runtime, "window:main:last-removal", &plugin).await;
    let origin = listener(&runtime).await;
    runtime.remove(&first.id).await;
    assert_stopped(&first).await;
    assert!(runtime.server.lock().await.is_some());
    assert!(
        tokio::net::TcpStream::connect(origin.strip_prefix("http://").unwrap())
            .await
            .is_ok()
    );
    pid(&second).await;
    runtime.remove(&second.id).await;
    assert_stopped(&second).await;
    assert!(runtime.server.lock().await.is_none());
    assert_listener_closed(&origin).await;
}

#[tokio::test]
async fn four_process_budget_rejects_the_fifth_and_recovers_capacity_after_close() {
    let runtime = Sessions::default();
    let (_directory, plugin) = fixture();
    let mut sessions = Vec::new();
    for i in 0..4 {
        sessions.push(open(&runtime, &format!("window:main:budget-{i}"), &plugin).await);
    }
    let mut pids = std::collections::HashSet::new();
    for session in &sessions {
        pids.insert(pid(session).await);
    }
    assert_eq!(
        pids.len(),
        4,
        "the budget is exercised with four real child processes"
    );
    let rejected = runtime
        .open(
            &plugin,
            "tool".into(),
            intent(&runtime, "window:main:fifth", &plugin),
        )
        .await;
    assert!(rejected.err().unwrap().contains("limit 4"));
    assert_eq!(runtime.sessions.read().len(), 4);
    assert!(runtime.openings.lock().is_empty());
    runtime.close_owner("window:main:budget-0", None).await;
    assert_stopped(&sessions[0]).await;
    let replacement = open(&runtime, "window:main:replacement", &plugin).await;
    assert!(!pids.contains(&pid(&replacement).await));
    assert_eq!(runtime.sessions.read().len(), 4);
    runtime.stop_all().await;
    for session in sessions.iter().chain(std::iter::once(&replacement)) {
        assert_stopped(session).await;
    }
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
    assert!(runtime
        .create_intent("after-stop".into(), CLIENT.into(), plugin.id)
        .is_err());
}
