#[path = "presented_paint_window_native.rs"]
mod native;
#[path = "presented_paint_window_trace.rs"]
mod trace;
#[path = "presented_paint_window_watch.rs"]
mod watch;

use trace::WindowFacts;
pub(super) use trace::WindowTrace;

use parking_lot::Mutex;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager, Wry};
use tokio::{
    sync::{oneshot, Notify},
    task::JoinHandle,
    time::{timeout, timeout_at, Instant},
};

const PRESENTATION_LIMIT: std::time::Duration = std::time::Duration::from_secs(12);
const MAIN_THREAD_LIMIT: std::time::Duration = std::time::Duration::from_secs(2);
const HIDE_WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(4);

const IDENTITY_INVALID: &str = "settings-input-presented-paint-identity-invalid";
const SHOW_FAILED: &str = "settings-input-presented-paint-show-failed";
const PRESENTATION_FAILED: &str = "settings-input-presented-paint-visible-state-invalid";
const FOCUS_CHANGED: &str = "settings-input-presented-paint-focus-changed";
const WINDOW_HIDDEN: &str = "settings-input-presented-paint-hide-failed";
const WATCHDOG_EXPIRED: &str = "settings-input-presented-paint-watchdog-expired";

const FAILURE_NONE: u8 = 0;
const FAILURE_PRESENTATION: u8 = 1;
const FAILURE_FOCUS: u8 = 2;
const FAILURE_WATCHDOG: u8 = 3;

struct LeaseState {
    active: AtomicBool,
    failure: AtomicU8,
    previous_level: Mutex<Option<isize>>,
    hide_started: AtomicBool,
    hide_result: Mutex<Option<Result<Value, &'static str>>>,
    hide_changed: Notify,
}

impl LeaseState {
    fn new() -> Self {
        Self {
            active: AtomicBool::new(true),
            failure: AtomicU8::new(FAILURE_NONE),
            previous_level: Mutex::new(None),
            hide_started: AtomicBool::new(false),
            hide_result: Mutex::new(None),
            hide_changed: Notify::new(),
        }
    }

    fn fail(&self, failure: u8) {
        let _ = self.failure.compare_exchange(
            FAILURE_NONE,
            failure,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.active.store(false, Ordering::Release);
    }

    fn failure_code(&self) -> Option<&'static str> {
        match self.failure.load(Ordering::Acquire) {
            FAILURE_PRESENTATION => Some(PRESENTATION_FAILED),
            FAILURE_FOCUS => Some(FOCUS_CHANGED),
            FAILURE_WATCHDOG => Some(WATCHDOG_EXPIRED),
            _ => None,
        }
    }
}

/// A bounded lease for presenting the isolated fixture's main window without activation.
pub(super) struct PresentedWindowLease {
    target: LeaseTarget,
    baseline: WindowFacts,
    deadline: Instant,
    watchdog: Option<JoinHandle<()>>,
}

