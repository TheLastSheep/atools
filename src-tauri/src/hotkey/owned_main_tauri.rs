use crate::hotkey::main_binding::{parse_main_binding, MainBinding};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcut;

#[cfg(feature = "legacy-node-smoke")]
use super::OwnedMainHotkeySnapshot;
use super::{
    parser::parse_main_hotkey, OwnedMainHotkeyRegistry,
    OwnedMainHotkeyStateSnapshot, RegisterFailure, ShortcutPort, HOTKEY_OUTCOME_UNKNOWN,
    HOTKEY_REJECTED,
};

struct TauriShortcutPort<'a> {
    app: &'a AppHandle,
}

impl ShortcutPort for TauriShortcutPort<'_> {
    fn is_registered(&self, binding: MainBinding) -> Result<bool, String> {
        match binding {
            MainBinding::Accelerator(key) => self
                .manager()
                .map(|manager| manager.inner().is_registered(key)),
            MainBinding::DoubleTap(_) => {
                Ok(crate::hotkey::main_dispatch::native(self.app, binding)?.is_some())
            }
        }
    }
    fn is_healthy(&self, binding: MainBinding) -> Result<bool, String> {
        match binding {
            MainBinding::Accelerator(_) => self.is_registered(binding),
            MainBinding::DoubleTap(_) => {
                match crate::hotkey::main_dispatch::native(self.app, binding)? {
                    Some(lease) => crate::hotkey::double_tap_native::healthy(self.app, lease),
                    None => Ok(false),
                }
            }
        }
    }
    fn recover(&mut self, binding: MainBinding) -> Result<(), String> {
        if let MainBinding::DoubleTap(_) = binding {
            crate::hotkey::double_tap_native::preflight()?;
            let lease = crate::hotkey::main_dispatch::native(self.app, binding)?
                .ok_or(HOTKEY_OUTCOME_UNKNOWN)?;
            crate::hotkey::double_tap_native::recover(self.app, lease)
        } else if self.is_healthy(binding)? {
            Ok(())
        } else {
            Err(HOTKEY_OUTCOME_UNKNOWN.into())
        }
    }
    fn suspend(&mut self, binding: MainBinding) -> Result<(), String> {
        match binding {
            MainBinding::DoubleTap(_) => crate::hotkey::double_tap_native::suspend(
                self.app,
                crate::hotkey::main_dispatch::native(self.app, binding)?
                    .ok_or(HOTKEY_OUTCOME_UNKNOWN)?,
            ),
            MainBinding::Accelerator(_) => {
                if !self.is_healthy(binding)? {
                    Ok(())
                } else {
                    Err("SETTINGS_NATIVE_RECOVERY_FAILED".into())
                }
            }
        }
    }
    fn register(&mut self, binding: MainBinding) -> Result<(), RegisterFailure> {
        let token = crate::hotkey::main_dispatch::pending(self.app, binding)
            .map_err(RegisterFailure::Unavailable)?;
        match binding {
            MainBinding::DoubleTap(modifier) => {
                let gate = crate::app_global_shortcuts::recording::gate(self.app).map_err(RegisterFailure::Unavailable)?;
                let receipt = gate.receipt(None).map_err(RegisterFailure::Unavailable)?;
                *token.receipt.lock() = Some(receipt.clone());
                match crate::hotkey::double_tap_native::create(self.app, modifier, token) {
                    Ok(lease) => {
                        receipt.publish();
                        crate::hotkey::main_dispatch::attach(self.app, binding, lease).map_err(RegisterFailure::Unavailable)
                    },
                    Err(crate::hotkey::double_tap_native::CreateFailure::Owned(lease)) => {
                        receipt.publish();
                        crate::hotkey::main_dispatch::attach(self.app, binding, lease)
                            .map_err(RegisterFailure::Unavailable)?;
                        Err(RegisterFailure::PartialOwned)
                    }
                    Err(crate::hotkey::double_tap_native::CreateFailure::Clean(error)) => {
                        let _ = crate::hotkey::main_dispatch::remove(self.app, binding);
                        if crate::hotkey::known_hotkey_rejection(&error) {
                            Err(RegisterFailure::RejectedCode(error))
                        } else {
                            Err(RegisterFailure::Unavailable(error))
                        }
                    }
                }
            }
            MainBinding::Accelerator(shortcut) => {
                let handle = self.app.clone();
                let gate = crate::app_global_shortcuts::recording::gate(self.app)
                    .map_err(RegisterFailure::Unavailable)?;
                let capture = (shortcut == crate::hotkey::recording_runtime::KEY.parse().unwrap())
                    .then(|| crate::hotkey::recording_runtime::KEY.to_owned());
                let receipt = gate.receipt(capture).map_err(RegisterFailure::Unavailable)?;
                let callback_receipt = receipt.clone();
                *token.receipt.lock() = Some(receipt.clone());
                let result = self
                    .manager()
                    .map_err(RegisterFailure::Unavailable)?
                    .inner()
                    .on_shortcut(shortcut, move |_app, key, event| {
                        let epoch = callback_receipt.edge(event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed);
                        let consumed = crate::hotkey::recording_runtime::route_event(
                            &handle,
                            key,
                            event.state,
                        );
                        if !consumed {
                            if let Some(epoch) = epoch {
                                crate::hotkey::main_dispatch::enqueue(&handle, &token, std::sync::Arc::downgrade(&callback_receipt), epoch);
                            }
                        }
                    })
                    .map_err(classify_registration_error);
                if result.is_err() {
                    let _ = crate::hotkey::main_dispatch::remove(self.app, binding);
                } else {
                    receipt.publish();
                }
                result
            }
        }
    }
    fn unregister(&mut self, binding: MainBinding) -> Result<(), String> {
        match binding {
            MainBinding::Accelerator(shortcut) => {
                let manager = self.manager()?;
                manager.inner().unregister(shortcut)
                    .map_err(|_| "Owned main hotkey could not be released".to_owned())?;
                if manager.inner().is_registered(shortcut) {
                    return Err("Owned main hotkey unregister readback failed".into());
                }
            },
            MainBinding::DoubleTap(_) => {
                if let Some(lease) = crate::hotkey::main_dispatch::native(self.app, binding)? {
                    crate::hotkey::double_tap_native::release(self.app, lease)?;
                }
            }
        }
        crate::hotkey::main_dispatch::retire(self.app, binding)?;
        crate::hotkey::main_dispatch::remove(self.app, binding)
    }
}

