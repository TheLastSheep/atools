//! Session-bound OS drops for the original local-launch settings route.
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, DragDropEvent, Manager, Webview, WebviewEvent, Wry};
#[cfg(feature = "legacy-node-smoke")]
use tokio::sync::oneshot;

use super::{
    identity::{self, is_expected_origin},
    phase::SessionPhase,
    session::{SessionView, SettingsViewRuntime},
};

#[path = "native_drop_delivery.rs"]
mod delivery;
use delivery::send_notice;

#[path = "native_drop_binding.rs"]
mod binding;
pub(super) use binding::bind_child;
#[cfg(feature = "legacy-node-smoke")]
#[path = "native_drop_fixture.rs"]
mod fixture;
#[cfg(feature = "legacy-node-smoke")]
pub(super) use fixture::install_fixture_registry;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use fixture::{
    fixture_binding_active, inject_owned_fixture_drop, FixtureDropCompletion, FixtureDropReceipt,
};

const MAX_DROP_PATHS: usize = 64;
const MAX_DROP_PATH_BYTES: usize = 16 * 1024;
const MAX_DROP_TOTAL_BYTES: usize = 64 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DELIVER_FUNCTION: &str = "__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__";

#[derive(Clone, Debug, Eq, PartialEq)]
struct ChildIdentity {
    session_id: String,
    label: String,
    bundle_revision: String,
}