pub(super) async fn show(
    app: &AppHandle<Wry>,
    run_id: &str,
    trace: WindowTrace,
) -> Result<PresentedWindowLease, &'static str> {
    let baseline_observation = trace::capture_native(app, run_id).await.ok();
    if let Some(observation) = baseline_observation {
        trace.baseline(observation);
    }
    let harness = app
        .try_state::<super::state::Harness>()
        .map(|state| state.inner().clone())
        .ok_or(IDENTITY_INVALID)?;
    let profile = harness.profile();
    if !profile.settings_input_journey
        || profile.paint_presentation != super::super::profile::PaintPresentation::VisibleUnfocused
        || profile.run_id != run_id
        || profile.identifier != format!("dev.atools.renderer-settings-input.{run_id}")
        || !native::valid_run_id(run_id)
        || app.config().identifier != profile.identifier
    {
        return Err(IDENTITY_INVALID);
    }

    let state = Arc::new(LeaseState::new());
    let target = LeaseTarget {
        app: app.clone(),
        harness: harness.clone(),
        run_id: run_id.to_owned(),
        state,
        trace: trace.clone(),
    };
    let baseline_observation = baseline_observation.ok_or(PRESENTATION_FAILED)?;
    let baseline =
        match trace::complete_activation_observation(app, &harness, baseline_observation).await {
            Ok(baseline) => baseline,
            Err(error) => {
                if baseline_observation.visible == Some(true) {
                    let _ = hide_once(&target).await;
                }
                return Err(error);
            }
        };
    if !baseline.initially_hidden_unfocused() {
        let error = if baseline.focus_changed_since(WindowFacts::default()) {
            FOCUS_CHANGED
        } else {
            PRESENTATION_FAILED
        };
        if baseline_observation.visible == Some(true) {
            let _ = hide_once(&target).await;
        }
        return Err(error);
    }

    let mut lease = PresentedWindowLease {
        target,
        baseline,
        deadline: Instant::now() + PRESENTATION_LIMIT,
        watchdog: None,
    };

    if let Err(error) = order_front(&lease.target).await {
        lease.target.state.fail(FAILURE_PRESENTATION);
        let hidden = hide_once(&lease.target).await.is_ok();
        return Err(if hidden { error } else { WINDOW_HIDDEN });
    }
    if let Err(error) =
        watch::wait_for_initial_visibility(&lease.target, lease.baseline, lease.deadline).await
    {
        let hidden = hide_once(&lease.target).await.is_ok();
        return Err(if hidden { error } else { WINDOW_HIDDEN });
    }
    lease.start_watchdog();
    Ok(lease)
}

impl PresentedWindowLease {
    pub(super) async fn snapshot(&self) -> Result<Value, &'static str> {
        if let Some(error) = self.target.state.failure_code() {
            return Err(error);
        }
        let observed = trace::observe_visibility(
            &self.target.app,
            &self.target.harness,
            &self.target.run_id,
            &self.target.trace,
        )
        .await;
        if let Some(error) = self.target.state.failure_code() {
            return Err(error);
        }
        let facts = match observed {
            Ok(facts) => facts,
            Err(error) => {
                self.target.state.fail(FAILURE_PRESENTATION);
                let hidden = hide_once(&self.target).await.is_ok();
                return Err(if hidden { error } else { WINDOW_HIDDEN });
            }
        };
        if facts.visible_unfocused_since(self.baseline) {
            return Ok(facts.presentation());
        }

        let failure = if facts.focus_changed_since(self.baseline) {
            FAILURE_FOCUS
        } else {
            FAILURE_PRESENTATION
        };
        self.target.state.fail(failure);
        let hidden = hide_once(&self.target).await.is_ok();
        Err(if hidden {
            self.target
                .state
                .failure_code()
                .unwrap_or(PRESENTATION_FAILED)
        } else {
            WINDOW_HIDDEN
        })
    }

    pub(super) async fn hide(&mut self) -> Result<Value, &'static str> {
        self.target.state.active.store(false, Ordering::Release);
        let result = hide_once(&self.target).await;
        self.abort_watchdog();
        result
    }

    pub(super) fn watchdog_expired(&self) -> bool {
        self.target.state.failure.load(Ordering::Acquire) == FAILURE_WATCHDOG
    }

    fn start_watchdog(&mut self) {
        self.watchdog = Some(watch::start(
            self.target.clone(),
            self.baseline,
            self.deadline,
        ));
    }

    fn abort_watchdog(&mut self) {
        if let Some(watchdog) = self.watchdog.take() {
            watchdog.abort();
        }
    }
}

impl Drop for PresentedWindowLease {
    fn drop(&mut self) {
        self.target.state.active.store(false, Ordering::Release);
        self.abort_watchdog();
        let hidden = self
            .target
            .state
            .hide_result
            .lock()
            .as_ref()
            .is_some_and(Result::is_ok);
        if hidden {
            return;
        }

        let app = self.target.app.clone();
        let task_app = app.clone();
        let run_id = self.target.run_id.clone();
        let previous_level = *self.target.state.previous_level.lock();
        let trace = self.target.trace.clone();
        let _ = app.run_on_main_thread(move || {
            let outcome = native::order_out(&task_app, &run_id, previous_level);
            if let Some(observation) = outcome.after_hide {
                trace.after_hide(observation);
            }
        });
    }
}

