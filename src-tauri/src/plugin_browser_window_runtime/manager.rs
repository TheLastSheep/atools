use super::{
    identity::{private_id, unique_native_label, validate_private_size},
    intents::{
        validate_window_id, Intent, IntentState, LoadState, NativeWindow, Payload, Reservation,
        WindowLife,
    },
};
use crate::{plugin_asset_protocol::Owner, plugin_browser_window_native::WindowSpec};
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

mod lifecycle;
mod windows;

pub(super) const MAX_PENDING_INTENTS: usize = 32;
pub(super) const MAX_WINDOWS_PER_OWNER: usize = 4;
pub(super) const MAX_WINDOWS_GLOBAL: usize = 16;

#[derive(Default)]
pub(super) struct Runtime {
    pub(super) store: Mutex<Store>,
    stopped: AtomicBool,
}

#[derive(Default)]
pub(super) struct Store {
    pub intents: HashMap<String, Arc<Intent>>,
    pub reservations: HashMap<String, Reservation>,
    pub windows: HashMap<String, Arc<NativeWindow>>,
    expected_close_runs: HashMap<String, String>,
    protected_close_runs: HashSet<String>,
}

impl Runtime {
    pub fn create_open_intent(
        &self,
        owner: Owner,
        source_binding_id: String,
        window_id: String,
        options: Value,
        parent_was_visible: bool,
    ) -> Result<Arc<Intent>, String> {
        validate_window_id(&window_id)?;
        validate_private_size(&options)?;
        if !options.is_object() {
            return Err("BrowserWindow options must be a JSON object".into());
        }
        let label = unique_native_label();
        let spec = WindowSpec::from_options(label, &options)?;
        self.insert_intent(
            owner,
            source_binding_id,
            window_id,
            Payload::Open { spec: Some(spec) },
            parent_was_visible,
        )
    }

    pub fn create_action_intent(
        &self,
        owner: Owner,
        source_binding_id: String,
        window_id: String,
        action: String,
        args: Vec<Value>,
        parent_was_visible: bool,
    ) -> Result<Arc<Intent>, String> {
        validate_window_id(&window_id)?;
        if action.is_empty() || action.len() > 128 || action.chars().any(char::is_control) {
            return Err("Invalid native BrowserWindow action".into());
        }
        if action == "startDragging" {
            super::dragging::validate_started_at_for_prepare(&args)?;
        }
        validate_private_size(&Value::Array(args.clone()))?;
        self.insert_intent(
            owner,
            source_binding_id,
            window_id,
            Payload::Action { action, args },
            parent_was_visible,
        )
    }

