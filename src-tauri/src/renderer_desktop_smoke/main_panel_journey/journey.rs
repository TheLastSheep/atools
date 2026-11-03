use super::{
    operations::{self, NativeOperations},
    probe,
    report::{self, *},
    state::{Harness, Stage, StageFacts},
};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Wry};

const READY_TIMEOUT: Duration = Duration::from_secs(12);
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const TOTAL_BUDGET: Duration = Duration::from_secs(60);
const CLEANUP_WAIT: Duration = Duration::from_secs(4);

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let started = Instant::now();
    if harness.wait_ready(READY_TIMEOUT).await.is_none() {
        harness.note_error(DOM_READY_TIMEOUT);
        return Err(DOM_READY_TIMEOUT);
    }
    if over_budget(started, harness) {
        return Err(WATCHDOG_EXPIRED);
    }

    let baseline = capture_stage(app, harness, Stage::Baseline).await?;
    if !report::stage_is_valid(
        Stage::Baseline,
        &baseline,
        harness.0.state.lock().baseline_app_active,
    ) {
        harness.note_error(BASELINE_INVALID);
    }
    if over_budget(started, harness) {
        return Err(WATCHDOG_EXPIRED);
    }

    let shown = main_window_action(app, &harness.0.operations, Action::Show).await;
    if shown.is_err() {
        harness.note_error(SHOW_FAILED);
        return Err(SHOW_FAILED);
    }
    let shown = capture_stage(app, harness, Stage::Shown).await?;
    if !report::stage_is_valid(
        Stage::Shown,
        &shown,
        harness.0.state.lock().baseline_app_active,
    ) {
        harness.note_error(SHOWN_INVALID);
    }
    if over_budget(started, harness) {
        return Err(WATCHDOG_EXPIRED);
    }

    if main_window_action(app, &harness.0.operations, Action::Hide)
        .await
        .is_err()
    {
        harness.note_error(HIDE_FAILED);
        return Err(HIDE_FAILED);
    }
    let hidden = capture_stage(app, harness, Stage::Hidden).await?;
    if !report::stage_is_valid(
        Stage::Hidden,
        &hidden,
        harness.0.state.lock().baseline_app_active,
    ) {
        harness.note_error(HIDDEN_INVALID);
    }
    if over_budget(started, harness) {
        return Err(WATCHDOG_EXPIRED);
    }

    match main_window_action(app, &harness.0.operations, Action::Toggle).await {
        Ok(true) => {}
        _ => {
            harness.note_error(TOGGLE_RESHOW_FAILED);
            return Err(TOGGLE_RESHOW_FAILED);
        }
    }
    let reshown = capture_stage(app, harness, Stage::Reshown).await?;
    if !report::stage_is_valid(
        Stage::Reshown,
        &reshown,
        harness.0.state.lock().baseline_app_active,
    ) {
        harness.note_error(RESHOWN_INVALID);
    }
    if over_budget(started, harness) {
        return Err(WATCHDOG_EXPIRED);
    }
    super::constructor_probe::run_if_requested(app, harness).await;
    Ok(())
}

enum Action {
    Show,
    Hide,
    Toggle,
}

async fn main_window_action(
    app: &AppHandle<Wry>,
    operations: &Arc<NativeOperations>,
    action: Action,
) -> Result<bool, &'static str> {
    let dispatch_app = app.clone();
    let action_app = dispatch_app.clone();
    operations
        .run(&dispatch_app, move || match action {
            Action::Show => crate::window::show_main_window(&action_app)
                .map(|()| true)
                .map_err(|_| SHOW_FAILED),
            Action::Hide => crate::window::hide_main_window(&action_app)
                .map(|()| false)
                .map_err(|_| HIDE_FAILED),
            Action::Toggle => {
                crate::window::toggle_main_window(&action_app).map_err(|_| TOGGLE_RESHOW_FAILED)
            }
        })
        .await
}

async fn capture_stage(
    app: &AppHandle<Wry>,
    harness: &Harness,
    stage: Stage,
) -> Result<StageFacts, &'static str> {
    let webview = crate::window::main_webview(app).map_err(|_| PROBE_INVALID)?;
    let (probe_id, receiver) = probe::begin_stage(&webview, harness, stage)?;
    match tokio::time::timeout(PROBE_TIMEOUT, receiver).await {
        Ok(Ok(Ok(facts))) => Ok(facts),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => {
            harness.note_error(PROBE_INVALID);
            Err(PROBE_INVALID)
        }
        Err(_) => {
            harness.cancel_stage(probe_id);
            harness.note_error(PROBE_INVALID);
            Err(PROBE_INVALID)
        }
    }
}

