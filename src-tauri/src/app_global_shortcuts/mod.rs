//! Native owned App shortcuts. No callback enters DB, SDK or the UI.
pub(crate) mod feature_dispatch;
pub(crate) mod recording;
pub(crate) mod recording_gate;
mod recording_wait;
mod registry;
mod transaction;
mod wire;
mod worker;
use crate::app_launch_fence::AppLaunchFence;
use parking_lot::Mutex;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
pub(crate) use wire::MutationRequest;
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct BindingTarget {
    row_id: String,
    epoch: u64,
    config_generation: String,
    shortcut: String,
    path: String,
    name: String,
}
#[derive(Default)]
struct Queue {
    pressed: BTreeSet<(String, u64)>,
    pending: BTreeSet<(String, u64)>,
    events: VecDeque<BindingTarget>,
    epochs: BTreeMap<(String, u64), u64>,
}
pub(crate) struct Runtime {
    registry: Mutex<registry::Registry>,
    published: Mutex<BTreeMap<String, BindingTarget>>,
    queue: Mutex<Queue>,
    pub(crate) fence: AppLaunchFence,
    stopping: AtomicBool,
    epoch: AtomicU64,
    wake: Notify,
    pub(super) token: Mutex<Option<(String, atools_core::db::AppGlobalShortcutSnapshot)>>,
    pub(super) status: Mutex<BTreeMap<String, (String, Option<String>)>>,
    exit_started: AtomicBool,
    exit_allowed: AtomicBool,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            registry: Mutex::new(Default::default()),
            published: Mutex::new(BTreeMap::new()),
            queue: Mutex::new(Default::default()),
            fence: Default::default(),
            stopping: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            wake: Notify::new(),
            token: Mutex::new(None),
            status: Mutex::new(BTreeMap::new()),
            exit_started: AtomicBool::new(false),
            exit_allowed: AtomicBool::new(false),
        }
    }
}
impl Runtime {
    fn signal(&self, target: &BindingTarget, pressed: bool) {
        self.signal_at(target, pressed, 0);
    }
    fn signal_at(&self, target: &BindingTarget, pressed: bool, pause_epoch: u64) {
        let key = (target.row_id.clone(), target.epoch);
        let mut q = self.queue.lock();
        if !pressed {
            q.pressed.remove(&key);
            return;
        }
        if self.stopping.load(Ordering::Acquire)
            || q.pressed.len() >= 64
            || !q.pressed.insert(key.clone())
        {
            return;
        }
        if q.pending.len() < 64 && q.pending.insert(key) {
            q.epochs
                .insert((target.row_id.clone(), target.epoch), pause_epoch);
            q.events.push_back(target.clone());
            self.wake.notify_one();
        }
    }
    fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.fence.stop();
        let mut q = self.queue.lock();
        q.epochs.clear();
        q.events.clear();
        q.pending.clear();
        q.pressed.clear();
        self.wake.notify_waiters();
    }
}
pub(crate) fn runtime(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    app.try_state::<Arc<Runtime>>()
        .map(|s| s.inner().clone())
        .ok_or("App binding runtime unavailable".into())
}
pub(crate) fn install(app: &AppHandle) {
    let rt = Arc::new(Runtime::default());
    if !app.manage(rt.clone()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        worker::run(app, rt).await;
    });
}
pub(crate) async fn mutate(
    app: &AppHandle,
    revision: String,
    mutation: MutationRequest,
    revoked: Arc<AtomicBool>,
) -> Result<serde_json::Value, String> {
    transaction::mutate(app, revision, mutation, revoked).await
}
pub(crate) async fn read(app: &AppHandle) -> Result<serde_json::Value, String> {
    let db = app.state::<crate::state::AppState>().db.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || db.read_renderer_app_global_shortcuts())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
    let rt = runtime(app)?;
    wire::projection(rt.as_ref(), &snapshot)
}
pub(crate) async fn drain(app: &AppHandle) -> Result<(), String> {
    worker::drain(app).await
}
pub(crate) fn request_exit(app: &AppHandle, code: i32) -> bool {
    let Ok(rt) = runtime(app) else { return false };
    if rt.exit_allowed.load(Ordering::Acquire) {
        return false;
    }
    if let Ok(gate) = recording::gate(app) {
        gate.close();
    }
    rt.stop();
    if let Some(attempt) = ExitAttempt::claim(&rt) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match drain(&app).await {
                Ok(()) => {
                    attempt.allow();
                    app.exit(code)
                }
                Err(e) => tracing::error!(%e,"App binding drain incomplete"),
            }
        });
    }
    true
}
/// One explicitly requested exit owns cleanup. Failure/cancellation releases only
/// admission; permanent dispatch fences and failed ownership remain untouched.
struct ExitAttempt {
    runtime: Arc<Runtime>,
    allowed: bool,
}
impl ExitAttempt {
    fn claim(runtime: &Arc<Runtime>) -> Option<Self> {
        if runtime.exit_allowed.load(Ordering::Acquire) {
            return None;
        }
        runtime
            .exit_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        Some(Self {
            runtime: runtime.clone(),
            allowed: false,
        })
    }
    fn allow(mut self) {
        self.runtime.exit_allowed.store(true, Ordering::Release);
        self.allowed = true;
    }
}
impl Drop for ExitAttempt {
    fn drop(&mut self) {
        if !self.allowed {
            self.runtime.exit_started.store(false, Ordering::Release);
        }
    }
}
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transaction_tests;
