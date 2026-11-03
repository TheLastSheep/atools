use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Wry};
use tokio::time::timeout;

use super::native;

const TRACE_SCHEMA_VERSION: u8 = 1;
// The serialized value saturates here; 256 means at least 256 actual samples.
const MAX_VISIBILITY_SAMPLES: u16 = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct NativePresentationObservation {
    pub(super) visible: Option<bool>,
    pub(super) occlusion_visible: Option<bool>,
    pub(super) on_active_space: Option<bool>,
    pub(super) window_focused: Option<bool>,
    pub(super) window_key: Option<bool>,
    pub(super) app_active: Option<bool>,
    pub(super) app_hidden: Option<bool>,
    pub(super) frontmost_is_self: Option<bool>,
}

impl NativePresentationObservation {
    pub(super) fn as_json(self) -> Value {
        json!({
            "visible": self.visible,
            "occlusionVisible": self.occlusion_visible,
            "onActiveSpace": self.on_active_space,
            "windowFocused": self.window_focused,
            "windowKey": self.window_key,
            "appActive": self.app_active,
            "appHidden": self.app_hidden,
            "frontmostIsSelf": self.frontmost_is_self,
        })
    }

    fn presentation(self) -> Value {
        json!({
            "visible": self.visible,
            "windowFocused": self.window_focused,
            "windowKey": self.window_key,
            "appActive": self.app_active,
            "frontmostIsSelf": self.frontmost_is_self,
        })
    }

    fn cleanup(self) -> Value {
        json!({
            "hideConfirmed": self.visible == Some(false),
            "visible": self.visible,
            "windowFocused": self.window_focused,
            "windowKey": self.window_key,
            "appActive": self.app_active,
            "frontmostIsSelf": self.frontmost_is_self,
        })
    }

    pub(super) fn after_order_front_unfocused(self) -> bool {
        self.visible == Some(true)
            && self.window_focused == Some(false)
            && self.window_key == Some(false)
            && self.app_active == Some(false)
            && self.app_hidden == Some(false)
            && self.frontmost_is_self == Some(false)
    }

    pub(super) fn focus_changed(self) -> bool {
        self.window_focused == Some(true)
            || self.window_key == Some(true)
            || self.app_active == Some(true)
            || self.frontmost_is_self == Some(true)
    }
}

#[derive(Clone, Debug, Default)]
struct TraceState {
    baseline: Option<NativePresentationObservation>,
    after_order_front: Option<NativePresentationObservation>,
    last_visibility: Option<NativePresentationObservation>,
    after_hide: Option<NativePresentationObservation>,
    visibility_samples: u16,
}

#[derive(Clone, Default)]
pub(in super::super) struct WindowTrace(Arc<Mutex<TraceState>>);

