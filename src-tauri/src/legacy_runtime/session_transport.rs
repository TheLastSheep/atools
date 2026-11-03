use super::{BridgeServer, Openings, Session};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(super) type SessionsLock = Arc<RwLock<HashMap<String, Arc<Session>>>>;
pub(super) type ServerLock = Arc<tokio::sync::Mutex<Option<BridgeServer>>>;
pub(super) type OpeningsLock = Arc<Openings>;

/// Coalesces lock-contention cleanup into at most one active Tokio task.
#[derive(Default)]
pub(super) struct IdleCleanupState {
    pending: AtomicBool,
    scheduled: AtomicBool,
}

pub(super) fn try_drop_idle_transport(
    sessions: &SessionsLock,
    openings: &OpeningsLock,
    server: &ServerLock,
    cleanup: &Arc<IdleCleanupState>,
) {
    if !is_idle(sessions, openings) {
        return;
    }

    let detached = match server.try_lock() {
        Ok(mut guard) => take_if_idle(sessions, openings, &mut guard),
        Err(_) => {
            request_cleanup(
                Arc::clone(sessions),
                Arc::clone(openings),
                Arc::clone(server),
                Arc::clone(cleanup),
            );
            None
        }
    };
    // Dropping BridgeServer aborts its listener and request tasks. Release every
    // state lock first so canceled handlers can finish by observing closure.
    drop(detached);
}

pub(super) async fn maybe_idle_transport(
    sessions: &SessionsLock,
    openings: &OpeningsLock,
    server: &ServerLock,
) {
    let detached = {
        let mut guard = server.lock().await;
        take_if_idle(sessions, openings, &mut guard)
    };
    drop(detached);
}

fn is_idle(sessions: &SessionsLock, openings: &OpeningsLock) -> bool {
    let sessions = sessions.read();
    sessions.is_empty() && openings.lock().is_empty()
}

/// Caller holds the server mutex. Keep the session and opening guards through
/// `take` so a new publication or opening cannot cross the idle decision.
fn take_if_idle(
    sessions: &SessionsLock,
    openings: &OpeningsLock,
    server: &mut Option<BridgeServer>,
) -> Option<BridgeServer> {
    let sessions = sessions.read();
    if !sessions.is_empty() {
        return None;
    }
    let openings = openings.lock();
    if !openings.is_empty() {
        return None;
    }
    server.take()
}

fn request_cleanup(
    sessions: SessionsLock,
    openings: OpeningsLock,
    server: ServerLock,
    cleanup: Arc<IdleCleanupState>,
) {
    cleanup.pending.store(true, Ordering::Release);
    if cleanup
        .scheduled
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        // Keep pending set for a later close/cleanup attempt; Drop must not panic
        // when called outside a Tokio runtime.
        cleanup.scheduled.store(false, Ordering::Release);
        return;
    };

    handle.spawn(async move {
        loop {
            // Consume requests made before this pass. Requests arriving while
            // waiting for the server lock or checking state cause another pass.
            cleanup.pending.swap(false, Ordering::AcqRel);
            let detached = {
                let mut guard = server.lock().await;
                take_if_idle(&sessions, &openings, &mut guard)
            };
            drop(detached);
            if !cleanup.pending.swap(false, Ordering::AcqRel) {
                break;
            }
        }

        cleanup.scheduled.store(false, Ordering::Release);
        // Close the request-versus-finish race: a requester that saw the old
        // scheduled flag leaves pending set, and this handshake reschedules it.
        if cleanup.pending.swap(false, Ordering::AcqRel) {
            request_cleanup(sessions, openings, server, cleanup);
        }
    });
}
