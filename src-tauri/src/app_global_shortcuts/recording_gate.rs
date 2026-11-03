//! Bounded callback receipts and atomic recording/action admission. No OS/UI calls.
use crate::hotkey::recording::Target;
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};
pub(crate) const BUSY: &str = "SETTINGS_APP_SHORTCUT_RECORDING_BUSY";
pub(crate) const STALE: &str = "SETTINGS_APP_SHORTCUT_RECORDING_STALE";
pub(crate) const UNAVAILABLE: &str = "SETTINGS_APP_SHORTCUT_RECORDING_UNAVAILABLE";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ack {
    version: u8,
    session_id: String,
    generation: u64,
    token: Option<String>,
    active: bool,
    drained: bool,
}
#[derive(Clone)]
pub(crate) struct Notice {
    pub target: Target,
    pub value: serde_json::Value,
}
struct Slot {
    capture: Option<String>,
    live: bool,
    held: bool,
}
struct Recording {
    target: Target,
    generation: u64,
    token: String,
    active: bool,
    selected: Option<u64>,
    recorded: bool,
    draining: bool,
    reason: &'static str,
    deadline: Instant,
}
#[derive(Default)]
struct State {
    next: u64,
    epoch: u64,
    actions: usize,
    closed: bool,
    slots: BTreeMap<u64, Slot>,
    recording: Option<Recording>,
    session: String,
    high: u64,
    notices: VecDeque<Notice>,
}
#[derive(Default)]
pub(crate) struct Gate {
    state: Mutex<State>,
    pub wake: Notify,
}
pub(crate) struct Receipt {
    gate: Arc<Gate>,
    id: u64,
}
pub(crate) struct ActionPermit {
    gate: Arc<Gate>,
}
impl Drop for ActionPermit {
    fn drop(&mut self) {
        self.gate.state.lock().actions -= 1;
        self.gate.wake.notify_waiters();
    }
}
impl Drop for Receipt {
    fn drop(&mut self) {
        let mut s = self.gate.state.lock();
        s.slots.remove(&self.id); // Last callback owner dropped: handler really withdrawn.
        finish_drain(&mut s);
        self.gate.wake.notify_one();
    }
}
impl Receipt {
    /// Only call after this exact owned registration was confirmed withdrawn.
    /// Removing under the admission lock fences even already-upgraded queued Arcs.
    pub(crate) fn retire(&self) {
        let mut s = self.gate.state.lock();
        s.slots.remove(&self.id);
        finish_drain(&mut s);
        self.gate.wake.notify_one();
    }

