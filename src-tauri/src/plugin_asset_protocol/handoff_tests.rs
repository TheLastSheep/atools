use super::{
    handoff::{self, MainThreadJob},
    leases::{Authorization, Lease, Resources},
    Owner,
};
use std::{
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};
use tauri::http::{Response, StatusCode};

const LIMIT: Duration = Duration::from_secs(1);
type Guards = (
    tokio::sync::OwnedSemaphorePermit,
    tokio::sync::OwnedSemaphorePermit,
    tokio::sync::OwnedRwLockReadGuard<()>,
);
type Delivered = (thread::ThreadId, Response<Vec<u8>>);

fn fixture() -> (Arc<Resources>, Lease) {
    let resources = Arc::new(Resources::default());
    let owner = Owner::new(
        "main",
        "asset-handoff-fixture",
        &uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let prepared = resources
        .prepare(
            owner,
            Authorization {
                root: "/inert".into(),
                revision: None,
            },
        )
        .unwrap();
    let lease = resources.get(&prepared.session_id, "main").unwrap();
    (resources, lease)
}
fn guards(resources: &Resources, execution: &Arc<tokio::sync::RwLock<()>>) -> Guards {
    (
        resources.pending.clone().try_acquire_owned().unwrap(),
        resources.reads.clone().try_acquire_owned().unwrap(),
        execution.clone().try_read_owned().unwrap(),
    )
}
fn original() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .body(b"read package bytes".to_vec())
        .unwrap()
}
fn worker(
    resources: Arc<Resources>,
    lease: Lease,
    guards: Guards,
    queue: mpsc::Sender<MainThreadJob>,
    delivered: mpsc::Sender<Delivered>,
) -> thread::JoinHandle<Result<(), ()>> {
    let main = thread::current().id();
    thread::spawn(move || {
        let response_queue = queue.clone();
        handoff::dispatch(
            resources,
            lease,
            original(),
            false,
            guards,
            move |job| queue.send(job).map_err(|_| ()),
            move |response| {
                // WebKit's off-main responder waits for a main-runloop callback.
                if thread::current().id() != main {
                    let (done, ack) = mpsc::channel();
                    response_queue
                        .send(Box::new(move || {
                            delivered.send((thread::current().id(), response)).unwrap();
                            done.send(()).unwrap();
                        }))
                        .unwrap();
                    ack.recv_timeout(LIMIT * 5).unwrap();
                } else {
                    delivered.send((main, response)).unwrap();
                }
            },
        )
    })
}

#[test]
fn plugin_asset_protocol_queued_main_handoff_never_holds_store_on_worker() {
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let (queue, jobs) = mpsc::channel();
    let (delivered, responses) = mpsc::channel();
    let worker = worker(
        resources.clone(),
        lease.clone(),
        guards(&resources, &execution),
        queue,
        delivered,
    );
    let job = jobs.recv_timeout(LIMIT).unwrap();
    let lookup = resources.clone();
    let id = lease.id.clone();
    let (done, lookup_done) = mpsc::channel();
    let getter = thread::spawn(move || {
        done.send(lookup.get(&id, "main").is_some()).unwrap();
    });
    let progresses_before_main = lookup_done.recv_timeout(LIMIT).ok();
    // Always release the simulated main task before assertions, including red.
    job();
    worker.join().unwrap().unwrap();
    getter.join().unwrap();
    assert_eq!(
        progresses_before_main,
        Some(true),
        "Main resource lookup blocked behind worker response waiting for main"
    );
    assert_eq!(
        responses.recv_timeout(LIMIT).unwrap().0,
        thread::current().id()
    );
}

fn queued_revocation(reset: bool) {
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let (queue, jobs) = mpsc::channel();
    let (delivered, responses) = mpsc::channel();
    let worker = worker(
        resources.clone(),
        lease.clone(),
        guards(&resources, &execution),
        queue,
        delivered,
    );
    let job = jobs.recv_timeout(LIMIT).unwrap();
    let revoke = resources.clone();
    let (done, revoked) = mpsc::channel();
    let closer = thread::spawn(move || {
        if reset {
            revoke.invalidate_plugin(&lease.owner.plugin);
        } else {
            revoke.close(&lease.owner);
        }
        done.send(()).unwrap();
    });
    let revoked_before_handoff = revoked.recv_timeout(LIMIT).is_ok();
    job();
    worker.join().unwrap().unwrap();
    closer.join().unwrap();
    let (_, response) = responses.recv_timeout(LIMIT).unwrap();
    assert!(
        revoked_before_handoff,
        "Revocation blocked while response waited for main"
    );
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.body(), b"Plugin resource unavailable");
    assert_eq!(resources.pending.available_permits(), 64);
    assert_eq!(resources.reads.available_permits(), 8);
    assert!(execution.try_write().is_ok());
}
#[test]
fn plugin_asset_protocol_queued_close_suppresses_already_read_bytes() {
    queued_revocation(false);
}
#[test]
fn plugin_asset_protocol_queued_reset_suppresses_already_read_bytes() {
    queued_revocation(true);
}

#[test]
fn plugin_asset_protocol_handoff_keeps_all_guards_until_real_response_returns() {
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let pending = resources.pending.clone();
    let reads = resources.reads.clone();
    let response_gate = execution.clone();
    let (delivered, responses) = mpsc::channel::<Delivered>();
    let mut job = None;
    handoff::dispatch(
        resources.clone(),
        lease,
        original(),
        false,
        guards(&resources, &execution),
        |queued| {
            job = Some(queued);
            Ok::<(), ()>(())
        },
        move |response| {
            assert_eq!(pending.available_permits(), 63);
            assert_eq!(reads.available_permits(), 7);
            assert!(response_gate.try_write().is_err());
            delivered.send((thread::current().id(), response)).unwrap();
        },
    )
    .unwrap();
    assert_eq!(resources.pending.available_permits(), 63);
    assert_eq!(resources.reads.available_permits(), 7);
    assert!(execution.try_write().is_err());
    job.unwrap()();
    assert_eq!(
        responses.recv_timeout(LIMIT).unwrap().1.body(),
        b"read package bytes"
    );
    assert_eq!(resources.pending.available_permits(), 64);
    assert_eq!(resources.reads.available_permits(), 8);
    assert!(execution.try_write().is_ok());
}