#[derive(Clone)]
struct LeaseTarget {
    app: AppHandle<Wry>,
    harness: super::state::Harness,
    run_id: String,
    state: Arc<LeaseState>,
    trace: WindowTrace,
}

async fn order_front(target: &LeaseTarget) -> Result<(), &'static str> {
    let (sender, receiver) = oneshot::channel();
    let app = target.app.clone();
    let task_app = app.clone();
    let run_id = target.run_id.clone();
    let state = Arc::clone(&target.state);
    let trace = target.trace.clone();
    app.run_on_main_thread(move || {
        if !state.active.load(Ordering::Acquire) || sender.is_closed() {
            return;
        }
        let outcome = native::order_front(&task_app, &run_id);
        if let Some(observation) = outcome.after_order_front {
            trace.after_order_front(observation);
        }
        if let Some(observation) = outcome.after_hide {
            trace.after_hide(observation);
        }
        if let Some(previous_level) = outcome.previous_level {
            *state.previous_level.lock() = Some(previous_level);
            if !state.active.load(Ordering::Acquire) || sender.is_closed() {
                let hidden = native::order_out(&task_app, &run_id, Some(previous_level));
                if let Some(observation) = hidden.after_hide {
                    trace.after_hide(observation);
                }
                return;
            }
        }
        let result = outcome.error.map_or(Ok(()), Err);
        if sender.send(result).is_err() {
            if let Some(previous_level) = outcome.previous_level {
                let hidden = native::order_out(&task_app, &run_id, Some(previous_level));
                if let Some(observation) = hidden.after_hide {
                    trace.after_hide(observation);
                }
            }
        }
    })
    .map_err(|_| SHOW_FAILED)?;

    match timeout(MAIN_THREAD_LIMIT, receiver).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(error),
        _ => Err(SHOW_FAILED),
    }
}

async fn hide_once(target: &LeaseTarget) -> Result<Value, &'static str> {
    if target
        .state
        .hide_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        let deadline = Instant::now() + HIDE_WAIT_LIMIT;
        loop {
            let notified = target.state.hide_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = target.state.hide_result.lock().as_ref().cloned() {
                return result;
            }
            timeout_at(deadline, notified)
                .await
                .map_err(|_| WINDOW_HIDDEN)?;
        }
    }

    target.state.active.store(false, Ordering::Release);
    let result = async {
        let (sender, receiver) = oneshot::channel();
        let app = target.app.clone();
        let task_app = app.clone();
        let run_id = target.run_id.clone();
        let previous_level = *target.state.previous_level.lock();
        let trace = target.trace.clone();
        app.run_on_main_thread(move || {
            let outcome = native::order_out(&task_app, &run_id, previous_level);
            if let Some(observation) = outcome.after_hide {
                trace.after_hide(observation);
            }
            let _ = sender.send(outcome);
        })
        .map_err(|_| WINDOW_HIDDEN)?;
        let outcome = timeout(MAIN_THREAD_LIMIT, receiver)
            .await
            .map_err(|_| WINDOW_HIDDEN)?
            .map_err(|_| WINDOW_HIDDEN)?;
        if let Some(error) = outcome.error {
            return Err(error);
        }
        let observation = outcome.after_hide.ok_or(WINDOW_HIDDEN)?;
        let facts =
            trace::complete_activation_observation(&target.app, &target.harness, observation)
                .await
                .map_err(|_| WINDOW_HIDDEN)?;
        if !facts.cleanup_confirmed() {
            return Err(WINDOW_HIDDEN);
        }
        Ok(facts.cleanup())
    }
    .await;
    *target.state.hide_result.lock() = Some(result.clone());
    target.state.hide_changed.notify_waiters();
    result
}

#[cfg(test)]
#[path = "presented_paint_window_tests.rs"]
mod tests;