    /// Queued tasks carry Weak<Receipt>, so only the real callback retains ownership.
    pub(crate) fn admit(&self, epoch: u64) -> Option<ActionPermit> {
        let mut s = self.gate.state.lock();
        if paused(&s)
            || s.epoch != epoch
            || s.actions >= 197
            || !s.slots.get(&self.id).is_some_and(|slot| slot.live)
        {
            return None;
        }
        s.actions += 1;
        Some(ActionPermit {
            gate: self.gate.clone(),
        })
    }
    pub(crate) fn publish(&self) {
        if let Some(v) = self.gate.state.lock().slots.get_mut(&self.id) {
            v.live = true;
        }
    }
    pub(crate) fn edge(&self, pressed: bool) -> Option<u64> {
        let mut s = self.gate.state.lock();
        let paused = paused(&s);
        let capture = {
            let slot = s.slots.get_mut(&self.id)?;
            let live = slot.live;
            if pressed {
                if slot.held {
                    return None;
                }
                slot.held = true;
            } else {
                slot.held = false;
            }
            if !live {
                return None;
            }
            slot.capture.clone()
        };
        if paused {
            if let Some(r) = s.recording.as_mut() {
                if r.active && pressed && capture.is_some() && r.selected.is_none() {
                    r.selected = Some(self.id);
                }
                if !pressed && r.active && !r.recorded && r.selected == Some(self.id) {
                    if let Some(shortcut) = capture {
                        r.recorded = true;
                        let n = Notice {
                            target: r.target.clone(),
                            value: serde_json::json!({"version":1,"sessionId":r.target.session_id,"generation":r.generation,"token":r.token,"status":"recorded","shortcut":shortcut}),
                        };
                        s.notices.push_back(n);
                    }
                }
            }
            finish_drain(&mut s);
            self.gate.wake.notify_one();
            None
        } else if pressed && !s.closed {
            Some(s.epoch)
        } else {
            None
        }
    }
}
fn paused(s: &State) -> bool {
    s.closed || s.recording.as_ref().is_some_and(|r| r.active || r.draining)
}
fn stopped(s: &mut State, drained: bool) {
    if let Some(r) = s.recording.as_ref() {
        if s.notices.len() < 3 {
            s.notices.push_back(Notice { target:r.target.clone(), value:serde_json::json!({"version":1,"sessionId":r.target.session_id,"generation":r.generation,"token":r.token,"status":"stopped","reason":r.reason,"drained":drained}) });
        }
    }
}
fn finish_drain(s: &mut State) {
    if s.recording.as_ref().is_some_and(|r| r.draining) && !s.slots.values().any(|v| v.held) {
        s.recording.as_mut().unwrap().draining = false;
        stopped(s, true);
    }
}
impl Gate {
    pub(crate) fn receipt(
        self: &Arc<Self>,
        capture: Option<String>,
    ) -> Result<Arc<Receipt>, String> {
        let mut s = self.state.lock();
        if capture
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 256)
        {
            return Err(UNAVAILABLE.into());
        }
        if paused(&s) {
            return Err(BUSY.into());
        }
        let count = s
            .slots
            .values()
            .filter(|v| v.capture.is_some() == capture.is_some())
            .count();
        if count >= if capture.is_some() { 65 } else { 132 } {
            return Err(UNAVAILABLE.into());
        }
        s.next = s.next.checked_add(1).ok_or(UNAVAILABLE)?;
        let id = s.next;
        s.slots.insert(
            id,
            Slot {
                capture,
                live: false,
                held: false,
            },
        );
        Ok(Arc::new(Receipt {
            gate: self.clone(),
            id,
        }))
    }
    pub(crate) fn closed(&self) -> bool {
        self.state.lock().closed
    }
    pub(crate) fn epoch(&self) -> u64 {
        self.state.lock().epoch
    }
    pub(crate) fn busy(&self) -> bool {
        paused(&self.state.lock())
    }
    pub(crate) fn admit(self: &Arc<Self>, epoch: u64) -> Option<ActionPermit> {
        let mut s = self.state.lock();
        if paused(&s) || s.epoch != epoch || s.actions >= 197 {
            return None;
        }
        s.actions += 1;
        Some(ActionPermit { gate: self.clone() })
    }
    pub(crate) fn start(&self, target: Target, generation: u64) -> Result<Ack, String> {
        crate::hotkey::recording::valid_generation(generation).map_err(|_| STALE)?;
        let mut s = self.state.lock();
        if s.session == target.session_id && generation <= s.high {
            if s.recording
                .as_ref()
                .is_some_and(|r| r.active && r.generation == generation && r.target == target)
            {
                return Ok(ack(&s, &target.session_id, generation));
            }
            return Err(STALE.into());
        }
        if paused(&s) || s.actions != 0 || s.slots.values().any(|v| v.held || !v.live) {
            return Err(BUSY.into());
        }
        s.epoch = s.epoch.checked_add(1).ok_or(UNAVAILABLE)?;
        s.session = target.session_id.clone();
        s.high = generation;
        s.notices.clear();
        s.recording = Some(Recording {
            target: target.clone(),
            generation,
            token: uuid::Uuid::new_v4().simple().to_string(),
            active: true,
            selected: None,
            recorded: false,
            draining: false,
            reason: "cancelled",
            deadline: Instant::now() + Duration::from_secs(30),
        });
        self.wake.notify_one();
        Ok(ack(&s, &target.session_id, generation))
    }
    pub(crate) fn stop(&self, session: &str, generation: u64) -> Result<Ack, String> {
        crate::hotkey::recording::valid_generation(generation).map_err(|_| STALE)?;
        let mut s = self.state.lock();
        if s.session != session {
            if paused(&s) {
                return Err(STALE.into());
            }
            s.session = session.into();
            s.high = 0;
            s.recording = None;
        }
        if generation < s.high {
            return Err(STALE.into());
        }
        if s.recording
            .as_ref()
            .is_some_and(|r| r.generation != generation && (r.active || r.draining))
        {
            return Err(STALE.into());
        }
        s.high = generation;
        if s.recording
            .as_ref()
            .is_some_and(|r| r.generation == generation && r.active)
        {
            cancel(&mut s, "cancelled");
        }
        self.wake.notify_one();
        Ok(ack(&s, session, generation))
    }
    pub(crate) fn cancel(&self, session: Option<&str>, reason: &'static str) {
        let mut s = self.state.lock();
        if s.recording
            .as_ref()
            .is_some_and(|r| session.is_none_or(|id| id == r.target.session_id) && r.active)
        {
            cancel(&mut s, reason);
        }
        self.wake.notify_one();
    }
    pub(crate) fn close(&self) {
        let mut s = self.state.lock();
        s.closed = true;
        cancel(&mut s, "cancelled");
        self.wake.notify_waiters();
    }
    pub(crate) async fn wait_actions(&self) {
        loop {
            let wake = self.wake.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            if self.state.lock().actions == 0 {
                return;
            }
            wake.await;
        }
    }
    pub(crate) fn notice_current(&self, notice: &Notice) -> bool {
        self.state.lock().recording.as_ref().is_some_and(|r| {
            r.target == notice.target
                && notice.value["token"] == r.token
                && notice.value["generation"] == r.generation
                && (notice.value["status"] != "recorded" || r.active)
        })
    }
    pub(crate) fn tick(&self) -> (Option<Instant>, Vec<Notice>) {
        let mut s = self.state.lock();
        if s.recording
            .as_ref()
            .is_some_and(|r| r.active && r.deadline <= Instant::now())
        {
            cancel(&mut s, "timeout");
        }
        let deadline = s
            .recording
            .as_ref()
            .filter(|r| r.active)
            .map(|r| r.deadline);
        (deadline, s.notices.drain(..).collect())
    }
}
fn cancel(s: &mut State, reason: &'static str) {
    if let Some(r) = s.recording.as_mut() {
        if !r.active {
            return;
        }
        r.active = false;
        r.reason = reason;
        r.draining = true;
    } else {
        return;
    }
    let drained = !s.slots.values().any(|v| v.held);
    stopped(s, drained);
    if drained {
        s.recording.as_mut().unwrap().draining = false;
    }
}
fn ack(s: &State, session: &str, generation: u64) -> Ack {
    let r = s
        .recording
        .as_ref()
        .filter(|r| r.target.session_id == session && r.generation == generation);
    Ack {
        version: 1,
        session_id: session.into(),
        generation,
        token: r.map(|r| r.token.clone()),
        active: r.is_some_and(|r| r.active),
        drained: !r.is_some_and(|r| r.active || r.draining),
    }
}
#[cfg(test)]
#[path = "recording_gate_tests.rs"]
mod tests;
