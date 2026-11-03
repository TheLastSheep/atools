//! Generation-fenced targeted enqueue; no window/URL getter while holding delivery.
use super::*;
use crate::updater::{
    snapshot::{Phase, Snapshot},
    UpdateOperation, UpdateStatus,
};
use std::sync::{atomic::Ordering, Arc};
use tauri::{Emitter, EventTarget, Manager};
pub(super) fn bind(app: &AppHandle) -> Result<(), Error> {
    let state = app
        .try_state::<crate::updater::UpdateCoordinator>()
        .ok_or_else(|| error("state_unavailable"))?;
    // AppHandle has no public weak handle in locked Tauri. Exit explicitly clears this callback.
    let owned = app.clone();
    state.bind_notifier(Arc::new(move |snapshot, progress_only| {
        publish(&owned, snapshot, progress_only)
    }));
    Ok(())
}
pub(super) fn publish(app: &AppHandle, snapshot: Snapshot, progress_only: bool) {
    if let Ok(runtime) = runtime(app) {
        runtime.enqueue_snapshot(&snapshot, |session, snapshot| {
            app.emit_to(
                EventTarget::webview(&session.label),
                "renderer-updater-state",
                serde_json::json!({"windowId":session.id,"snapshot":snapshot}),
            )
            .is_ok()
        });
    }
    if !progress_only {
        if coordinator(app).is_ok_and(|state| !state.main_discovery_current()) {
            return;
        }
        let Ok(runtime) = runtime(app) else { return };
        let _delivery = runtime.delivery.lock();
        if runtime.stopped.load(Ordering::Acquire) {
            return;
        }
        let _ = app.emit_to(
            EventTarget::webview("main"),
            "renderer-updater-main-state",
            &snapshot,
        );
        let legacy = UpdateStatus {
            operation: match snapshot.phase {
                Phase::Checking => UpdateOperation::Checking,
                Phase::Downloading | Phase::Downloaded | Phase::Installing => {
                    UpdateOperation::Installing
                }
                Phase::Restarting => UpdateOperation::Restarting,
                _ => UpdateOperation::Idle,
            },
            update: snapshot.candidate,
            checked: snapshot.checked,
            last_error: snapshot.error,
        };
        for label in ["main", "settings"] {
            let _ = app.emit_to(EventTarget::webview(label), "app-update-status", &legacy);
        }
    }
}
pub(super) fn handshake(app: &AppHandle, id: &str) -> Result<Snapshot, Error> {
    let runtime = runtime(app)?;
    let _delivery = runtime.delivery.lock();
    let snapshot = coordinator(app)?.view()?;
    let mut sessions = runtime.session.lock();
    let s = sessions
        .as_mut()
        .filter(|s| s.id == id && s.alive.load(Ordering::Acquire))
        .ok_or_else(|| error("forbidden_window"))?;
    if snapshot.sequence >= s.last_sequence {
        s.ready = true;
        s.candidate = snapshot.candidate.as_ref().map(|m| m.candidate_id.clone());
        s.last_sequence = snapshot.sequence;
    }
    Ok(snapshot)
}
