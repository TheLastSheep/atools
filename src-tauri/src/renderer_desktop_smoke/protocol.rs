use super::super::{
    observations::{self, EventLedger, NativeObservation, Stage, StageObservation},
    profile::Profile,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, Notify};

#[path = "report.rs"]
mod report;

#[path = "protocol_validation.rs"]
mod validation;

#[path = "protocol_ipc.rs"]
mod ipc;

pub(in crate::renderer_desktop_smoke) use ipc::{
    handler, handles, is_local_root_url, on_page_load, record_window_event,
};

struct PendingCapture {
    stage: Stage,
    sender: oneshot::Sender<Result<(), &'static str>>,
}

struct ProtocolState {
    probe_injected: bool,
    readiness: Option<Result<Value, &'static str>>,
    incognito_observed: bool,
    incognito_persistent: Option<bool>,
    next_stage: usize,
    pending_capture: Option<PendingCapture>,
    stage_observations: Vec<StageObservation>,
    pre_dispose_counters: Option<Value>,
    fatal_error: Option<&'static str>,
    events: EventLedger,
}

impl Default for ProtocolState {
    fn default() -> Self {
        Self {
            probe_injected: false,
            readiness: None,
            incognito_observed: false,
            incognito_persistent: None,
            next_stage: 0,
            pending_capture: None,
            stage_observations: Vec::new(),
            pre_dispose_counters: None,
            fatal_error: None,
            events: EventLedger::default(),
        }
    }
}

struct HarnessInner {
    profile: Arc<Profile>,
    token: String,
    started: Instant,
    state: Mutex<ProtocolState>,
    readiness_changed: Notify,
    incognito_changed: Notify,
    finished: AtomicBool,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness(Arc<HarnessInner>);

impl Harness {
    pub(in crate::renderer_desktop_smoke) fn new(profile: Arc<Profile>) -> Self {
        let started = Instant::now();
        Self(Arc::new(HarnessInner {
            profile,
            token: uuid::Uuid::new_v4().simple().to_string(),
            started,
            state: Mutex::new(ProtocolState {
                events: {
                    let mut events = EventLedger::default();
                    events.start(started);
                    events
                },
                ..ProtocolState::default()
            }),
            readiness_changed: Notify::new(),
            incognito_changed: Notify::new(),
            finished: AtomicBool::new(false),
        }))
    }

    pub(in crate::renderer_desktop_smoke) fn auto_clear(&self) -> &str {
        &self.0.profile.auto_clear
    }

    pub(super) fn identifier(&self) -> &str {
        &self.0.profile.identifier
    }

    pub(super) fn profile(&self) -> &Profile {
        &self.0.profile
    }

    pub(super) fn mark_probe_injected(&self) -> bool {
        let mut state = self.0.state.lock();
        if state.probe_injected {
            return false;
        }
        state.probe_injected = true;
        true
    }

    pub(in crate::renderer_desktop_smoke) fn record_incognito(&self, persistent: Option<bool>) {
        let mut state = self.0.state.lock();
        if state.incognito_observed {
            return;
        }
        state.incognito_observed = true;
        state.incognito_persistent = persistent;
        drop(state);
        self.0.incognito_changed.notify_one();
    }

