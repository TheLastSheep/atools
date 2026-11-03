use std::sync::atomic::{AtomicBool, Ordering};
use std::{future::Future, sync::Arc};

use parking_lot::Mutex as ParkingMutex;
use tokio::sync::{oneshot, Mutex, OwnedSemaphorePermit, Semaphore};

use super::app_shortcut_registry::OwnedAppShortcutRegistry;

const MAX_ADMITTED_WRITES: usize = 32;

/// App-managed admission and serialization for every General settings write.
#[derive(Clone)]
pub(crate) struct GeneralSettingsCoordinator {
    pub(crate) feature_dispatch: Arc<crate::app_global_shortcuts::feature_dispatch::Ledger>,
    pub(crate) app_recording: Arc<crate::app_global_shortcuts::recording_gate::Gate>,
    admitted: Arc<Semaphore>,
    serial: Arc<Mutex<()>>,
    app_shortcuts: Arc<ParkingMutex<OwnedAppShortcutRegistry>>,
    hotkey_operation_active: Arc<AtomicBool>,
    owned_main_hotkey: Arc<ParkingMutex<crate::hotkey::OwnedMainHotkeyRegistry>>,
    pub(crate) recording_signals: Arc<crate::hotkey::recording_runtime::Signals>,
    recording: Arc<ParkingMutex<crate::hotkey::recording::Registry>>,
    pub(crate) hotkey_operation_available: Arc<tokio::sync::Notify>,
    paste_stack_hotkey_owned: Arc<ParkingMutex<bool>>,
}

impl Default for GeneralSettingsCoordinator {
    fn default() -> Self {
        Self {
            feature_dispatch: Arc::default(),
            app_recording: Arc::default(),
            admitted: Arc::new(Semaphore::new(MAX_ADMITTED_WRITES)),
            serial: Arc::new(Mutex::new(())),
            app_shortcuts: Arc::new(ParkingMutex::new(OwnedAppShortcutRegistry::default())),
            hotkey_operation_active: Arc::new(AtomicBool::new(false)),
            owned_main_hotkey: Arc::new(ParkingMutex::new(
                crate::hotkey::OwnedMainHotkeyRegistry::default(),
            )),
            recording_signals: Arc::default(),
            recording: Arc::default(),
            hotkey_operation_available: Arc::default(),
            paste_stack_hotkey_owned: Arc::new(ParkingMutex::new(false)),
        }
    }
}

impl GeneralSettingsCoordinator {
    pub(super) fn with_app_shortcuts<T>(
        &self,
        operation: impl FnOnce(&mut OwnedAppShortcutRegistry) -> T,
    ) -> Result<T, String> {
        let _lease = self.hotkey_operation_lease()?;
        if self.app_recording.busy() {
            return Err(crate::app_global_shortcuts::recording_gate::BUSY.into());
        }
        Ok(operation(&mut self.app_shortcuts.lock()))
    }

    pub(crate) fn with_owned_main_hotkey<T>(
        &self,
        operation: impl FnOnce(&mut crate::hotkey::OwnedMainHotkeyRegistry) -> T,
    ) -> Result<T, String> {
        let _lease = self.hotkey_operation_lease()?;
        if self.app_recording.busy() {
            return Err(crate::app_global_shortcuts::recording_gate::BUSY.into());
        }
        Ok(operation(&mut self.owned_main_hotkey.lock()))
    }

    pub(crate) fn with_hotkey_registries<T>(
        &self,
        operation: impl FnOnce(&mut crate::hotkey::OwnedMainHotkeyRegistry, &mut bool) -> T,
    ) -> Result<T, String> {
        let _lease = self.hotkey_operation_lease()?;
        if self.app_recording.busy() {
            return Err(crate::app_global_shortcuts::recording_gate::BUSY.into());
        }
        let mut primary = self.owned_main_hotkey.lock();
        let mut paste_stack = self.paste_stack_hotkey_owned.lock();
        Ok(operation(&mut primary, &mut paste_stack))
    }

    pub(crate) fn with_hotkey_operation<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _lease = self.hotkey_operation_lease()?;
        if self.app_recording.busy() {
            return Err(crate::app_global_shortcuts::recording_gate::BUSY.into());
        }
        operation()
    }

    pub(crate) fn with_recording_registries<T>(
        &self,
        operation: impl FnOnce(
            &mut crate::hotkey::OwnedMainHotkeyRegistry,
            &mut crate::hotkey::recording::Registry,
        ) -> T,
    ) -> Result<T, String> {
        let _lease = self.hotkey_operation_lease()?;
        Ok(operation(
            &mut self.owned_main_hotkey.lock(),
            &mut self.recording.lock(),
        ))
    }

    /// Caller holds the OS operation lease and has permanently fenced dispatch.
    pub(crate) fn with_shutdown_registries<T>(
        &self,
        operation: impl FnOnce(
            &mut OwnedAppShortcutRegistry,
            &mut crate::hotkey::OwnedMainHotkeyRegistry,
            &mut bool,
            &mut crate::hotkey::recording::Registry,
        ) -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.app_recording.closed() {
            return Err("SETTINGS_HOTKEY_REJECTED".into());
        }
        operation(
            &mut self.app_shortcuts.lock(),
            &mut self.owned_main_hotkey.lock(),
            &mut self.paste_stack_hotkey_owned.lock(),
            &mut self.recording.lock(),
        )
    }

    // Tauri shortcut calls synchronously dispatch to the UI thread; fail fast instead of
    // blocking that thread behind a registry mutex held by the dispatching worker.
    pub(crate) fn hotkey_operation_lease(&self) -> Result<HotkeyOperationLease, String> {
        self.hotkey_operation_active
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| {
                HotkeyOperationLease(
                    Arc::clone(&self.hotkey_operation_active),
                    Arc::clone(&self.hotkey_operation_available),
                )
            })
            .map_err(|_| "SETTINGS_HOTKEY_REJECTED".to_owned())
    }

    /// Starts an owned transaction task; dropping the caller only drops its reply receiver.
    pub(crate) async fn run<T, F, Fut>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        let permit = self
            .admitted
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Too many General settings writes are already queued".to_owned())?;
        let serial = Arc::clone(&self.serial);
        let (reply_tx, reply_rx) = oneshot::channel();

        // Tokio JoinHandle drop detaches the task. Its permit and lock stay owned here.
        drop(tauri::async_runtime::spawn(async move {
            let _permit: OwnedSemaphorePermit = permit;
            let _serial = serial.lock().await;
            let result = operation().await;
            let _ = reply_tx.send(result);
        }));

        reply_rx
            .await
            .map_err(|_| "General settings transaction task stopped before replying".to_owned())?
    }
}

pub(crate) struct HotkeyOperationLease(Arc<AtomicBool>, Arc<tokio::sync::Notify>);

impl Drop for HotkeyOperationLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
        self.1.notify_waiters();
    }
}

#[cfg(test)]
#[path = "coordinator_tests.rs"]
mod tests;
