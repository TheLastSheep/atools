use super::operations::NativeOperations;
use crate::renderer_desktop_smoke::profile::Profile;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::{sync::Arc, time::Instant};
use tokio::sync::{oneshot, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Baseline,
    Shown,
    Hidden,
    Reshown,
}

impl Stage {
    pub(super) const ALL: [Self; 4] = [Self::Baseline, Self::Shown, Self::Hidden, Self::Reshown];

    pub(super) fn index(self) -> usize {
        match self {
            Self::Baseline => 0,
            Self::Shown => 1,
            Self::Hidden => 2,
            Self::Reshown => 3,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Shown => "shown",
            Self::Hidden => "hidden",
            Self::Reshown => "reshown",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|stage| stage.as_str() == value)
    }
}

#[derive(Clone, Debug)]
pub(super) struct DomFacts {
    pub(super) stage: &'static str,
    pub(super) document_visible: bool,
    pub(super) document_has_focus: bool,
    pub(super) input_found: bool,
    pub(super) input_focused: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StageFacts {
    pub(super) foreground: Value,
    pub(super) frontmost_matches_baseline: Option<bool>,
    pub(super) input_found: Option<bool>,
    pub(super) input_focused: Option<bool>,
    pub(super) content_view_stable: Option<bool>,
    pub(super) document_visible: bool,
    pub(super) document_has_focus: bool,
    pub(super) app_activation_events: Option<u64>,
    pub(super) app_activation_event_delta: Option<u64>,
    pub(super) main_key_events: Option<u64>,
    pub(super) main_key_event_delta: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActivationFacts {
    pub(super) baseline_app_activation_events: Option<u64>,
    pub(super) final_app_activation_events: Option<u64>,
    pub(super) app_activation_event_delta: Option<u64>,
    pub(super) baseline_main_key_events: Option<u64>,
    pub(super) final_main_key_events: Option<u64>,
    pub(super) main_key_event_delta: Option<u64>,
    pub(super) observer_registered: Option<u64>,
    pub(super) observer_removed: Option<u64>,
    pub(super) observer_installed: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CleanupFacts {
    pub(super) window_hidden: Option<bool>,
    pub(super) panel_active: Option<bool>,
    pub(super) native_operations_terminal: bool,
    pub(super) observers_removed: Option<bool>,
}

pub(super) struct RunState {
    pub(super) probe_injected: bool,
    pub(super) ready: Option<DomFacts>,
    pub(super) next_probe_id: u64,
    pub(super) pending_probe: Option<PendingProbe>,
    pub(super) stages: [Option<StageFacts>; 4],
    pub(super) conversion: Option<Value>,
    pub(super) restoration: Option<Value>,
    pub(super) panel_active: Option<bool>,
    pub(super) observer_installed: Option<bool>,
    pub(super) initialization_failed: bool,
    pub(super) unsafe_to_exit: bool,
    pub(super) baseline_app_active: Option<bool>,
    pub(super) activation: ActivationFacts,
    pub(super) cleanup: CleanupFacts,
    pub(super) errors: Vec<&'static str>,
}

impl Default for RunState {
    fn default() -> Self {
        Self {
            probe_injected: false,
            ready: None,
            next_probe_id: 1,
            pending_probe: None,
            stages: std::array::from_fn(|_| None),
            conversion: None,
            restoration: None,
            panel_active: None,
            observer_installed: None,
            initialization_failed: false,
            unsafe_to_exit: false,
            baseline_app_active: None,
            activation: ActivationFacts::default(),
            cleanup: CleanupFacts::default(),
            errors: Vec::new(),
        }
    }
}

pub(super) struct PendingProbe {
    pub(super) id: u64,
    pub(super) stage: Stage,
    pub(super) claimed: bool,
    pub(super) sender: oneshot::Sender<Result<StageFacts, &'static str>>,
}

pub(super) struct Inner {
    pub(super) profile: Arc<Profile>,
    pub(super) token: String,
    pub(super) started: Instant,
    pub(super) state: Mutex<RunState>,
    pub(super) baseline_frontmost_pid: Mutex<Option<i32>>,
    pub(super) changed: Notify,
    pub(super) start_claimed: std::sync::atomic::AtomicBool,
    pub(super) finished: std::sync::atomic::AtomicBool,
    pub(super) operations: Arc<NativeOperations>,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness(pub(super) Arc<Inner>);

impl Harness {
    pub(super) fn new(profile: Arc<Profile>) -> Self {
        Self(Arc::new(Inner {
            profile,
            token: uuid::Uuid::new_v4().simple().to_string(),
            started: Instant::now(),
            state: Mutex::new(RunState::default()),
            baseline_frontmost_pid: Mutex::new(None),
            changed: Notify::new(),
            start_claimed: std::sync::atomic::AtomicBool::new(false),
            finished: std::sync::atomic::AtomicBool::new(false),
            operations: Arc::new(NativeOperations::default()),
        }))
    }

    pub(super) fn note_error(&self, error: &'static str) {
        let mut state = self.0.state.lock();
        if !state.errors.contains(&error) {
            state.errors.push(error);
        }
    }

    pub(super) fn mark_probe_injected(&self) -> bool {
        let mut state = self.0.state.lock();
        if state.probe_injected {
            return false;
        }
        state.probe_injected = true;
        true
    }

    pub(super) async fn wait_ready(&self, timeout: std::time::Duration) -> Option<DomFacts> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(ready) = self.0.state.lock().ready.clone() {
                return Some(ready);
            }
            let changed = self.0.changed.notified();
            if let Some(ready) = self.0.state.lock().ready.clone() {
                return Some(ready);
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return None;
            }
        }
    }

    pub(super) fn accept_ready(&self, token: &str, probe_id: u64, facts: DomFacts) -> bool {
        if token != self.0.token || probe_id != 0 || facts.stage != "ready" {
            return false;
        }
        let mut state = self.0.state.lock();
        if !state.probe_injected || state.ready.is_some() {
            return false;
        }
        state.ready = Some(facts);
        drop(state);
        self.0.changed.notify_one();
        true
    }

    pub(super) fn begin_stage(
        &self,
        stage: Stage,
    ) -> Result<(u64, oneshot::Receiver<Result<StageFacts, &'static str>>), &'static str> {
        let mut state = self.0.state.lock();
        let expected = Stage::ALL
            .into_iter()
            .find(|candidate| state.stages[candidate.index()].is_none());
        if expected != Some(stage) || state.pending_probe.is_some() {
            return Err("main-panel-prototype-probe-order-invalid");
        }
        let id = state.next_probe_id;
        state.next_probe_id = state
            .next_probe_id
            .checked_add(1)
            .ok_or("main-panel-prototype-probe-id-exhausted")?;
        let (sender, receiver) = oneshot::channel();
        state.pending_probe = Some(PendingProbe {
            id,
            stage,
            claimed: false,
            sender,
        });
        Ok((id, receiver))
    }

    pub(super) fn claim_stage(&self, id: u64, stage: Stage) -> bool {
        let mut state = self.0.state.lock();
        let Some(pending) = state.pending_probe.as_mut() else {
            return false;
        };
        if pending.id != id || pending.stage != stage || pending.claimed {
            return false;
        }
        pending.claimed = true;
        true
    }

    pub(super) fn complete_stage(&self, id: u64, stage: Stage, mut facts: StageFacts) -> bool {
        let pending = {
            let mut state = self.0.state.lock();
            let Some(pending) = state.pending_probe.take() else {
                return false;
            };
            if pending.id != id || pending.stage != stage || !pending.claimed {
                state.pending_probe = Some(pending);
                return false;
            }
            if stage == Stage::Baseline {
                state.baseline_app_active =
                    facts.foreground.get("appActive").and_then(Value::as_bool);
                state.activation.baseline_app_activation_events = facts.app_activation_events;
                state.activation.baseline_main_key_events = facts.main_key_events;
            }
            facts.app_activation_event_delta = facts
                .app_activation_events
                .zip(state.activation.baseline_app_activation_events)
                .and_then(|(current, baseline)| current.checked_sub(baseline));
            facts.main_key_event_delta = facts
                .main_key_events
                .zip(state.activation.baseline_main_key_events)
                .and_then(|(current, baseline)| current.checked_sub(baseline));
            if stage == Stage::Baseline {
                facts.app_activation_event_delta = Some(0);
                facts.main_key_event_delta = Some(0);
            }
            state.stages[stage.index()] = Some(facts.clone());
            pending
        };
        let _ = pending.sender.send(Ok(facts));
        true
    }

    pub(super) fn cancel_stage(&self, id: u64) {
        let mut state = self.0.state.lock();
        if state
            .pending_probe
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            state.pending_probe = None;
        }
    }

    pub(super) fn set_frontmost_baseline(&self, pid: Option<i32>) {
        *self.0.baseline_frontmost_pid.lock() = pid;
    }

    pub(super) fn frontmost_matches_baseline(&self, current: Option<i32>) -> Option<bool> {
        let baseline = *self.0.baseline_frontmost_pid.lock();
        let baseline = baseline?;
        let current = current?;
        Some(current == baseline)
    }

    pub(super) fn fail_stage(&self, id: u64, error: &'static str) {
        let pending = {
            let mut state = self.0.state.lock();
            let Some(pending) = state.pending_probe.take() else {
                return;
            };
            if pending.id != id {
                state.pending_probe = Some(pending);
                return;
            }
            pending
        };
        let _ = pending.sender.send(Err(error));
    }

    pub(super) fn begin_finish(&self) -> bool {
        !self
            .0
            .finished
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    }

    pub(super) fn begin_start(&self) -> bool {
        !self
            .0
            .start_claimed
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    }
}