fn classify_registration_error(error: tauri_plugin_global_shortcut::Error) -> RegisterFailure {
    match error {
        tauri_plugin_global_shortcut::Error::GlobalHotkey(_) => RegisterFailure::Rejected,
        _ => RegisterFailure::Unavailable(HOTKEY_OUTCOME_UNKNOWN.to_owned()),
    }
}

impl TauriShortcutPort<'_> {
    fn manager(&self) -> Result<tauri::State<'_, GlobalShortcut<tauri::Wry>>, String> {
        self.app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or_else(|| HOTKEY_OUTCOME_UNKNOWN.to_owned())
    }
}

pub(crate) fn setup_owned_main_hotkey(app: &AppHandle, label: &str) -> Result<(), String> {
    with_mutating_registry(app, |registry| {
        registry.ensure_usable()?;
        ensure_main_hotkey_available(app, label)?;
        registry.setup(&mut TauriShortcutPort { app }, label)
    })
}

#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn read_owned_main_hotkey(app: &AppHandle) -> Result<OwnedMainHotkeySnapshot, String> {
    with_registry(app, |registry| registry.read(&TauriShortcutPort { app }))
}

pub(crate) fn read_owned_main_hotkey_state(
    app: &AppHandle,
) -> Result<OwnedMainHotkeyStateSnapshot, String> {
    with_registry(app, |registry| {
        registry.read_state(&TauriShortcutPort { app })
    })
}

pub(crate) fn apply_owned_main_hotkey(app: &AppHandle, label: &str) -> Result<(), String> {
    with_mutating_registry(app, |registry| {
        registry.ensure_usable()?;
        ensure_main_hotkey_available(app, label)?;
        registry.apply_state(&mut TauriShortcutPort { app }, label)
    })
}

pub(crate) fn restore_owned_main_hotkey_state(
    app: &AppHandle,
    checkpoint: &OwnedMainHotkeyStateSnapshot,
) -> Result<(), String> {
    with_mutating_registry(app, |registry| {
        registry.restore_state(&mut TauriShortcutPort { app }, checkpoint)
    })
}

pub(crate) fn mark_startup_attempted(app: &AppHandle) -> Result<(), String> {
    with_registry(app, |registry| registry.mark_startup_attempted())
}

