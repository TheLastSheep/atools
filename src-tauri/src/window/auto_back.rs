use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::{AppHandle, Manager};

type RuntimeTask = tauri::async_runtime::JoinHandle<()>;

#[derive(Clone, Default)]
pub(crate) struct AutoBackController {
    state: Arc<Mutex<TimerState<RuntimeTimer>>>,
}

struct RuntimeTimer(RuntimeTask);

trait TimerTask: Send + 'static {
    fn abort_and_reap(self);
    fn reap(self);
}

impl TimerTask for RuntimeTimer {
    fn abort_and_reap(self) {
        self.0.abort();
        tauri::async_runtime::spawn(async move {
            let _ = self.0.await;
        });
    }

    fn reap(self) {
        tauri::async_runtime::spawn(async move {
            let _ = self.0.await;
        });
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Preparing(u64),
    Waiting(u64),
    Returning(u64),
    Stopped,
}

struct TimerState<T> {
    generation: u64,
    phase: Phase,
    deadline: Option<Instant>,
    wait_task: Option<T>,
    return_task: Option<T>,
}

impl<T> Default for TimerState<T> {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: Phase::Idle,
            deadline: None,
            wait_task: None,
            return_task: None,
        }
    }
}

struct BeginHide<T> {
    generation: Option<u64>,
    replaced_timer: bool,
    old_task: Option<T>,
}

struct Claim<T> {
    accepted: bool,
    elapsed_task: Option<T>,
    cancelled_task: Option<T>,
}

struct StoppedTasks<T> {
    wait_task: Option<T>,
    return_task: Option<T>,
}

impl<T> TimerState<T> {
    fn begin_hide(&mut self) -> BeginHide<T> {
        if matches!(self.phase, Phase::Returning(_)) {
            return BeginHide {
                generation: None,
                replaced_timer: false,
                old_task: None,
            };
        }
        let replaced_timer = matches!(self.phase, Phase::Preparing(_) | Phase::Waiting(_));
        let old_task = self.wait_task.take();
        self.deadline = None;
        if self.phase == Phase::Stopped {
            return BeginHide {
                generation: None,
                replaced_timer,
                old_task,
            };
        }

        let Some(generation) = self.generation.checked_add(1) else {
            self.phase = Phase::Stopped;
            return BeginHide {
                generation: None,
                replaced_timer,
                old_task,
            };
        };
        self.generation = generation;
        self.phase = Phase::Preparing(generation);
        BeginHide {
            generation: Some(generation),
            replaced_timer,
            old_task,
        }
    }

    fn arm(&mut self, generation: u64, deadline: Instant) -> bool {
        if self.phase != Phase::Preparing(generation) {
            return false;
        }
        self.phase = Phase::Waiting(generation);
        self.deadline = Some(deadline);
        true
    }

    fn abandon(&mut self, generation: u64) {
        if self.phase == Phase::Preparing(generation) {
            self.phase = Phase::Idle;
            self.deadline = None;
        }
    }

    fn install_wait(&mut self, generation: u64, task: T) -> Result<(), T> {
        if self.phase == Phase::Waiting(generation) && self.wait_task.is_none() {
            self.wait_task = Some(task);
            Ok(())
        } else {
            Err(task)
        }
    }

    fn install_return(&mut self, generation: u64, task: T) -> Result<(), T> {
        if self.phase == Phase::Returning(generation) && self.return_task.is_none() {
            self.return_task = Some(task);
            Ok(())
        } else {
            Err(task)
        }
    }

    fn claim(&mut self, generation: u64) -> Claim<T> {
        if self.phase != Phase::Waiting(generation) {
            return Claim {
                accepted: false,
                elapsed_task: None,
                cancelled_task: None,
            };
        }
        self.phase = Phase::Returning(generation);
        self.deadline = None;
        Claim {
            accepted: true,
            elapsed_task: self.wait_task.take(),
            cancelled_task: None,
        }
    }

    fn claim_if_hidden(&mut self, generation: u64, is_hidden: bool) -> Claim<T> {
        if is_hidden {
            return self.claim(generation);
        }
        Claim {
            accepted: false,
            elapsed_task: None,
            cancelled_task: self.cancel(),
        }
    }

    fn finish_wait(&mut self, generation: u64) -> Option<T> {
        if !matches!(self.phase, Phase::Waiting(current) if current == generation) {
            return None;
        }
        self.phase = Phase::Idle;
        self.deadline = None;
        self.wait_task.take()
    }

    fn finish_return(&mut self, generation: u64) -> Option<T> {
        if self.phase != Phase::Returning(generation) {
            return None;
        }
        self.phase = Phase::Idle;
        self.return_task.take()
    }

    fn cancel(&mut self) -> Option<T> {
        if matches!(self.phase, Phase::Returning(_) | Phase::Stopped) {
            return None;
        }
        let task = self.wait_task.take();
        self.deadline = None;
        if let Some(generation) = self.generation.checked_add(1) {
            self.generation = generation;
            self.phase = Phase::Idle;
        } else {
            self.phase = Phase::Stopped;
        }
        task
    }

    fn stop(&mut self) -> StoppedTasks<T> {
        self.phase = Phase::Stopped;
        self.deadline = None;
        StoppedTasks {
            wait_task: self.wait_task.take(),
            return_task: self.return_task.take(),
        }
    }
}