pub(super) async fn finish(app: &AppHandle<Wry>, harness: &Harness) {
    if !harness.begin_finish() {
        return;
    }
    let initially_unsafe = harness.0.state.lock().unsafe_to_exit;
    let mut safe_to_exit = !initially_unsafe;
    if !harness.0.operations.wait_terminal(CLEANUP_WAIT).await {
        harness.note_error(NATIVE_OPERATION_TIMEOUT);
    }

    if harness.0.operations.is_terminal() {
        let hide_result = ensure_window_hidden(app, &harness.0.operations).await;
        if !hide_result {
            harness.note_error(FINAL_HIDE_FAILED);
            safe_to_exit = false;
        }
        if crate::window::macos_main_panel::is_active(app) && !initially_unsafe && hide_result {
            let restore = restore_panel(app, &harness.0.operations).await;
            match restore {
                Ok(facts) => {
                    let active = crate::window::macos_main_panel::is_active(app);
                    let mut state = harness.0.state.lock();
                    state.restoration = serde_json::to_value(facts).ok();
                    state.panel_active = Some(active);
                    if active {
                        state.unsafe_to_exit = true;
                    }
                }
                Err(_) => {
                    harness.note_error(RESTORE_FAILED);
                    safe_to_exit = false;
                }
            }
        } else {
            harness.0.state.lock().panel_active =
                Some(crate::window::macos_main_panel::is_active(app));
        }

        let observer_installed = harness.0.state.lock().observer_installed == Some(true);
        if observer_installed && !record_activation(app, harness, true).await {
            harness.note_error(OBSERVER_CLEANUP_FAILED);
            safe_to_exit = false;
        }
        if observer_installed {
            if super::super::settings_input_activation::uninstall(app)
                .await
                .is_err()
            {
                harness.note_error(OBSERVER_CLEANUP_FAILED);
            }
            let mut removed = false;
            for attempt in 0..2 {
                match super::super::settings_input_activation::sample(app).await {
                    Ok(sample) => {
                        let mut state = harness.0.state.lock();
                        record_observer_values(&mut state.activation, &sample);
                        removed = observer_cleanup_fact(&state.activation) == Some(true);
                        state.cleanup.observers_removed = Some(removed);
                    }
                    Err(_) => {
                        harness.note_error(OBSERVER_CLEANUP_FAILED);
                        harness.0.operations.mark_external_unconfirmed();
                        safe_to_exit = false;
                        break;
                    }
                }
                if removed {
                    break;
                }
                if attempt == 0 {
                    if super::super::settings_input_activation::uninstall(app)
                        .await
                        .is_err()
                    {
                        harness.note_error(OBSERVER_CLEANUP_FAILED);
                    }
                }
            }
            if !removed {
                harness.note_error(OBSERVER_CLEANUP_FAILED);
                harness.0.operations.mark_external_unconfirmed();
                safe_to_exit = false;
            } else {
                let mut state = harness.0.state.lock();
                state.cleanup.observers_removed = Some(true);
            }
        } else {
            harness.0.state.lock().cleanup.observers_removed = Some(false);
        }

        match operations::capture_window(app, &harness.0.operations).await {
            Ok(evidence) => {
                let hidden = evidence
                    .snapshot
                    .get("mainVisible")
                    .and_then(Value::as_bool)
                    == Some(false)
                    && evidence
                        .snapshot
                        .get("mainFocused")
                        .and_then(Value::as_bool)
                        == Some(false)
                    && evidence.snapshot.get("mainKey").and_then(Value::as_bool) == Some(false);
                let mut state = harness.0.state.lock();
                state.cleanup.window_hidden = Some(hidden);
                state.cleanup.panel_active = Some(crate::window::macos_main_panel::is_active(app));
                state.cleanup.observers_removed = observer_cleanup_fact(&state.activation);
                let invalid = !hidden || state.cleanup.panel_active != Some(false);
                if state.cleanup.panel_active != Some(false) {
                    state.unsafe_to_exit = true;
                }
                drop(state);
                if invalid {
                    harness.note_error(CLEANUP_STATE_INVALID);
                }
                if !hidden && crate::window::macos_main_panel::is_active(app) {
                    safe_to_exit = false;
                }
            }
            Err(_) => {
                harness.note_error(CLEANUP_STATE_INVALID);
                safe_to_exit = false;
            }
        }
    } else {
        safe_to_exit = false;
    }

    let operations_terminal = harness.0.operations.is_terminal();
    {
        let mut state = harness.0.state.lock();
        state.cleanup.native_operations_terminal = operations_terminal;
        if !operations_terminal {
            if !state.errors.contains(&NATIVE_OPERATION_TIMEOUT) {
                state.errors.push(NATIVE_OPERATION_TIMEOUT);
            }
            safe_to_exit = false;
        }
        if state.unsafe_to_exit {
            safe_to_exit = false;
        }
    }
    let report = report::report(harness);
    let passed = report.get("passed").and_then(Value::as_bool) == Some(true);
    let wrote = harness.0.profile.write_report(&report).is_ok();
    let code = if passed && wrote { 0 } else { 1 };
    if let Some(status) = app.try_state::<Arc<super::super::FixtureExitStatus>>() {
        status
            .code
            .store(code, std::sync::atomic::Ordering::Release);
    }
    if safe_to_exit {
        app.exit(code);
    }
}