    fn insert_intent(
        &self,
        owner: Owner,
        source_binding_id: String,
        window_id: String,
        payload: Payload,
        parent_was_visible: bool,
    ) -> Result<Arc<Intent>, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("Native BrowserWindow runtime is stopped".into());
        }
        let mut store = self.store.lock();
        if store.intents.len() >= MAX_PENDING_INTENTS {
            return Err("Too many pending BrowserWindow intents".into());
        }
        let operation = payload.operation();
        let id = private_id();
        let (cancel_tx, _) = watch::channel(false);
        let prepared_at = Instant::now();
        let prepared_at_epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        let intent = Arc::new(Intent {
            id: id.clone(),
            owner,
            source_binding_id,
            window_id,
            operation,
            parent_was_visible,
            permission_prompt_shown: AtomicBool::new(false),
            prepared_at,
            prepared_at_epoch_ms,
            payload: Mutex::new(Some(payload)),
            run_id: Mutex::new(None),
            result: Mutex::new(None),
            state: AtomicU8::new(IntentState::Prepared as u8),
            cancel_tx,
        });
        store.intents.insert(id, intent.clone());
        Ok(intent)
    }

    pub fn intent(&self, id: &str) -> Result<Arc<Intent>, String> {
        self.store
            .lock()
            .intents
            .get(id)
            .cloned()
            .ok_or_else(|| "BrowserWindow intent is no longer available".into())
    }

    pub fn take_result(&self, invoker: &str, id: &str) -> Result<Value, String> {
        let mut store = self.store.lock();
        let intent = store
            .intents
            .get(id)
            .ok_or_else(|| "BrowserWindow intent is no longer available".to_string())?;
        if intent.owner.window != invoker {
            return Err("BrowserWindow result belongs to another invoker".into());
        }
        let value = intent
            .result
            .lock()
            .take()
            .ok_or_else(|| "BrowserWindow result is not ready".to_string())?;
        store.intents.remove(id);
        value
    }

    /// Only an exact real Destroyed callback frees the native-window budget.
    pub fn remove_destroyed(
        &self,
        label: &str,
    ) -> Option<(Arc<NativeWindow>, Option<String>, Vec<Arc<Intent>>)> {
        let mut store = self.store.lock();
        let window = store.windows.remove(label)?;
        let expected_close_run = store.expected_close_runs.remove(label);
        if let Some(run_id) = &expected_close_run {
            store.protected_close_runs.insert(run_id.clone());
        }
        window.load_tx.send_replace(LoadState::Destroyed);
        let mut cancelled = Vec::new();
        let mut remove_intents = Vec::new();
        for (id, intent) in &store.intents {
            let targets_window =
                intent.owner == window.owner && intent.window_id == window.frontend_window_id;
            let is_expected = expected_close_run
                .as_ref()
                .is_some_and(|run| intent.run_id.lock().as_deref() == Some(run.as_str()));
            if targets_window && !is_expected && !Self::is_protected_close(&store, intent) {
                if intent.cancel("Native BrowserWindow was destroyed") {
                    cancelled.push(intent.clone());
                }
                remove_intents.push(id.clone());
            }
        }
        for id in remove_intents {
            store.intents.remove(&id);
        }
        Some((window, expected_close_run, cancelled))
    }

    fn is_expected_close(store: &Store, intent: &Intent) -> bool {
        Self::is_protected_close(store, intent)
            || store.windows.iter().any(|(label, window)| {
                let is_target =
                    window.owner == intent.owner && window.frontend_window_id == intent.window_id;
                is_target
                    && intent
                        .run_id
                        .lock()
                        .as_ref()
                        .is_some_and(|run| store.expected_close_runs.get(label) == Some(run))
            })
    }

    fn is_protected_close(store: &Store, intent: &Intent) -> bool {
        intent
            .run_id
            .lock()
            .as_ref()
            .is_some_and(|run| store.protected_close_runs.contains(run))
    }

    pub fn clear_protected_close(&self, run_id: &str) {
        self.store.lock().protected_close_runs.remove(run_id);
    }

    pub fn finish_intent(&self, intent: &Arc<Intent>, value: Result<Value, String>) -> bool {
        intent.complete(value)
    }

    pub fn cancel_intent(&self, id: &str, reason: &str) -> Option<Arc<Intent>> {
        let mut store = self.store.lock();
        let intent = store.intents.get(id).cloned()?;
        let _ = intent.cancel(reason);
        store
            .reservations
            .retain(|_, reservation| reservation.window.intent_id != id);
        store.intents.remove(id);
        Some(intent)
    }

    pub fn window_for_intent(&self, id: &str) -> Option<Arc<NativeWindow>> {
        self.store
            .lock()
            .windows
            .values()
            .find(|window| window.intent_id == id)
            .cloned()
    }

    pub fn window_for_frontend_id(&self, owner: &Owner, id: &str) -> Option<Arc<NativeWindow>> {
        self.store
            .lock()
            .windows
            .values()
            .find(|window| &window.owner == owner && window.frontend_window_id == id)
            .cloned()
    }

    /// Used only after the adapter confirms that builder creation failed and no
    /// native window with this UUID label exists.
    pub fn discard_unbuilt(&self, label: &str) -> Option<Arc<NativeWindow>> {
        let mut store = self.store.lock();
        let window = store.windows.get(label)?.clone();
        if *window.life.lock() != WindowLife::Creating {
            return None;
        }
        store.windows.remove(label);
        window
            .load_tx
            .send_replace(LoadState::Failed("Native window was not built".into()));
        Some(window)
    }

    pub fn build_failed(&self, label: &str) -> Option<Arc<NativeWindow>> {
        let mut store = self.store.lock();
        let window = store.windows.get(label)?.clone();
        if *window.life.lock() == WindowLife::Alive {
            return None;
        }
        store.windows.remove(label);
        store.expected_close_runs.remove(label);
        window
            .load_tx
            .send_replace(LoadState::Failed("Native window builder failed".into()));
        Some(window)
    }

    pub fn intent_by_run(&self, run_id: &str) -> Option<Arc<Intent>> {
        self.store
            .lock()
            .intents
            .values()
            .find(|intent| intent.run_id.lock().as_deref() == Some(run_id))
            .cloned()
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