#[derive(Clone, Debug)]
struct TargetSnapshot {
    session_id: String,
    label: String,
    origin: String,
    bundle_revision: String,
    current_bundle_revision: String,
    webview_label: String,
    parent_label: String,
    phase: SessionPhase,
    ready: bool,
    revoked: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum NoticePhase {
    Enter,
    Leave,
    Result,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DropNotice {
    version: u8,
    session_id: String,
    revision: u64,
    phase: NoticePhase,
    added: u64,
    failed: u64,
    busy: bool,
    rejected: bool,
}

impl DropNotice {
    fn valid(&self) -> bool {
        self.version == 1
            && !self.session_id.is_empty()
            && self.revision > 0
            && self.revision <= MAX_SAFE_INTEGER
            && self.added <= MAX_DROP_PATHS as u64
            && self.failed <= MAX_DROP_PATHS as u64
            && self.added + self.failed <= MAX_DROP_PATHS as u64
            && !(self.busy && self.rejected)
            && (!(self.busy || self.rejected) || (self.added == 0 && self.failed == 0))
            && (self.phase == NoticePhase::Result
                || (self.added == 0 && self.failed == 0 && !self.busy && !self.rejected))
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct DropCounts {
    added: u64,
    failed: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PathOutcome {
    Added,
    Failed,
    Stop,
}

struct DropFlight(Arc<AtomicBool>);

impl DropFlight {
    fn try_start(state: Arc<AtomicBool>) -> Option<Self> {
        state
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(state))
    }
}

impl Drop for DropFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

enum DropDispatch {
    Ignored,
    Busy,
    Rejected,
    Started {
        #[cfg(feature = "legacy-node-smoke")]
        batch_nonce: String,
        #[cfg(feature = "legacy-node-smoke")]
        completion: oneshot::Receiver<DropCompletion>,
    },
}

#[cfg(feature = "legacy-node-smoke")]
struct DropCompletion {
    counts: DropCounts,
    result_notice_enqueued: bool,
}

fn hover_notice_for_event(active: &AtomicBool, event: &DragDropEvent) -> Option<NoticePhase> {
    match event {
        DragDropEvent::Enter { .. } if hover_transition(active, true) => Some(NoticePhase::Enter),
        DragDropEvent::Leave | DragDropEvent::Drop { .. } if hover_transition(active, false) => {
            Some(NoticePhase::Leave)
        }
        _ => None,
    }
}

fn hover_transition(active: &AtomicBool, entering: bool) -> bool {
    active.swap(entering, Ordering::AcqRel) != entering
}

fn receive_drop(
    app: &AppHandle<Wry>,
    runtime: &Weak<SettingsViewRuntime>,
    identity: &ChildIdentity,
    revisions: &Arc<AtomicU64>,
    drop_flight: &Arc<AtomicBool>,
    paths: &[PathBuf],
) -> DropDispatch {
    if current_target(app, runtime, identity).is_none() {
        return DropDispatch::Ignored;
    }
    let Some(_flight) = DropFlight::try_start(Arc::clone(drop_flight)) else {
        send_notice(
            app,
            runtime,
            identity,
            revisions,
            NoticePhase::Result,
            DropCounts::default(),
            true,
            false,
        );
        return DropDispatch::Busy;
    };
    let validated = match validate_paths(paths) {
        Ok(paths) => paths,
        Err(()) => {
            send_notice(
                app,
                runtime,
                identity,
                revisions,
                NoticePhase::Result,
                DropCounts::default(),
                false,
                true,
            );
            return DropDispatch::Rejected;
        }
    };

    let app = app.clone();
    let runtime = runtime.clone();
    let identity = identity.clone();
    let revisions = Arc::clone(revisions);
    let flight = _flight;
    #[cfg(feature = "legacy-node-smoke")]
    let batch_nonce = uuid::Uuid::new_v4().simple().to_string();
    #[cfg(feature = "legacy-node-smoke")]
    let (completed, completion) = oneshot::channel();
    let _task = tauri::async_runtime::spawn(async move {
        let _flight = flight;
        let Some(runtime_state) = runtime.upgrade() else {
            return;
        };
        let accounting = runtime_state.accounting();
        let counts = execute_path_batch(
            &validated,
            || current_target(&app, &runtime, &identity).is_some(),
            |path| {
                let app = app.clone();
                let runtime = runtime.clone();
                let identity = identity.clone();
                let accounting = Arc::clone(&accounting);
                async move {
                    let Some((session, _child)) = current_target(&app, &runtime, &identity) else {
                        return PathOutcome::Stop;
                    };
                    let Ok(permit) = session.operations.clone().try_acquire_owned() else {
                        return PathOutcome::Stop;
                    };
                    let call_guard = accounting.track_call();
                    match super::local_shortcuts::handle(
                        app,
                        session,
                        "addLocalShortcutByPath",
                        json!({"path":path}),
                        permit,
                        call_guard,
                        Arc::clone(&accounting),
                    )
                    .await
                    {
                        Ok(_) => PathOutcome::Added,
                        Err(_) => PathOutcome::Failed,
                    }
                }
            },
        )
        .await;
        let result_notice_enqueued = send_notice(
            &app,
            &runtime,
            &identity,
            &revisions,
            NoticePhase::Result,
            counts,
            false,
            false,
        );
        drop(_flight);
        #[cfg(feature = "legacy-node-smoke")]
        let _ = completed.send(DropCompletion {
            counts,
            result_notice_enqueued,
        });
    });
    DropDispatch::Started {
        #[cfg(feature = "legacy-node-smoke")]
        batch_nonce,
        #[cfg(feature = "legacy-node-smoke")]
        completion,
    }
}

async fn execute_path_batch<F, Fut>(
    paths: &[String],
    mut still_current: impl FnMut() -> bool,
    mut add: F,
) -> DropCounts
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = PathOutcome>,
{
    let mut counts = DropCounts::default();
    for (index, path) in paths.iter().enumerate() {
        if !still_current() {
            counts.failed += (paths.len() - index) as u64;
            break;
        }
        match add(path.clone()).await {
            PathOutcome::Added => counts.added += 1,
            PathOutcome::Failed => counts.failed += 1,
            PathOutcome::Stop => {
                counts.failed += (paths.len() - index) as u64;
                break;
            }
        }
    }
    counts
}

fn validate_paths(paths: &[PathBuf]) -> Result<Vec<String>, ()> {
    if paths.is_empty() || paths.len() > MAX_DROP_PATHS {
        return Err(());
    }
    let mut total_bytes = 0usize;
    let mut validated = Vec::with_capacity(paths.len());
    for path in paths {
        let path = path.to_str().ok_or(())?;
        if path.is_empty()
            || path.len() > MAX_DROP_PATH_BYTES
            || path.contains('\0')
            || path.chars().any(char::is_control)
            || !Path::new(path).is_absolute()
        {
            return Err(());
        }
        total_bytes = total_bytes.checked_add(path.len()).ok_or(())?;
        if total_bytes > MAX_DROP_TOTAL_BYTES {
            return Err(());
        }
        validated.push(path.to_owned());
    }
    Ok(validated)
}

fn current_target(
    app: &AppHandle<Wry>,
    runtime: &Weak<SettingsViewRuntime>,
    identity: &ChildIdentity,
) -> Option<(SessionView, Webview<Wry>)> {
    let runtime = runtime.upgrade()?;
    let session = runtime.current_for_id(&identity.session_id).ok()?;
    let child = app.get_webview(&identity.label)?;
    let url = child.url().ok()?;
    let signal = session.signal();
    let snapshot = TargetSnapshot {
        session_id: session.id.clone(),
        label: session.label.clone(),
        origin: session.origin.clone(),
        bundle_revision: session.bundle_revision.clone(),
        current_bundle_revision: session.bundle.revision().to_owned(),
        webview_label: child.label().to_owned(),
        parent_label: child.window().label().to_owned(),
        phase: signal.phase,
        ready: signal.ready,
        revoked: session.is_revoked(),
    };
    target_matches(identity, &snapshot, &url).then_some((session, child))
}

fn target_matches(identity: &ChildIdentity, target: &TargetSnapshot, url: &tauri::Url) -> bool {
    target.session_id == identity.session_id
        && target.label == identity.label
        && target.webview_label == identity.label
        && target.parent_label == "main"
        && target.origin == format!("atools-settings://{}.localhost", identity.session_id)
        && target.bundle_revision == identity.bundle_revision
        && target.current_bundle_revision == identity.bundle_revision
        && target.phase == SessionPhase::Open
        && target.ready
        && !target.revoked
        && is_expected_origin(&target.origin, &target.session_id)
        && identity::is_local_launch_settings_url(url, &identity.session_id)
}

#[cfg(test)]
#[path = "native_drop_tests.rs"]
mod tests;