impl WindowTrace {
    pub(in super::super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn baseline(&self, observation: NativePresentationObservation) {
        self.0.lock().baseline = Some(observation);
    }

    pub(super) fn after_order_front(&self, observation: NativePresentationObservation) {
        self.0.lock().after_order_front = Some(observation);
    }

    pub(super) fn visibility(&self, observation: NativePresentationObservation) {
        let mut state = self.0.lock();
        state.visibility_samples = state
            .visibility_samples
            .saturating_add(1)
            .min(MAX_VISIBILITY_SAMPLES);
        state.last_visibility = Some(observation);
    }

    pub(super) fn after_hide(&self, observation: NativePresentationObservation) {
        self.0.lock().after_hide = Some(observation);
    }

    pub(in super::super) fn snapshot(&self) -> Value {
        let state = self.0.lock();
        json!({
            "schemaVersion": TRACE_SCHEMA_VERSION,
            "baseline": observation_value(state.baseline),
            "afterOrderFront": observation_value(state.after_order_front),
            "lastVisibility": observation_value(state.last_visibility),
            "afterHide": observation_value(state.after_hide),
            "visibilitySamples": state.visibility_samples,
        })
    }
}

fn observation_value(value: Option<NativePresentationObservation>) -> Value {
    value.map_or(Value::Null, NativePresentationObservation::as_json)
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct WindowFacts {
    pub(super) observation: NativePresentationObservation,
    pub(super) focus_gained_events: u64,
    pub(super) app_activation_events: Option<u64>,
    pub(super) main_key_events: Option<u64>,
    pub(super) observer_state_valid: bool,
}

impl WindowFacts {
    pub(super) fn presentation(self) -> Value {
        self.observation.presentation()
    }

    pub(super) fn cleanup(self) -> Value {
        self.observation.cleanup()
    }

    pub(super) fn after_order_front_unfocused(self) -> bool {
        self.observation.after_order_front_unfocused()
    }

    pub(super) fn initially_hidden_unfocused(self) -> bool {
        self.observation.visible == Some(false)
            && self.unfocused()
            && self.focus_gained_events == 0
            && self.app_activation_events == Some(0)
            && self.main_key_events == Some(0)
            && self.observer_state_valid
    }

    pub(super) fn visible_unfocused_since(self, baseline: Self) -> bool {
        self.observation.visible == Some(true)
            && self.observation.occlusion_visible == Some(true)
            && self.observation.on_active_space == Some(true)
            && self.unfocused()
            && self.observation.app_hidden == Some(false)
            && self.same_observer_counts(baseline)
    }

    pub(super) fn focus_changed_since(self, baseline: Self) -> bool {
        self.observation.focus_changed()
            || self.focus_gained_events > baseline.focus_gained_events
            || Self::count_increased(self.app_activation_events, baseline.app_activation_events)
            || Self::count_increased(self.main_key_events, baseline.main_key_events)
    }

    pub(super) fn cleanup_confirmed(self) -> bool {
        self.observation.visible == Some(false)
            && self.observation.window_focused == Some(false)
            && self.observation.window_key == Some(false)
            && self.observation.app_active == Some(false)
            && self.observation.frontmost_is_self == Some(false)
    }

    fn unfocused(self) -> bool {
        self.observation.window_focused == Some(false)
            && self.observation.window_key == Some(false)
            && self.observation.app_active == Some(false)
            && self.observation.frontmost_is_self == Some(false)
    }

    fn same_observer_counts(self, other: Self) -> bool {
        self.observer_state_valid
            && other.observer_state_valid
            && self.focus_gained_events == other.focus_gained_events
            && self.app_activation_events.is_some()
            && self.app_activation_events == other.app_activation_events
            && self.main_key_events.is_some()
            && self.main_key_events == other.main_key_events
    }

    fn count_increased(current: Option<u64>, baseline: Option<u64>) -> bool {
        current
            .zip(baseline)
            .is_some_and(|(current, baseline)| current > baseline)
    }
}

pub(super) async fn capture_native(
    app: &AppHandle<Wry>,
    run_id: &str,
) -> Result<NativePresentationObservation, &'static str> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    let task_run_id = run_id.to_owned();
    use tauri::Manager;

    app.run_on_main_thread(move || {
        if !sender.is_closed() {
            let _ = sender.send(native::inspect(&task_app, &task_run_id));
        }
    })
    .map_err(|_| super::PRESENTATION_FAILED)?;
    timeout(Duration::from_secs(2), receiver)
        .await
        .map_err(|_| super::PRESENTATION_FAILED)?
        .map_err(|_| super::PRESENTATION_FAILED)
}

pub(super) async fn complete_activation_observation(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    observation: NativePresentationObservation,
) -> Result<WindowFacts, &'static str> {
    let activation = timeout(
        Duration::from_secs(2),
        crate::renderer_desktop_smoke::settings_input_activation::sample(app),
    )
    .await
    .map_err(|_| super::PRESENTATION_FAILED)?
    .map_err(|_| super::PRESENTATION_FAILED)?;
    let app_active = activation["appActive"].as_bool();
    let frontmost_is_self = activation["frontmostIsSelf"].as_bool();
    let app_activation_events = activation["appActivationEvents"].as_u64();
    let main_key_events = activation["mainKeyEvents"].as_u64();
    let observer_state_valid = activation["known"].as_bool() == Some(true)
        && activation["installed"].as_bool() == Some(true)
        && activation["registered"].as_u64() == Some(2)
        && activation["removed"].as_u64() == Some(0)
        && app_active == observation.app_active
        && frontmost_is_self == observation.frontmost_is_self
        && app_activation_events.is_some()
        && main_key_events.is_some();
    if !observer_state_valid {
        return Err(super::PRESENTATION_FAILED);
    }

    Ok(WindowFacts {
        observation,
        focus_gained_events: harness.focus_gained_events(),
        app_activation_events,
        main_key_events,
        observer_state_valid,
    })
}

pub(super) async fn observe_visibility(
    app: &AppHandle<Wry>,
    harness: &super::super::state::Harness,
    run_id: &str,
    trace: &WindowTrace,
) -> Result<WindowFacts, &'static str> {
    let observation = record_visibility_capture(trace, capture_native(app, run_id).await)?;
    complete_activation_observation(app, harness, observation).await
}

fn record_visibility_capture(
    trace: &WindowTrace,
    captured: Result<NativePresentationObservation, &'static str>,
) -> Result<NativePresentationObservation, &'static str> {
    let observation = captured?;
    trace.visibility(observation);
    Ok(observation)
}

#[cfg(test)]
#[path = "presented_paint_window_trace_tests.rs"]
mod tests;