#[test]
fn plugin_asset_protocol_rejected_main_queue_drops_guards_without_worker_fallback() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let called = Arc::new(AtomicUsize::new(0));
    let observed = called.clone();
    let result = handoff::dispatch(
        resources.clone(),
        lease,
        original(),
        false,
        guards(&resources, &execution),
        |_| Err("event loop closed"),
        move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        },
    );
    assert_eq!(called.load(Ordering::SeqCst), 0);
    assert_eq!(result, Err("event loop closed"));
    assert_eq!(resources.pending.available_permits(), 64);
    assert_eq!(resources.reads.available_permits(), 8);
    assert!(execution.try_write().is_ok());
}

#[test]
fn plugin_asset_protocol_main_thread_inline_executor_hands_off_once_without_waiting() {
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let main = thread::current().id();
    let (delivered, responses) = mpsc::channel();
    handoff::dispatch(
        resources.clone(),
        lease,
        original(),
        false,
        guards(&resources, &execution),
        |job| {
            job();
            Ok::<(), ()>(())
        },
        move |response| {
            delivered.send((thread::current().id(), response)).unwrap();
        },
    )
    .unwrap();
    let (thread, response) = responses.recv_timeout(LIMIT).unwrap();
    assert_eq!(thread, main);
    assert_eq!(response.status(), StatusCode::OK);
    assert!(responses.try_recv().is_err());
    assert_eq!(resources.pending.available_permits(), 64);
    assert_eq!(resources.reads.available_permits(), 8);
    assert!(execution.try_write().is_ok());
}

#[test]
fn plugin_asset_protocol_discarded_queued_handoff_releases_guards_without_response() {
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let (delivered, responses) = mpsc::channel::<()>();
    let mut job = None;
    handoff::dispatch(
        resources.clone(),
        lease,
        original(),
        false,
        guards(&resources, &execution),
        |queued| {
            job = Some(queued);
            Ok::<(), ()>(())
        },
        move |_| {
            delivered.send(()).unwrap();
        },
    )
    .unwrap();
    assert_eq!(resources.pending.available_permits(), 63);
    assert_eq!(resources.reads.available_permits(), 7);
    assert!(execution.try_write().is_err());
    drop(job);
    assert!(responses.try_recv().is_err());
    assert_eq!(resources.pending.available_permits(), 64);
    assert_eq!(resources.reads.available_permits(), 8);
    assert!(execution.try_write().is_ok());
}

#[test]
fn plugin_asset_protocol_queue_timeout_response_retains_pending_until_main_handoff() {
    let (resources, _lease) = fixture();
    let pending = resources.pending.clone().try_acquire_owned().unwrap();
    let held = resources.pending.clone();
    let (delivered, responses) = mpsc::channel();
    let mut job = None;
    handoff::enqueue(
        pending,
        |queued| {
            job = Some(queued);
            Ok::<(), ()>(())
        },
        move || {
            assert_eq!(held.available_permits(), 63);
            delivered.send(()).unwrap();
        },
    )
    .unwrap();
    assert_eq!(resources.pending.available_permits(), 63);
    assert!(responses.try_recv().is_err());
    job.unwrap()();
    responses.recv_timeout(LIMIT).unwrap();
    assert_eq!(resources.pending.available_permits(), 64);
}

#[test]
fn plugin_asset_protocol_queued_head_close_returns_empty_body() {
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let (delivered, responses) = mpsc::channel();
    let mut job = None;
    handoff::dispatch(
        resources.clone(),
        lease.clone(),
        original(),
        true,
        guards(&resources, &execution),
        |queued| {
            job = Some(queued);
            Ok::<(), ()>(())
        },
        move |response| {
            delivered.send(response).unwrap();
        },
    )
    .unwrap();
    resources.close(&lease.owner);
    job.unwrap()();
    let response = responses.recv_timeout(LIMIT).unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(response.body().is_empty());
}

#[test]
fn plugin_asset_protocol_count_only_state_keeps_closed_queued_work_visible_until_drained() {
    let (resources, lease) = fixture();
    let execution = Arc::new(tokio::sync::RwLock::new(()));
    let preparation = resources.begin(lease.owner.clone()).unwrap();
    assert_eq!(
        resources.runtime_state(),
        serde_json::json!({"available":true,
        "leases":1,"preparations":1,"activeReads":0,"pendingRequests":0})
    );
    let mut job = None;
    handoff::dispatch(
        resources.clone(),
        lease.clone(),
        original(),
        false,
        guards(&resources, &execution),
        |queued| {
            job = Some(queued);
            Ok::<(), ()>(())
        },
        |response| {
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        },
    )
    .unwrap();
    resources.close(&lease.owner);
    assert_eq!(
        resources.runtime_state(),
        serde_json::json!({"available":true,
        "leases":0,"preparations":0,"activeReads":1,"pendingRequests":1})
    );
    assert!(execution.try_write().is_err());
    job.unwrap()();
    drop(preparation);
    assert_eq!(
        resources.runtime_state(),
        serde_json::json!({"available":true,
        "leases":0,"preparations":0,"activeReads":0,"pendingRequests":0})
    );
    assert!(execution.try_write().is_ok());
}
