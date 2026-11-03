//! Reproduce a credential getter suspended between Arc lookup and server admission.
use super::sessions::{remember_closed, MAX_CLOSED_OWNERS, MAX_SUCCESSOR_LINKS};
use super::tests::{fixture, open};
use std::sync::Arc;
use std::{collections::HashSet, time::Instant};

#[tokio::test]
async fn suspended_endpoint_getter_rejects_arc_removed_by_rotation() {
    let (_, plugin, binding, runtime) = fixture();
    let runtime = Arc::new(runtime);
    let old = open(&runtime, &plugin, &binding, "old");
    let server = runtime.server.lock().await;
    let (seen, ready) = tokio::sync::oneshot::channel();
    let r = runtime.clone();
    let id = old.id.clone();
    let waiter = tokio::spawn(async move {
        let captured = r.get(&id).unwrap();
        let _ = seen.send(());
        let _server = r.server.lock().await;
        r.with_live_session(&captured, |current| Ok(current.token.clone()))
    });
    ready.await.unwrap();
    runtime
        .rotate("old", "new", &plugin.id, &[old.id.clone()])
        .unwrap();
    drop(server);
    assert!(waiter.await.unwrap().is_err());
    assert!(runtime.by_token(&old.token).is_none());
    let current = runtime
        .store
        .lock()
        .sessions
        .values()
        .next()
        .unwrap()
        .clone();
    assert!(runtime
        .with_live_session(&current, |session| Ok(session.token.clone()))
        .is_ok());
}

#[tokio::test]
async fn captured_session_cannot_publish_after_close_or_false_active() {
    let (_, plugin, binding, runtime) = fixture();
    let old = open(&runtime, &plugin, &binding, "old");
    *old.active.lock() = false;
    assert!(runtime.with_live_session(&old, |_| Ok(())).is_err());
    *old.active.lock() = true;
    runtime.close(Some("old"), None, false).await;
    assert!(runtime.with_live_session(&old, |_| Ok(())).is_err());
    assert!(runtime.store.lock().sessions.is_empty());
}

#[tokio::test]
async fn a_full_rotation_budget_closes_the_terminal_without_leaking_a_token() {
    let (_, plugin, binding, runtime) = fixture();
    let mut owner = "owner-0".to_string();
    let first = open(&runtime, &plugin, &binding, &owner);
    let mut previous = first;
    for index in 1..=MAX_SUCCESSOR_LINKS {
        let next = format!("owner-{index}");
        runtime
            .rotate(&owner, &next, &plugin.id, &[previous.id.clone()])
            .unwrap();
        previous = runtime
            .store
            .lock()
            .sessions
            .values()
            .next()
            .unwrap()
            .clone();
        owner = next;
    }

    assert_eq!(runtime.store.lock().successors.len(), MAX_SUCCESSOR_LINKS);
    let live_id = previous.id.clone();
    let old_token = previous.token.clone();
    let terminal = owner.clone();
    let overflow = runtime
        .rotate(&owner, "owner-overflow", &plugin.id, &[previous.id.clone()])
        .unwrap_err();
    assert!(overflow.contains("rotation budget reached"));
    assert!(runtime.get(&live_id).is_ok());
    assert!(*previous.active.lock());
    runtime
        .close(Some("owner-0"), Some(&plugin.id), false)
        .await;
    assert!(runtime.store.lock().sessions.is_empty());
    assert!(runtime.store.lock().closed.len() <= MAX_CLOSED_OWNERS);
    assert!(runtime.by_token(&old_token).is_none());
    assert!(runtime
        .intent_with_document(terminal, plugin.id.clone(), binding.clone(), None)
        .is_err());
    assert!(runtime
        .intent_with_document("owner-0".into(), plugin.id, binding, None)
        .is_err());
}

#[tokio::test]
async fn repeated_long_rotation_chains_keep_tombstones_bounded_and_roots_closed() {
    let (_, plugin, binding, runtime) = fixture();
    for round in 0..2 {
        let root = format!("round-{round}-0");
        let mut owner = root.clone();
        let mut current = open(&runtime, &plugin, &binding, &owner);
        for index in 1..=MAX_SUCCESSOR_LINKS / 2 {
            let next = format!("round-{round}-{index}");
            runtime
                .rotate(&owner, &next, &plugin.id, &[current.id.clone()])
                .unwrap();
            current = runtime
                .store
                .lock()
                .sessions
                .values()
                .next()
                .unwrap()
                .clone();
            owner = next;
        }
        runtime.close(Some(&root), Some(&plugin.id), false).await;
        assert!(runtime.store.lock().sessions.is_empty());
        assert!(runtime.store.lock().closed.len() <= MAX_CLOSED_OWNERS);
        assert!(runtime
            .intent_with_document(root, plugin.id.clone(), binding.clone(), None)
            .is_err());
        assert!(runtime
            .intent_with_document(owner, plugin.id.clone(), binding.clone(), None)
            .is_err());
    }
}

#[tokio::test]
async fn a_full_tombstone_table_still_closes_and_blocks_the_current_owner() {
    let (_, plugin, binding, runtime) = fixture();
    let session = open(&runtime, &plugin, &binding, "closing-owner");
    {
        let mut state = runtime.store.lock();
        for index in 0..MAX_CLOSED_OWNERS {
            state
                .closed
                .insert(format!("unrelated-{index}"), Instant::now());
        }
    }
    runtime
        .close(Some("closing-owner"), Some(&plugin.id), false)
        .await;
    assert!(runtime.get(&session.id).is_err());
    assert!(runtime
        .intent_with_document("closing-owner".into(), plugin.id, binding, None)
        .is_err());
    assert_eq!(runtime.store.lock().closed.len(), MAX_CLOSED_OWNERS);
    assert!(runtime
        .store
        .lock()
        .successors
        .contains_key("closing-owner"));
}

#[test]
fn closed_tombstones_are_bounded_and_keep_the_closing_owner() {
    let (_, _, _, runtime) = fixture();
    {
        let mut state = runtime.store.lock();
        for index in 0..MAX_CLOSED_OWNERS {
            state
                .closed
                .insert(format!("closed-{index}"), Instant::now());
        }
        state.successors.insert("closed-0".into(), "leaf".into());
        state
            .successors
            .insert("lineage-root".into(), "leaf".into());
    }
    let protected = HashSet::from(["closing-now".to_string(), "lineage-root".to_string()]);
    let mut state = runtime.store.lock();
    assert!(remember_closed(&mut state, "closing-now", &protected));
    assert_eq!(state.closed.len(), MAX_CLOSED_OWNERS);
    assert!(state.closed.contains_key("closing-now"));
    assert!(state.successors.contains_key("closed-0"));
    assert!(state.successors.contains_key("lineage-root"));
}
