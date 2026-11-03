//! Bounded, one-shot storage and claim validation for detached plugin actions.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tokio::sync::OwnedMutexGuard;

use crate::commands::FeatureAction;

mod intent;

#[cfg(test)]
use intent::CancelOpenMatch;
use intent::OpenIntent;

const HANDOFF_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(crate) struct PluginDetachRuntime {
    inner: Mutex<RuntimeState>,
    open_commit_gate: Mutex<()>,
    cleanup_gate: std::sync::Arc<tokio::sync::Mutex<()>>,
    cleanup_finished: tokio::sync::Notify,
    handoff_changed: tokio::sync::Notify,
}

#[derive(Default)]
struct RuntimeState {
    pending: Option<PendingPluginAction>,
    expiry_task: Option<tauri::async_runtime::JoinHandle<()>>,
    generation: u64,
    destroyed_cleanup_count: usize,
    open_intent_epoch: u64,
    latest_open: Option<OpenIntent>,
    active_request_id: Option<String>,
    active_handoff_id: Option<String>,
    active_plugin_id: Option<String>,
    active_feature_code: Option<String>,
    occupied: bool,
    closing_request_id: Option<String>,
}

pub(crate) struct PendingPluginAction {
    pub id: String,
    pub action: FeatureAction,
    pub plugin_version: String,
    pub code_revision: Option<String>,
    request_id: String,
    expires_at: Instant,
    generation: u64,
    ready: bool,
}

impl PendingPluginAction {
    pub(crate) fn new(
        action: FeatureAction,
        plugin_version: String,
        code_revision: Option<String>,
        request_id: String,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            action,
            plugin_version,
            code_revision,
            request_id,
            expires_at: Instant::now() + HANDOFF_TTL,
            generation: 0,
            ready: false,
        }
    }
}

impl PluginDetachRuntime {
    pub(crate) fn begin_cancel_for_request(
        &self,
        request_id: &str,
        window_will_close: bool,
    ) -> bool {
        self.inner
            .lock()
            .begin_cancel_for_request(request_id, window_will_close)
    }

    pub(crate) fn is_occupied(&self) -> bool {
        self.inner.lock().occupied
    }

    pub(crate) fn active_feature(&self) -> Option<(String, String)> {
        let state = self.inner.lock();
        if state.occupied {
            match (&state.active_plugin_id, &state.active_feature_code) {
                (Some(plugin), Some(feature)) => Some((plugin.clone(), feature.clone())),
                _ => None,
            }
        } else {
            None
        }
    }

    pub(crate) fn active_request_matches(&self, request_id: &str) -> bool {
        self.inner.lock().active_request_id.as_deref() == Some(request_id)
    }

