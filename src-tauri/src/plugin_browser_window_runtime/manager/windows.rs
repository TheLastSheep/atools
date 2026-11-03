//! Native-window reservation, target authorization, and expected-close state.
use super::super::intents::{Intent, LoadState, NativeWindow, Reservation, WindowLife};
use super::super::manager::Runtime;
use super::{MAX_WINDOWS_GLOBAL, MAX_WINDOWS_PER_OWNER};
use crate::{
    plugin_asset_protocol::Owner, plugin_browser_window_native::WindowSpec,
    plugin_window_sources::SourceBinding,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::watch;

impl Runtime {
    pub fn reserve(
        &self,
        intent: &Arc<Intent>,
        parent_label: String,
        shell_url: String,
        ticket: String,
        spec: WindowSpec,
    ) -> Result<(Arc<NativeWindow>, watch::Receiver<LoadState>), String> {
        let run_id = intent
            .run_id
            .lock()
            .clone()
            .ok_or("BrowserWindow TaskRun is not bound")?;
        let native_label = spec.label().to_string();
        let requested_show = spec.show;
        let (load_tx, load_rx) = watch::channel(LoadState::Pending);
        let window = Arc::new(NativeWindow {
            owner: intent.owner.clone(),
            parent_label: parent_label.clone(),
            creator_binding_id: intent.source_binding_id.clone(),
            frontend_window_id: intent.window_id.clone(),
            native_label,
            intent_id: intent.id.clone(),
            open_run_id: run_id.clone(),
            life: parking_lot::Mutex::new(WindowLife::Creating),
            parent_was_visible: intent.parent_was_visible,
            permission_prompt_shown: intent.permission_prompt_shown.load(Ordering::Acquire),
            requested_show,
            renderer_ready: AtomicBool::new(false),
            load_tx,
            renderer_authorized: AtomicBool::new(false),
            destroy_requested: AtomicBool::new(false),
        });
        let mut store = self.store.lock();
        if store.reservations.contains_key(&shell_url)
            || store.windows.contains_key(&window.native_label)
        {
            return Err("BrowserWindow reservation collision".into());
        }
        let count = store
            .windows
            .values()
            .filter(|entry| entry.owner == intent.owner)
            .count()
            + store
                .reservations
                .values()
                .filter(|entry| entry.window.owner == intent.owner)
                .count();
        if count >= MAX_WINDOWS_PER_OWNER
            || store.windows.len() + store.reservations.len() >= MAX_WINDOWS_GLOBAL
        {
            return Err("Native BrowserWindow limit reached".into());
        }
        if store.windows.values().any(|entry| {
            entry.owner == intent.owner && entry.frontend_window_id == intent.window_id
        }) || store.reservations.values().any(|entry| {
            entry.window.owner == intent.owner
                && entry.window.frontend_window_id == intent.window_id
        }) {
            return Err("BrowserWindow ID already exists for this plugin instance".into());
        }
        store.reservations.insert(
            shell_url.clone(),
            Reservation {
                parent_label,
                shell_url,
                shell_ticket: ticket,
                binding_id: intent.source_binding_id.clone(),
                run_id,
                spec,
                window: window.clone(),
            },
        );
        Ok((window, load_rx))
    }

    pub fn reservation(&self, parent: &str, url: &str) -> Option<Reservation> {
        self.store
            .lock()
            .reservations
            .get(url)
            .filter(|reservation| {
                reservation.parent_label == parent && reservation.shell_url == url
            })
            .cloned()
    }

    pub fn consume_reservation(
        &self,
        parent: &str,
        url: &str,
        binding_id: &str,
        run_id: &str,
    ) -> Option<Reservation> {
        let mut store = self.store.lock();
        let matches = store.reservations.get(url).is_some_and(|reservation| {
            reservation.parent_label == parent
                && reservation.shell_url == url
                && reservation.binding_id == binding_id
                && reservation.run_id == run_id
        });
        if !matches {
            return None;
        }
        let reservation = store.reservations.remove(url)?;
        let label = reservation.window.native_label.clone();
        *reservation.window.life.lock() = WindowLife::Creating;
        store.windows.insert(label, reservation.window.clone());
        Some(reservation)
    }

    pub fn expire_reservation(&self, url: &str) -> Option<Reservation> {
        self.store.lock().reservations.remove(url)
    }

    pub fn window(&self, label: &str) -> Option<Arc<NativeWindow>> {
        self.store.lock().windows.get(label).cloned()
    }

    pub fn window_for_source(
        &self,
        source: &SourceBinding,
        id: &str,
    ) -> Result<Arc<NativeWindow>, String> {
        self.window_for_identity(
            source.owner(),
            source.is_active(),
            source.id(),
            source.frame_id(),
            id,
        )
    }

    pub(super) fn window_for_identity(
        &self,
        owner: &Owner,
        source_active: bool,
        source_binding_id: &str,
        source_frame_id: &str,
        id: &str,
    ) -> Result<Arc<NativeWindow>, String> {
        self.store
            .lock()
            .windows
            .values()
            .find(|entry| {
                entry.frontend_window_id == id
                    && super::super::identity::may_control_window(
                        source_active,
                        entry.owner == *owner,
                        *entry.life.lock() == WindowLife::Alive,
                        &entry.creator_binding_id,
                        source_binding_id,
                        source_frame_id,
                        id,
                    )
            })
            .cloned()
            .ok_or_else(|| "BrowserWindow is not active for this plugin source".into())
    }

    pub fn windows_created_by(&self, source: &SourceBinding) -> Vec<Arc<NativeWindow>> {
        self.store
            .lock()
            .windows
            .values()
            .filter(|window| {
                window.owner == *source.owner() && window.creator_binding_id == source.id()
            })
            .cloned()
            .collect()
    }

    pub fn claim_renderer_ready(
        &self,
        label: &str,
        source_id: &str,
    ) -> Result<Arc<NativeWindow>, String> {
        let window = self
            .window(label)
            .ok_or("BrowserWindow is no longer active")?;
        if window.creator_binding_id != source_id || *window.life.lock() != WindowLife::Alive {
            return Err("BrowserWindow renderer is not owned by this source".into());
        }
        window
            .renderer_ready
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "BrowserWindow renderer readiness was already confirmed")?;
        Ok(window)
    }

    pub fn mark_loaded(&self, label: &str) -> Option<Arc<NativeWindow>> {
        let window = self.window(label)?;
        let mut life = window.life.lock();
        if *life != WindowLife::Creating {
            return None;
        }
        *life = WindowLife::Alive;
        drop(life);
        window.load_tx.send_replace(LoadState::Loaded);
        Some(window)
    }

    pub fn mark_created(&self, label: &str) -> Option<Arc<NativeWindow>> {
        let window = self.window(label)?;
        if *window.life.lock() == WindowLife::Destroying {
            return Some(window);
        }
        Some(window)
    }

    pub fn mark_destroying(&self, label: &str) -> Option<Arc<NativeWindow>> {
        let store = self.store.lock();
        let window = store.windows.get(label)?.clone();
        let mut life = window.life.lock();
        if *life == WindowLife::Destroying {
            return None;
        }
        *life = WindowLife::Destroying;
        drop(life);
        Some(window)
    }

    pub fn begin_expected_close(
        &self,
        label: &str,
        run_id: &str,
    ) -> Result<Arc<NativeWindow>, String> {
        let mut store = self.store.lock();
        let window = store
            .windows
            .get(label)
            .cloned()
            .ok_or("BrowserWindow is no longer active")?;
        let mut life = window.life.lock();
        if *life != WindowLife::Alive || store.expected_close_runs.contains_key(label) {
            return Err("BrowserWindow is not available for a close action".into());
        }
        *life = WindowLife::Destroying;
        store
            .expected_close_runs
            .insert(label.to_string(), run_id.to_string());
        drop(life);
        Ok(window)
    }

    pub fn clear_expected_close(&self, label: &str, run_id: &str) {
        let mut store = self.store.lock();
        if store
            .expected_close_runs
            .get(label)
            .is_some_and(|current| current == run_id)
        {
            store.expected_close_runs.remove(label);
            if let Some(window) = store.windows.get(label) {
                let mut life = window.life.lock();
                if *life == WindowLife::Destroying {
                    *life = WindowLife::Alive;
                }
            }
        }
    }

    /// Forget a timed-out expected-close completion while preserving its
    /// Destroying state and native budget until the real Destroyed callback.
    pub fn abandon_expected_close(&self, label: &str, run_id: &str) -> Option<Arc<NativeWindow>> {
        let mut store = self.store.lock();
        if !store
            .expected_close_runs
            .get(label)
            .is_some_and(|current| current == run_id)
        {
            return None;
        }
        store.expected_close_runs.remove(label);
        store.windows.get(label).cloned()
    }
}
