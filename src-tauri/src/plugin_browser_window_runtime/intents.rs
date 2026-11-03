use crate::{plugin_asset_protocol::Owner, plugin_browser_window_native::WindowSpec};
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::sync::watch;

pub(super) use super::identity::{is_private_id, private_id, validate_window_id};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Operation {
    Open,
    Action,
}

pub(super) enum Payload {
    Open { spec: Option<WindowSpec> },
    Action { action: String, args: Vec<Value> },
}

impl Payload {
    pub fn operation(&self) -> Operation {
        match self {
            Self::Open { .. } => Operation::Open,
            Self::Action { .. } => Operation::Action,
        }
    }
}

pub(super) struct Intent {
    pub id: String,
    pub owner: Owner,
    pub source_binding_id: String,
    pub window_id: String,
    pub operation: Operation,
    pub parent_was_visible: bool,
    pub permission_prompt_shown: AtomicBool,
    /// Host-local timestamps used only to bind a native drag request to one
    /// recent DOM gesture. Neither value is part of the durable TaskRun.
    pub prepared_at: Instant,
    pub prepared_at_epoch_ms: u64,
    pub payload: Mutex<Option<Payload>>,
    pub run_id: Mutex<Option<String>>,
    pub result: Mutex<Option<Result<Value, String>>>,
    pub state: AtomicU8,
    pub cancel_tx: watch::Sender<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(super) enum IntentState {
    Prepared = 0,
    AwaitingPermission = 1,
    Running = 2,
    Complete = 3,
    Cancelled = 4,
}

impl Intent {
    pub fn state(&self) -> IntentState {
        match self.state.load(Ordering::Acquire) {
            1 => IntentState::AwaitingPermission,
            2 => IntentState::Running,
            3 => IntentState::Complete,
            4 => IntentState::Cancelled,
            _ => IntentState::Prepared,
        }
    }

    pub fn set_state(&self, state: IntentState) -> bool {
        let _transition = self.result.lock();
        if matches!(self.state(), IntentState::Cancelled | IntentState::Complete) {
            return false;
        }
        self.state.store(state as u8, Ordering::Release);
        true
    }

    pub fn set_run(&self, run_id: &str) -> Result<(), String> {
        // Serialize run binding with terminal transitions through the same
        // result mutex. A cancellation can no longer be overwritten by a late
        // Created->AwaitingPermission bind.
        let _transition = self.result.lock();
        let mut current = self.run_id.lock();
        if matches!(self.state(), IntentState::Cancelled | IntentState::Complete) {
            return Err("BrowserWindow intent is already terminal".into());
        }
        if current.as_deref().is_some_and(|value| value != run_id) {
            return Err("BrowserWindow intent is already attached to another TaskRun".into());
        }
        *current = Some(run_id.to_string());
        if self.state() != IntentState::Running {
            self.state
                .store(IntentState::AwaitingPermission as u8, Ordering::Release);
        }
        Ok(())
    }

    pub fn complete(&self, value: Result<Value, String>) -> bool {
        let mut result = self.result.lock();
        if matches!(self.state(), IntentState::Cancelled | IntentState::Complete) {
            return false;
        }
        *result = Some(value);
        self.state
            .store(IntentState::Complete as u8, Ordering::Release);
        self.cancel_tx.send_replace(false);
        true
    }

    pub fn cancel(&self, reason: &str) -> bool {
        let mut result = self.result.lock();
        if matches!(self.state(), IntentState::Cancelled | IntentState::Complete) {
            return false;
        }
        *result = Some(Err(reason.to_string()));
        self.state
            .store(IntentState::Cancelled as u8, Ordering::Release);
        self.cancel_tx.send_replace(true);
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LoadState {
    Pending,
    Loaded,
    Failed(String),
    Destroyed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WindowLife {
    Creating,
    Alive,
    Destroying,
}

pub(super) struct NativeWindow {
    pub owner: Owner,
    pub parent_label: String,
    pub creator_binding_id: String,
    pub frontend_window_id: String,
    pub native_label: String,
    pub intent_id: String,
    pub open_run_id: String,
    pub parent_was_visible: bool,
    pub permission_prompt_shown: bool,
    pub requested_show: bool,
    pub life: Mutex<WindowLife>,
    pub renderer_ready: AtomicBool,
    pub load_tx: watch::Sender<LoadState>,
    pub renderer_authorized: AtomicBool,
    pub destroy_requested: AtomicBool,
}

#[derive(Clone)]
pub(super) struct Reservation {
    pub parent_label: String,
    pub shell_url: String,
    pub shell_ticket: String,
    pub binding_id: String,
    pub run_id: String,
    pub spec: WindowSpec,
    pub window: Arc<NativeWindow>,
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