    pub(crate) fn store_for_generation(
        &self,
        app: &AppHandle,
        mut pending: PendingPluginAction,
        generation: u64,
        intent: &OpenIntent,
    ) -> Result<(), String> {
        pending.expires_at = Instant::now() + HANDOFF_TTL;
        let id = pending.id.clone();
        let app = app.clone();
        let expiry = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(HANDOFF_TTL).await;
            if let Some(runtime) = app.try_state::<PluginDetachRuntime>() {
                runtime.clear_if(&id);
            }
        });
        self.stage_pending(pending, generation, intent, Some(expiry))
    }

    fn stage_pending(
        &self,
        mut pending: PendingPluginAction,
        generation: u64,
        intent: &OpenIntent,
        expiry: Option<tauri::async_runtime::JoinHandle<()>>,
    ) -> Result<(), String> {
        pending.expires_at = Instant::now() + HANDOFF_TTL;
        pending.generation = generation;
        let mut state = self.inner.lock();
        if state.latest_open.as_ref() != Some(intent)
            || pending.request_id != intent.request_id
            || state.replace_for_generation(pending, generation).is_err()
        {
            drop(state);
            if let Some(expiry) = expiry {
                expiry.abort();
            }
            return Err("Detached window changed during handoff; retry opening the plugin".into());
        }
        if let Some(previous) = state.expiry_task.take() {
            previous.abort();
        }
        state.expiry_task = expiry;
        state.active_request_id = Some(intent.request_id.clone());
        state.active_handoff_id = state.pending.as_ref().map(|pending| pending.id.clone());
        state.occupied = false;
        drop(state);
        self.handoff_changed.notify_waiters();
        Ok(())
    }

    pub(crate) async fn claim(&self, id: &str) -> Result<PendingPluginAction, String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid plugin handoff id".into());
        }
        loop {
            let notified = self.handoff_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let result = self.inner.lock().take_if_ready(id, Instant::now());
            if let Some(result) = result {
                self.handoff_changed.notify_waiters();
                return result;
            }
            notified.await;
        }
    }

    /// Consumes the ready slot and holds the reuse gate through the caller's
    /// database snapshot validation, so a new window cannot stage in between.
    pub(crate) async fn claim_for_validation(
        &self,
        id: &str,
    ) -> Result<(PendingPluginAction, OwnedMutexGuard<()>), String> {
        let pending = self.claim(id).await?;
        let gate = self.cleanup_gate.clone().lock_owned().await;
        self.ensure_current_generation(&pending)?;
        Ok((pending, gate))
    }

    pub(crate) fn ensure_current_generation(
        &self,
        pending: &PendingPluginAction,
    ) -> Result<(), String> {
        let state = self.inner.lock();
        if state.generation == pending.generation
            && state.destroyed_cleanup_count == 0
            && state.closing_request_id.is_none()
        {
            Ok(())
        } else {
            Err("Plugin handoff window changed before claim validation completed".into())
        }
    }

    fn clear_if(&self, id: &str) {
        let changed = self.inner.lock().clear_if(id);
        if changed {
            self.handoff_changed.notify_waiters();
        }
    }

    pub(crate) fn clear_handoff(&self, id: &str) {
        let changed = self.inner.lock().clear_handoff(id);
        if changed {
            self.handoff_changed.notify_waiters();
        }
    }

    fn clear_all(&self) {
        let mut state = self.inner.lock();
        state.clear_all();
        state.latest_open = None;
        state.open_intent_epoch = state.open_intent_epoch.wrapping_add(1);
        state.closing_request_id = None;
        state.destroyed_cleanup_count = 0;
        drop(state);
        self.handoff_changed.notify_waiters();
        self.cleanup_finished.notify_waiters();
    }

    pub(crate) fn begin_destroyed_cleanup(&self) {
        self.inner.lock().begin_destroyed_cleanup();
        self.handoff_changed.notify_waiters();
    }

    pub(crate) fn complete_destroyed_cleanup(&self) {
        self.inner.lock().complete_destroyed_cleanup();
        self.cleanup_finished.notify_waiters();
    }

    pub(crate) fn destroyed_cleanup_pending(&self) -> bool {
        let state = self.inner.lock();
        state.destroyed_cleanup_count > 0 || state.closing_request_id.is_some()
    }

    #[cfg(test)]
    pub(crate) fn generation(&self) -> u64 {
        self.inner.lock().generation
    }

    pub(crate) fn clear_for_reuse(&self) {
        self.inner.lock().clear_all();
        self.handoff_changed.notify_waiters();
    }

    /// Invalidates actions from the previous document before native resources
    /// are closed and the next handoff is staged.
    pub(crate) fn begin_reuse(&self) -> u64 {
        let generation = self.inner.lock().begin_reuse();
        self.handoff_changed.notify_waiters();
        generation
    }

    pub(crate) async fn wait_for_destroyed_cleanup(&self) {
        loop {
            let notified = self.cleanup_finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.destroyed_cleanup_pending() {
                return;
            }
            notified.await;
        }
    }

    pub(crate) fn mark_ready(&self, id: &str, generation: u64) -> Result<(), String> {
        self.inner
            .lock()
            .mark_ready(id, generation)
            .map_err(|()| "Detached window changed before it became ready".to_string())?;
        self.handoff_changed.notify_waiters();
        Ok(())
    }

    pub(crate) fn cleanup_gate(&self) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        self.cleanup_gate.clone()
    }
}

impl RuntimeState {
    fn begin_destroyed_cleanup(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.destroyed_cleanup_count = self.destroyed_cleanup_count.saturating_add(1);
        if self
            .active_request_id
            .as_ref()
            .zip(self.latest_open.as_ref())
            .is_some_and(|(active, latest)| active == &latest.request_id)
        {
            self.latest_open = None;
        }
        self.clear_all();
    }