    pub(super) async fn wait_incognito(&self, timeout: Duration) -> Option<bool> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(value) = {
                let state = self.0.state.lock();
                state
                    .incognito_observed
                    .then_some(state.incognito_persistent)
            } {
                return value;
            }
            let changed = self.0.incognito_changed.notified();
            if let Some(value) = {
                let state = self.0.state.lock();
                state
                    .incognito_observed
                    .then_some(state.incognito_persistent)
            } {
                return value;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return None;
            }
        }
    }

    pub(super) async fn wait_ready(&self, timeout: Duration) -> Result<Value, &'static str> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(result) = self.0.state.lock().readiness.clone() {
                return result;
            }
            let changed = self.0.readiness_changed.notified();
            if let Some(result) = self.0.state.lock().readiness.clone() {
                return result;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return Err("renderer-readiness-timeout");
            }
        }
    }

    pub(super) fn accept_readiness(
        &self,
        token: &str,
        evidence: Value,
    ) -> Result<(), &'static str> {
        if token.len() != 32 || token != self.0.token {
            return Err("renderer-probe-token-rejected");
        }
        if !self.0.state.lock().probe_injected {
            return Err("renderer-probe-not-installed");
        }
        let errors = validation::readiness_errors(&evidence);
        let result = if errors.is_empty() {
            Ok(evidence.clone())
        } else {
            Err(errors[0])
        };
        let mut state = self.0.state.lock();
        if state.readiness.is_some() {
            return Err("duplicate-renderer-readiness-message");
        }
        if let Err(error) = &result {
            state.fatal_error.get_or_insert(*error);
        }
        state.readiness = Some(result.clone());
        drop(state);
        self.0.readiness_changed.notify_one();
        result.map(|_| ())
    }

    pub(super) fn token_matches(&self, token: &str) -> bool {
        token.len() == 32 && token == self.0.token
    }

    pub(super) fn begin_capture(
        &self,
        stage: Stage,
    ) -> Result<oneshot::Receiver<Result<(), &'static str>>, &'static str> {
        let mut state = self.0.state.lock();
        if state.pending_capture.is_some() {
            return Err("renderer-stage-capture-already-pending");
        }
        if Stage::ALL.get(state.next_stage).copied() != Some(stage) {
            return Err("renderer-stage-order-rejected");
        }
        let (sender, receiver) = oneshot::channel();
        state.pending_capture = Some(PendingCapture { stage, sender });
        Ok(receiver)
    }

    pub(super) fn cancel_capture(&self, stage: Stage) {
        let mut state = self.0.state.lock();
        if state
            .pending_capture
            .as_ref()
            .is_some_and(|pending| pending.stage == stage)
        {
            state.pending_capture = None;
        }
    }

    pub(super) fn reject_capture(&self, stage: Stage, error: &'static str) {
        let pending = {
            let mut state = self.0.state.lock();
            let Some(pending) = state.pending_capture.take() else {
                return;
            };
            if pending.stage != stage {
                state.pending_capture = Some(pending);
                return;
            }
            pending
        };
        let _ = pending.sender.send(Err(error));
    }

    pub(super) fn accept_observation(
        &self,
        stage: Stage,
        dom: Value,
        native: NativeObservation,
    ) -> Result<(), &'static str> {
        if serde_json::to_vec(&dom).map_or(true, |value| {
            value.len() > validation::MAX_DOM_SNAPSHOT_BYTES
        }) {
            self.reject_capture(stage, "renderer-dom-observation-exceeds-limit");
            return Err("renderer-dom-observation-exceeds-limit");
        }
        if let Some(error) = validation::observation_errors(stage, &dom).first().copied() {
            self.reject_capture(stage, error);
            return Err(error);
        }
        if dom.get("stage").and_then(Value::as_str) != Some(stage.as_str()) {
            self.reject_capture(stage, "renderer-stage-snapshot-mismatch");
            return Err("renderer-stage-snapshot-mismatch");
        }
        let value = dom
            .get("inputValue")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if value.len() > 64 {
            self.reject_capture(stage, "renderer-input-observation-exceeds-limit");
            return Err("renderer-input-observation-exceeds-limit");
        }

        let pending = {
            let mut state = self.0.state.lock();
            let Some(pending) = state.pending_capture.take() else {
                return Err("unsolicited-renderer-stage-observation");
            };
            if pending.stage != stage || Stage::ALL.get(state.next_stage).copied() != Some(stage) {
                state.pending_capture = Some(pending);
                return Err("renderer-stage-order-rejected");
            }
            let pre_dispose_counters = state.pre_dispose_counters.clone();
            let errors = observations::verify_stage(
                stage,
                &self.0.profile.auto_clear,
                &self.0.profile.identifier,
                &dom,
                &native,
                pre_dispose_counters.as_ref(),
            );
            if stage == Stage::Disposed {
                state.pre_dispose_counters = dom.get("preDisposeCounters").cloned();
            }
            state.stage_observations.push(StageObservation {
                stage: stage.as_str(),
                elapsed_ms: self.0.started.elapsed().as_secs_f64() * 1000.0,
                dom,
                native,
                errors,
            });
            state.next_stage += 1;
            pending
        };
        let _ = pending.sender.send(Ok(()));
        Ok(())
    }

    pub(super) fn note_error(&self, error: &'static str) {
        let mut state = self.0.state.lock();
        state.fatal_error.get_or_insert(error);
    }

    pub(super) fn record_window_event(&self, label: &'static str, event: &'static str) {
        self.0.state.lock().events.record(label, event);
    }

    pub(super) fn event_count(&self, label: &'static str, event: &'static str) -> u32 {
        self.0.state.lock().events.count(label, event)
    }

    pub(super) fn begin_finish(&self) -> bool {
        !self.0.finished.swap(true, Ordering::AcqRel)
    }
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