pub(crate) fn set_owned_main_hotkey(app: &AppHandle, label: &str) -> Result<(), String> {
    with_mutating_registry(app, |registry| {
        registry.ensure_usable()?;
        ensure_main_hotkey_available(app, label)?;
        registry.set(&mut TauriShortcutPort { app }, label)
    })
}

pub(crate) fn set_owned_main_hotkey_from(
    app: &AppHandle,
    previous: &str,
    label: &str,
) -> Result<(), String> {
    with_mutating_registry(app, |registry| {
        registry.ensure_usable()?;
        let previous = parse_main_binding(previous)?;
        ensure_main_hotkey_available(app, label)?;
        registry.set_from(&mut TauriShortcutPort { app }, previous, label)
    })
}

fn ensure_main_hotkey_available(app: &AppHandle, label: &str) -> Result<(), String> {
    let candidate = parse_main_binding(label)?;
    if matches!(candidate, MainBinding::DoubleTap(_)) {
        crate::hotkey::double_tap_native::preflight()?;
    }
    let pasteboard_label = crate::hotkey::configured_pasteboard_hotkey(app);
    if let Ok(pasteboard) = parse_main_hotkey(&pasteboard_label) {
        if candidate == MainBinding::Accelerator(pasteboard) {
            return Err(HOTKEY_REJECTED.into());
        }
    }
    Ok(())
}

#[cfg(feature = "legacy-node-smoke")]
#[allow(dead_code)]
pub(crate) fn restore_owned_main_hotkey(
    app: &AppHandle,
    snapshot: &OwnedMainHotkeySnapshot,
) -> Result<(), String> {
    with_mutating_registry(app, |registry| {
        registry.restore(&mut TauriShortcutPort { app }, snapshot)
    })
}

pub(crate) fn release_owned_main_hotkey(app: &AppHandle) -> Result<(), String> {
    with_mutating_registry(app, |registry| {
        registry.release(&mut TauriShortcutPort { app })
    })
}

pub(in crate::hotkey) fn owned_registry_uses_shortcut(
    registry: &OwnedMainHotkeyRegistry,
    app: &AppHandle,
    label: &str,
) -> Result<bool, String> {
    let shortcut = parse_main_hotkey(label)?;
    registry.uses(
        &TauriShortcutPort { app },
        MainBinding::Accelerator(shortcut),
    )
}

fn with_registry<T>(
    app: &AppHandle,
    operation: impl FnOnce(&mut OwnedMainHotkeyRegistry) -> Result<T, String>,
) -> Result<T, String> {
    let coordinator = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .ok_or_else(|| "General settings coordinator is unavailable".to_owned())?;
    coordinator.with_owned_main_hotkey(|registry| {
        let result = operation(registry);
        crate::hotkey::main_dispatch::publish(app, registry.dispatch_owner());
        result
    })?
}

fn with_mutating_registry<T>(
    app: &AppHandle,
    operation: impl FnOnce(&mut OwnedMainHotkeyRegistry) -> Result<T, String>,
) -> Result<T, String> {
    let coordinator = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .ok_or_else(|| "General settings coordinator is unavailable".to_owned())?;
    coordinator.with_recording_registries(|registry, recording| {
        if coordinator.app_recording.busy() { return Err(HOTKEY_REJECTED.into()); }
        crate::hotkey::main_dispatch::publish(app, None);
        let result = crate::hotkey::recording_runtime::cancel_locked(app, recording)
            .map_err(classify_recording_mutation_error)
            .and_then(|()| operation(registry));
        crate::hotkey::main_dispatch::publish(app, registry.dispatch_owner());
        result
    })?
}


pub(in crate::hotkey) fn shutdown_locked(app: &AppHandle, registry: &mut OwnedMainHotkeyRegistry) -> Result<(), String> {
    registry.release(&mut TauriShortcutPort { app })
}

fn classify_recording_mutation_error(error: String) -> String {
    // The mutation has not run. Only this exact held-drain result proves the
    // Main registration is unchanged; unknown cleanup outcomes stay unknown.
    if error == "SETTINGS_HOTKEY_RECORDING_BUSY" {
        HOTKEY_REJECTED.to_owned()
    } else {
        error
    }
}

#[cfg(test)]
#[path = "owned_main_tauri_tests.rs"]
mod tests;