async fn ensure_window_hidden(app: &AppHandle<Wry>, operations: &Arc<NativeOperations>) -> bool {
    let dispatch_app = app.clone();
    let action_app = dispatch_app.clone();
    operations
        .run(&dispatch_app, move || {
            let Ok(window) = crate::window::main_window(&action_app) else {
                return Err(FINAL_HIDE_FAILED);
            };
            match window.is_visible() {
                Ok(true) => {
                    crate::window::hide_main_window(&action_app).map_err(|_| FINAL_HIDE_FAILED)
                }
                Ok(false) => Ok(()),
                Err(_) => Err(FINAL_HIDE_FAILED),
            }
        })
        .await
        .is_ok()
}

async fn restore_panel(
    app: &AppHandle<Wry>,
    operations: &Arc<NativeOperations>,
) -> Result<crate::window::macos_main_panel::RestorationFacts, &'static str> {
    let dispatch_app = app.clone();
    let restore_app = dispatch_app.clone();
    operations
        .run(&dispatch_app, move || {
            crate::window::macos_main_panel::restore_scoped(&restore_app)
                .map_err(|_| RESTORE_FAILED)
        })
        .await
}

async fn record_activation(app: &AppHandle<Wry>, harness: &Harness, final_sample: bool) -> bool {
    match super::super::settings_input_activation::sample(app).await {
        Ok(value) => {
            let mut state = harness.0.state.lock();
            if final_sample {
                state.activation.final_app_activation_events =
                    value.get("appActivationEvents").and_then(Value::as_u64);
                state.activation.final_main_key_events =
                    value.get("mainKeyEvents").and_then(Value::as_u64);
                state.activation.app_activation_event_delta = state
                    .activation
                    .final_app_activation_events
                    .zip(state.activation.baseline_app_activation_events)
                    .and_then(|(current, baseline)| current.checked_sub(baseline));
                state.activation.main_key_event_delta = state
                    .activation
                    .final_main_key_events
                    .zip(state.activation.baseline_main_key_events)
                    .and_then(|(current, baseline)| current.checked_sub(baseline));
            }
            record_observer_values(&mut state.activation, &value);
            true
        }
        Err(_) => {
            harness.0.operations.mark_external_unconfirmed();
            false
        }
    }
}

fn record_observer_values(activation: &mut super::state::ActivationFacts, value: &Value) {
    activation.observer_registered = value.get("registered").and_then(Value::as_u64);
    activation.observer_removed = value.get("removed").and_then(Value::as_u64);
    activation.observer_installed = value.get("installed").and_then(Value::as_bool);
}

fn observer_cleanup_fact(activation: &super::state::ActivationFacts) -> Option<bool> {
    Some(
        activation.observer_registered? == 2
            && activation.observer_removed? == 2
            && !activation.observer_installed?,
    )
}

fn over_budget(started: Instant, harness: &Harness) -> bool {
    if started.elapsed() > TOTAL_BUDGET {
        harness.note_error(WATCHDOG_EXPIRED);
        true
    } else {
        false
    }
}
