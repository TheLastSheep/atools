use super::{
    sessions::{Sessions, Store},
    types::{credential, Binding, Invocation, Owner, Session, INVOCATION_PENDING},
};
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[test]
fn owner_is_limited_to_main_and_a_canonical_instance_uuid() {
    let owner = Owner::new("main", "plugin-x", "11111111-1111-4111-8111-111111111111").unwrap();
    assert_eq!(owner.instance, "11111111-1111-4111-8111-111111111111");
    assert!(Owner::new(
        "plugin-window",
        "plugin-x",
        "11111111-1111-4111-8111-111111111111"
    )
    .is_err());
    assert!(Owner::new("main", "plugin-x", "not-a-uuid").is_err());
}

#[test]
fn closing_owner_cancels_only_unstarted_drag_and_erases_memory_paths() {
    let owner = Owner::new("main", "plugin-x", "11111111-1111-4111-8111-111111111111").unwrap();
    let session_id = credential();
    let session = Arc::new(Session {
        id: session_id.clone(),
        token: credential(),
        owner: owner.clone(),
        document: None,
        binding: Binding {
            path: "/plugins/x".into(),
            version: "1".into(),
            revision: None,
        },
        tool: "atools.host.file-drag.fixture".into(),
        once_authorization: None,
        created: Instant::now(),
        expires_at: Instant::now() + Duration::from_secs(600),
        active: AtomicBool::new(true),
    });
    let invocation_id = credential();
    let (ack_sender, ack_receiver) = oneshot::channel();
    let invocation = Arc::new(Invocation {
        id: invocation_id.clone(),
        session: session_id.clone(),
        owner: owner.clone(),
        plugin: owner.plugin.clone(),
        document: None,
        paths: Mutex::new(Some(vec![PathBuf::from("/private/only-in-memory.txt")])),
        claimed: AtomicBool::new(false),
        phase: AtomicU8::new(INVOCATION_PENDING),
        cancelled: Arc::new(AtomicBool::new(false)),
        run: Mutex::new(Some("taskrun-1".into())),
        acknowledgement: Mutex::new(Some(ack_sender)),
    });
    let mut store = Store::default();
    store.sessions.insert(session_id.clone(), session.clone());
    store
        .invocations
        .insert(invocation_id.clone(), invocation.clone());
    let runtime = Sessions {
        store: Mutex::new(store),
        server: tokio::sync::Mutex::new(None),
        control: tokio::sync::Mutex::new(()),
    };

    let cancelled_runs = runtime.close(Some(&owner), None, None, None, false);
    assert_eq!(cancelled_runs, vec!["taskrun-1"]);
    assert!(!session.valid());
    assert!(invocation.paths.lock().is_none());
    assert!(invocation
        .cancelled
        .load(std::sync::atomic::Ordering::Acquire));
    assert!(runtime.store.lock().sessions.is_empty());
    assert!(runtime.store.lock().invocations.is_empty());
    assert!(ack_receiver.blocking_recv().unwrap().is_err());
}

#[test]
fn cancellation_does_not_claim_that_an_already_started_os_drag_was_stopped() {
    let owner = Owner::new("main", "plugin-x", "11111111-1111-4111-8111-111111111111").unwrap();
    let invocation = Invocation {
        id: credential(),
        session: credential(),
        owner: owner.clone(),
        plugin: owner.plugin,
        document: None,
        paths: Mutex::new(None),
        claimed: AtomicBool::new(true),
        phase: AtomicU8::new(super::types::INVOCATION_STARTED),
        cancelled: Arc::new(AtomicBool::new(false)),
        run: Mutex::new(Some("taskrun-2".into())),
        acknowledgement: Mutex::new(None),
    };
    assert!(!invocation.cancel_before_start());
    assert_eq!(invocation.phase(), super::types::INVOCATION_STARTED);
    assert!(invocation
        .cancelled
        .load(std::sync::atomic::Ordering::Acquire));
}
