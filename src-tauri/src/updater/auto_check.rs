//! Application-owned timer. A cancelled timer never cancels an accepted Core worker.
use super::{auto_check_policy::Policy, UpdateCoordinator};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
const PERIOD: std::time::Duration = std::time::Duration::from_secs(30 * 60);
#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct RuntimeError {
    pub code: &'static str,
    pub message: &'static str,
}
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub runtime_applied: bool,
    pub runtime_error: Option<RuntimeError>,
}
impl Receipt {
    fn success() -> Self {
        Self {
            runtime_applied: true,
            runtime_error: None,
        }
    }
    fn failed(code: &'static str) -> Self {
        Self {
            runtime_applied: false,
            runtime_error: Some(RuntimeError {
                code,
                message: match code {
                    "SETTINGS_UPDATER_PROVIDER_DISABLED" => "当前隔离实例未启用自动更新",
                    "SETTINGS_UPDATER_PROVIDER_UNAVAILABLE" => "当前更新提供方暂不可用",
                    "SETTINGS_UPDATER_RUNTIME_STOPPED" => "应用正在退出，自动检查未启动",
                    _ => "自动检查运行时暂不可用",
                },
            }),
        }
    }
}
pub(super) struct Scheduler {
    policy: Mutex<Policy>,
    tx: watch::Sender<Policy>,
    started: AtomicBool,
    active: Arc<AtomicBool>,
    finished: tokio::sync::Notify,
}
impl Default for Scheduler {
    fn default() -> Self {
        let (tx, _) = watch::channel(Policy::default());
        Self {
            policy: Mutex::new(Policy::default()),
            tx,
            started: AtomicBool::new(false),
            active: Arc::new(AtomicBool::new(false)),
            finished: tokio::sync::Notify::new(),
        }
    }
}
impl Scheduler {
    pub fn stop(&self) {
        if let Ok(mut p) = self.policy.lock() {
            p.stop();
            self.tx.send_replace(*p);
        }
    }
    pub fn current(&self, generation: u64) -> bool {
        self.policy
            .lock()
            .ok()
            .is_some_and(|p| !p.stopped && p.enabled && p.generation == generation)
    }
    pub fn generation(&self) -> Option<u64> {
        self.policy.lock().ok().map(|p| p.generation)
    }
    fn commit(&self, enabled: bool, startup: Option<u64>) -> Receipt {
        let Ok(mut p) = self.policy.lock() else {
            return Receipt::failed("SETTINGS_UPDATER_RUNTIME_UNAVAILABLE");
        };
        if p.stopped {
            return Receipt::failed("SETTINGS_UPDATER_RUNTIME_STOPPED");
        }
        let next = match startup {
            Some(g) => p.startup(g, enabled),
            None => p.apply(enabled),
        };
        if next.is_none() && startup.is_none() {
            return Receipt::failed("SETTINGS_UPDATER_RUNTIME_UNAVAILABLE");
        }
        if let Some(next) = next {
            self.tx.send_if_modified(|current| {
                if *current == next {
                    false
                } else {
                    *current = next;
                    true
                }
            });
        }
        Receipt::success()
    }
    fn start(self: &Arc<Self>, app: &AppHandle, state: &UpdateCoordinator) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let runtime = self.clone();
        let app = app.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            let launcher = runtime.clone();
            runtime
                .drive(move |generation| launcher.launch(&app, &state, generation))
                .await;
        });
    }
    async fn drive(self: Arc<Self>, launch: impl Fn(u64) -> bool) {
        let mut rx = self.tx.subscribe();
        loop {
            let desired = *rx.borrow_and_update();
            if desired.stopped {
                return;
            }
            if !desired.initialized || !desired.enabled {
                if rx.changed().await.is_err() {
                    return;
                }
                continue;
            }
            // One immediate attempt per enabled generation; intervals skip busy ticks without queues.
            let mut pending = !launch(desired.generation);
            let mut interval =
                tokio::time::interval_at(tokio::time::Instant::now() + PERIOD, PERIOD);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    changed = rx.changed() => { if changed.is_err() { return; } break; },
                    _ = interval.tick() => { launch(desired.generation); },
                    _ = self.finished.notified(), if pending => { pending = !launch(desired.generation); },
                }
            }
        }
    }
    fn launch(
        self: &Arc<Self>,
        app: &AppHandle,
        state: &UpdateCoordinator,
        generation: u64,
    ) -> bool {
        let current = self
            .policy
            .lock()
            .ok()
            .is_some_and(|p| !p.stopped && p.enabled && p.generation == generation);
        if !current {
            return true;
        }
        if self.active.swap(true, Ordering::AcqRel) {
            return false;
        }
        let app = app.clone();
        let state = state.clone();
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            struct Active(Arc<Scheduler>);
            impl Drop for Active {
                fn drop(&mut self) {
                    self.0.active.store(false, Ordering::Release);
                    self.0.finished.notify_one();
                }
            }
            let _active = Active(runtime);
            // A dedicated owned worker survives callers, preference changes and timer shutdown.
            let _ = super::entry::check_silent(&app, &state, generation).await;
        });
        true
    }
}
pub(crate) fn apply(app: &AppHandle, enabled: bool) -> Receipt {
    let Some(state) = app.try_state::<UpdateCoordinator>() else {
        return Receipt::failed("SETTINGS_UPDATER_RUNTIME_UNAVAILABLE");
    };
    apply_to(app, state.inner(), enabled, None)
}
pub(super) fn apply_to(
    app: &AppHandle,
    state: &UpdateCoordinator,
    enabled: bool,
    startup: Option<u64>,
) -> Receipt {
    // Persisted false always revokes scheduling, even when the provider is unavailable.
    if enabled {
        if let Err(e) = super::entry::provider_available(app) {
            // Revoke any preceding enabled generation; the durable preference remains authoritative.
            let _ = state.scheduler.commit(false, startup);
            return Receipt::failed(if e.code == "provider_disabled" {
                "SETTINGS_UPDATER_PROVIDER_DISABLED"
            } else {
                "SETTINGS_UPDATER_PROVIDER_UNAVAILABLE"
            });
        }
    }
    state.scheduler.start(app, state);
    state.scheduler.commit(enabled, startup)
}

#[cfg(test)]
#[path = "auto_check_tests.rs"]
mod tests;

#[cfg(feature = "legacy-node-smoke")]
#[path = "auto_check_fixture.rs"]
mod about_fixture;
