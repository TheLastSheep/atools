//! Main-thread delivery keeps native revisions in the order the Child observes them.
use super::*;

type ScheduledDelivery = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone, Copy)]
struct PendingNotice {
    phase: NoticePhase,
    counts: DropCounts,
    busy: bool,
    rejected: bool,
}

impl PendingNotice {
    fn notice(self, session_id: String, revision: u64) -> DropNotice {
        DropNotice {
            version: 1,
            session_id,
            revision,
            phase: self.phase,
            added: self.counts.added,
            failed: self.counts.failed,
            busy: self.busy,
            rejected: self.rejected,
        }
    }
}

/// True means accepted by the main-thread scheduler, not delivered to a live Child.
pub(super) fn send_notice(
    app: &AppHandle<Wry>,
    runtime: &Weak<SettingsViewRuntime>,
    identity: &ChildIdentity,
    revisions: &Arc<AtomicU64>,
    phase: NoticePhase,
    counts: DropCounts,
    busy: bool,
    rejected: bool,
) -> bool {
    let target_app = app.clone();
    let runtime = runtime.clone();
    let identity = identity.clone();
    schedule_notice(
        PendingNotice {
            phase,
            counts,
            busy,
            rejected,
        },
        identity.session_id.clone(),
        Arc::clone(revisions),
        move || current_target(&target_app, &runtime, &identity).map(|(_, child)| child),
        |child, script| child.eval(script).is_ok(),
        |delivery| app.run_on_main_thread(delivery),
    )
}

// This is the production queue seam: target lookup, revision allocation and eval
// all run in one main-thread closure. In particular, no URL lookup can suspend a
// background sender after it has reserved a revision that a GUI sender overtakes.
fn schedule_notice<T: Send + 'static, E>(
    pending: PendingNotice,
    session_id: String,
    revisions: Arc<AtomicU64>,
    target: impl FnOnce() -> Option<T> + Send + 'static,
    eval: impl FnOnce(T, &str) -> bool + Send + 'static,
    schedule: impl FnOnce(ScheduledDelivery) -> Result<(), E>,
) -> bool {
    if !pending.notice(session_id.clone(), 1).valid() {
        return false;
    }
    schedule(Box::new(move || {
        let _ = deliver_notice(pending, session_id, &revisions, target, eval);
    }))
    .is_ok()
}

fn deliver_notice<T>(
    pending: PendingNotice,
    session_id: String,
    revisions: &AtomicU64,
    target: impl FnOnce() -> Option<T>,
    eval: impl FnOnce(T, &str) -> bool,
) -> bool {
    let Some(child) = target() else {
        return false;
    };
    let Some(revision) = next_revision(revisions) else {
        return false;
    };
    let notice = pending.notice(session_id, revision);
    let Ok(serialized) = serde_json::to_string(&notice) else {
        return false;
    };
    let serialized = serialized
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    eval(child, &format!("window.{DELIVER_FUNCTION}({serialized});"))
}

pub(super) fn next_revision(revisions: &AtomicU64) -> Option<u64> {
    revisions
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            (current < MAX_SAFE_INTEGER).then_some(current + 1)
        })
        .ok()
        .map(|previous| previous + 1)
}

#[cfg(test)]
#[path = "native_drop_delivery_tests.rs"]
mod tests;