impl AutoBackController {
    fn state(&self) -> MutexGuard<'_, TimerState<RuntimeTimer>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin_hide(&self) -> Option<u64> {
        let begun = { self.state().begin_hide() };
        if begun.replaced_timer {
            tracing::debug!("Replacing the previous main-window auto-return timer");
        }
        if let Some(task) = begun.old_task {
            task.abort_and_reap();
        }
        begun.generation
    }

    fn arm(&self, generation: u64, deadline: Instant) -> bool {
        let armed = self.state().arm(generation, deadline);
        armed
    }

    fn abandon(&self, generation: u64) {
        self.state().abandon(generation);
    }

    fn install_wait(&self, generation: u64, task: RuntimeTimer) -> Result<(), RuntimeTimer> {
        self.state().install_wait(generation, task)
    }

    fn install_return(&self, generation: u64, task: RuntimeTimer) -> Result<(), RuntimeTimer> {
        self.state().install_return(generation, task)
    }

    fn claim_if_hidden(&self, generation: u64, is_hidden: bool) -> Claim<RuntimeTimer> {
        self.state().claim_if_hidden(generation, is_hidden)
    }

    fn finish_wait(&self, generation: u64) {
        let task = { self.state().finish_wait(generation) };
        if let Some(task) = task {
            task.reap();
        }
    }

    fn finish_return(&self, generation: u64) {
        let task = { self.state().finish_return(generation) };
        if let Some(task) = task {
            task.reap();
        }
    }

    fn cancel(&self) {
        let task = self.state().cancel();
        if let Some(task) = task {
            task.abort_and_reap();
        }
    }

    fn stop(&self) {
        let tasks = { self.state().stop() };
        if let Some(task) = tasks.wait_task {
            task.abort_and_reap();
        }
        if let Some(task) = tasks.return_task {
            task.abort_and_reap();
        }
    }
}

pub(crate) fn cancel_auto_back_on_show(app: &AppHandle) {
    if let Some(controller) = controller(app) {
        controller.cancel();
    }
}

pub(crate) fn main_window_hidden(app: &AppHandle) {
    crate::renderer_main_drop::suspend(app);
    crate::hotkey::recording_runtime::note_main_hidden(app);
    let _ = crate::hotkey::recording_runtime::cancel_session(app, None);
    let hidden_at = Instant::now();
    let Some(controller) = controller(app) else {
        return;
    };
    let Some(generation) = controller.begin_hide() else {
        return;
    };
    if !main_window_is_hidden(app) {
        controller.abandon(generation);
        return;
    }
    let Some(delay) = configured_delay(app) else {
        controller.abandon(generation);
        return;
    };
    let Some(deadline) = hidden_at.checked_add(delay) else {
        controller.abandon(generation);
        return;
    };
    if !controller.arm(generation, deadline) {
        return;
    }

    let task_app = app.clone();
    let task_controller = controller.clone();
    let task = tauri::async_runtime::spawn(async move {
        wait_for_deadline(task_app, task_controller, generation, deadline).await;
    });
    if let Err(task) = controller.install_wait(generation, RuntimeTimer(task)) {
        task.abort_and_reap();
    }
}

pub(crate) fn stop_auto_back(app: &AppHandle) {
    if let Some(controller) = controller(app) {
        controller.stop();
    }
}

fn controller(app: &AppHandle) -> Option<AutoBackController> {
    app.try_state::<AutoBackController>()
        .map(|state| state.inner().clone())
}

fn main_window_is_hidden(app: &AppHandle) -> bool {
    crate::window::main_window(app)
        .ok()
        .and_then(|window| window.is_visible().ok())
        .is_some_and(|visible| !visible)
}

fn configured_delay(app: &AppHandle) -> Option<Duration> {
    let state = app.try_state::<crate::state::AppState>()?;
    let raw = state
        .inner()
        .db
        .get_setting("settings-general")
        .ok()
        .flatten()?;
    let settings: Value = serde_json::from_str(&raw).ok()?;
    delay_for_setting(settings.get("autoBackToSearch")?.as_str()?)
}

fn delay_for_setting(value: &str) -> Option<Duration> {
    match value {
        "immediately" => Some(Duration::ZERO),
        "30s" => Some(Duration::from_secs(30)),
        "1m" => Some(Duration::from_secs(60)),
        "3m" => Some(Duration::from_secs(180)),
        "5m" => Some(Duration::from_secs(300)),
        "10m" => Some(Duration::from_secs(600)),
        "never" => None,
        _ => None,
    }
}

async fn wait_for_deadline(
    app: AppHandle,
    controller: AutoBackController,
    generation: u64,
    deadline: Instant,
) {
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
    let claim_controller = controller.clone();
    let claim_app = app.clone();
    if app
        .run_on_main_thread(move || {
            // Recheck on the main thread immediately before the claim. A direct
            // show path may have made the shared main window visible without
            // going through the normal cancellation helper.
            let claim =
                claim_controller.claim_if_hidden(generation, main_window_is_hidden(&claim_app));
            if let Some(task) = claim.cancelled_task {
                task.abort_and_reap();
            }
            if let Some(task) = claim.elapsed_task {
                task.reap();
            }
            if !claim.accepted {
                return;
            }

            // Gate the newly spawned task until its handle is installed. This
            // lets Exit abort/reap it even if lifecycle shutdown races setup.
            let (start_return, await_start) = tokio::sync::oneshot::channel();
            let return_app = claim_app.clone();
            let return_controller = claim_controller.clone();
            let return_task = tauri::async_runtime::spawn(async move {
                if await_start.await.is_err() {
                    return;
                }
                if crate::renderer_settings_view::return_to_search_after_hide(&return_app)
                    .await
                    .is_err()
                {
                    tracing::warn!("Main-window auto-return request failed");
                }
                return_controller.finish_return(generation);
            });
            if let Err(task) =
                claim_controller.install_return(generation, RuntimeTimer(return_task))
            {
                task.abort_and_reap();
                return;
            }
            let _ = start_return.send(());
        })
        .is_err()
    {
        controller.finish_wait(generation);
    }
}

#[cfg(test)]
#[path = "auto_back_tests.rs"]
mod tests;
