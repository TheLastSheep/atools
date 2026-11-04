use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::Value;
use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};

use super::{
    bundle::SettingsBundle, command_data::CommandDataBuffers, phase::SessionSignal,
    preferences::SettingsPreferences, sub_input::SubInputBuffer,
};

struct ActiveSession {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) origin: String,
    pub(crate) bundle_revision: String,
    pub(crate) bundle: Arc<SettingsBundle>,
    pub(crate) preferences: Arc<SettingsPreferences>,
    pub(crate) command_data: Arc<CommandDataBuffers>,
    pub(crate) sub_input: Arc<SubInputBuffer>,
    pub(crate) native_runtime: Value,
    pub(crate) platform: Value,
    pub(crate) revoked: Arc<AtomicBool>,
    pub(crate) operations: Arc<Semaphore>,
    pub(crate) write_gate: Arc<AsyncMutex<()>>,
    pub(crate) close_gate: Arc<AsyncMutex<()>>,
    signals: watch::Sender<SessionSignal>,
    closing_reason: Option<String>,
    index_consumed: bool,
    started_count: u8,
    closed_phase_emitted: bool,
    back_phase_emitted: bool,
    layout_lease: Option<crate::window::MainChildLayoutLease>,
    material_lease: Option<crate::renderer_window_material::MaterialLease>,
    material_release_retry: Option<crate::renderer_window_material::MaterialReleaseToken>,
}

#[derive(Clone)]
pub(crate) struct SessionView {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) origin: String,
    pub(crate) bundle_revision: String,
    pub(crate) bundle: Arc<SettingsBundle>,
    pub(crate) preferences: Arc<SettingsPreferences>,
    pub(crate) command_data: Arc<CommandDataBuffers>,
    pub(crate) sub_input: Arc<SubInputBuffer>,
    pub(crate) native_runtime: Value,
    pub(crate) platform: Value,
    pub(crate) revoked: Arc<AtomicBool>,
    pub(crate) operations: Arc<Semaphore>,
    pub(crate) write_gate: Arc<AsyncMutex<()>>,
    pub(crate) close_gate: Arc<AsyncMutex<()>>,
    pub(crate) signals: watch::Sender<SessionSignal>,
    pub(crate) closing_reason: Option<String>,
}

impl SessionView {
    pub(crate) fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<SessionSignal> {
        self.signals.subscribe()
    }

    pub(crate) fn signal(&self) -> SessionSignal {
        self.signals.borrow().clone()
    }
}

#[path = "session_runtime.rs"]
mod runtime;
pub(crate) use runtime::{SettingsViewRuntime, UpdaterGrant};

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