    fn complete_destroyed_cleanup(&mut self) {
        self.destroyed_cleanup_count = self.destroyed_cleanup_count.saturating_sub(1);
        if self.destroyed_cleanup_count == 0 {
            self.closing_request_id = None;
        }
    }

    fn begin_reuse(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.clear_all();
        self.generation
    }

    fn begin_cancel_for_request(&mut self, request_id: &str, window_will_close: bool) -> bool {
        if self.active_request_id.as_deref() != Some(request_id) {
            return false;
        }
        self.generation = self.generation.wrapping_add(1);
        self.clear_all();
        if window_will_close {
            self.closing_request_id = Some(request_id.to_string());
        }
        true
    }

    fn replace(&mut self, pending: PendingPluginAction) {
        self.pending = Some(pending);
    }

    fn replace_for_generation(
        &mut self,
        pending: PendingPluginAction,
        generation: u64,
    ) -> Result<(), ()> {
        if self.generation != generation
            || self.destroyed_cleanup_count > 0
            || self.closing_request_id.is_some()
        {
            return Err(());
        }
        self.replace(pending);
        Ok(())
    }

    fn take(&mut self, id: &str, now: Instant) -> Result<PendingPluginAction, String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid plugin handoff id".into());
        }
        let Some(pending) = self.pending.as_ref() else {
            return Err("Plugin handoff is missing or already consumed".into());
        };
        if pending.expires_at <= now {
            self.clear_all();
            return Err("Plugin handoff expired; reopen the plugin".into());
        }
        if pending.id != id {
            return Err("Plugin handoff id does not match the pending action".into());
        }
        if !pending.ready {
            return Err("Plugin handoff window is not ready".into());
        }
        let action = self.pending.take().expect("checked pending action");
        self.abort_expiry();
        Ok(action)
    }

    fn take_if_ready(
        &mut self,
        id: &str,
        now: Instant,
    ) -> Option<Result<PendingPluginAction, String>> {
        let Some(pending) = self.pending.as_ref() else {
            return Some(Err("Plugin handoff is missing or already consumed".into()));
        };
        if pending.expires_at <= now || pending.id != id || pending.ready {
            return Some(self.take(id, now));
        }
        None
    }

    fn mark_ready(&mut self, id: &str, generation: u64) -> Result<(), ()> {
        if self.generation != generation
            || self.destroyed_cleanup_count > 0
            || self.closing_request_id.is_some()
        {
            return Err(());
        }
        let Some(pending) = self.pending.as_mut() else {
            return Err(());
        };
        if pending.id != id {
            return Err(());
        }
        pending.ready = true;
        self.occupied = true;
        self.active_plugin_id = Some(pending.action.plugin_id.clone());
        self.active_feature_code = Some(pending.action.feature_code.clone());
        Ok(())
    }

    fn clear_if(&mut self, id: &str) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            self.clear_pending();
            true
        } else {
            false
        }
    }

    fn clear_all(&mut self) {
        self.clear_pending();
        self.active_request_id = None;
        self.active_handoff_id = None;
        self.active_plugin_id = None;
        self.active_feature_code = None;
        self.occupied = false;
    }

    fn clear_pending(&mut self) {
        self.pending = None;
        self.abort_expiry();
    }

    fn clear_handoff(&mut self, id: &str) -> bool {
        let pending_match = self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id);
        let active_match = self.active_handoff_id.as_deref() == Some(id);
        if !pending_match && !active_match {
            return false;
        }
        self.clear_pending();
        if active_match {
            self.active_request_id = None;
            self.active_handoff_id = None;
            self.active_plugin_id = None;
            self.active_feature_code = None;
            self.occupied = false;
        }
        true
    }

    fn abort_expiry(&mut self) {
        if let Some(expiry) = self.expiry_task.take() {
            expiry.abort();
        }
    }
}

pub(crate) fn close_window(app: &AppHandle, label: &str) {
    if label == crate::window::PLUGIN_DETACH_LABEL {
        if let Some(runtime) = app.try_state::<PluginDetachRuntime>() {
            runtime.begin_destroyed_cleanup();
        }
    }
}

pub(crate) fn clear_all(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<PluginDetachRuntime>() {
        runtime.clear_all();
    }
}

#[cfg(test)]
#[path = "plugin_detach_runtime_tests.rs"]
mod tests;
