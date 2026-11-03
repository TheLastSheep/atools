use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};

use super::OwnedAppShortcutSnapshot;
use crate::commands::SyncAppShortcutPayload;

pub(super) use super::app_shortcut_registry::{
    parse_desired, OwnedAppShortcutRegistry, ShortcutPort,
};

struct TauriShortcutPort<'a> {
    app: &'a AppHandle,
}

impl ShortcutPort for TauriShortcutPort<'_> {
    fn is_registered(&self, shortcut: Shortcut) -> Result<bool, String> {
        let manager = self
            .app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or_else(|| "Global shortcut plugin is unavailable".to_owned())?;
        Ok(manager.inner().is_registered(shortcut))
    }

    fn register(&mut self, shortcut: Shortcut, target_code: &String) -> Result<(), String> {
        let manager = self
            .app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or_else(|| "Global shortcut plugin is unavailable".to_owned())?;
        let handle = self.app.clone();
        let code = target_code.to_owned();
        let gate = crate::app_global_shortcuts::recording::gate(self.app)?;
        let receipt = gate.receipt(None)?;
        let callback_receipt = receipt.clone();
        manager
            .inner()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                let Some(epoch) = callback_receipt.edge(event.state == ShortcutState::Pressed) else {
                    return;
                };
                let handle = handle.clone();
                let receipt = std::sync::Arc::downgrade(&callback_receipt);
                let code = code.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(owner) = receipt.upgrade() else { return; };
                    let Some(permit) = owner.admit(epoch) else { return; };
                    drop(owner);
                    let permit = std::sync::Arc::new(permit);
                    let state = handle.state::<crate::state::AppState>();
                    let Ok(action) = crate::commands::activate_feature_inner(&state.db, &code, None) else { return; };
                    let _ = crate::window::expand_window(&handle, action.expand_height);
                    if let Err(error) = crate::window::show_main_window(&handle) {
                        tracing::error!(%error, "Failed to show main window for app shortcut");
                        return;
                    }
                    let Some(view) = crate::app_global_shortcuts::feature_dispatch::main_webview(&handle) else { return; };
                    let dispatch = match crate::app_global_shortcuts::feature_dispatch::offer(
                        &handle, &view, code.clone(), action.plugin_id.clone(), receipt, epoch, permit,
                    ) { Ok(id) => id, Err(_) => return };
                    if view.emit_to(tauri::EventTarget::webview("main"), "atools://direct-launch-plugin", serde_json::json!({
                        "code": code, "pluginId": action.plugin_id, "shortcutDispatchId": dispatch,
                    })).is_err() {
                        crate::app_global_shortcuts::feature_dispatch::cancel_offer(&handle, &dispatch);
                    }
                });
            })
            .map_err(|error| error.to_string())?;
        crate::app_global_shortcuts::feature_dispatch::publish_registration(self.app, shortcut.id(), &receipt)?;
        if !manager.inner().is_registered(shortcut) {
            return Err("App shortcut registration readback failed".into());
        }
        receipt.publish();
        Ok(())
    }

    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
        let manager = self
            .app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or_else(|| "Global shortcut plugin is unavailable".to_owned())?;
        manager.inner().unregister(shortcut).map_err(|error| error.to_string())?;
        if manager.inner().is_registered(shortcut) { return Err("App shortcut unregister readback failed".into()); }
        crate::app_global_shortcuts::feature_dispatch::retire_registration(self.app, shortcut.id())
    }
}

pub(crate) fn shutdown_locked(app: &AppHandle, registry: &mut OwnedAppShortcutRegistry) -> Result<(), String> {
    registry.replace_all(&mut TauriShortcutPort { app }, Default::default()).map(|_| ())
}

fn with_registry<T>(
    app: &AppHandle,
    operation: impl FnOnce(&mut OwnedAppShortcutRegistry) -> Result<T, String>,
) -> Result<T, String> {
    let coordinator = app
        .try_state::<super::coordinator::GeneralSettingsCoordinator>()
        .ok_or_else(|| {
            "General settings coordinator is unavailable in this app instance".to_owned()
        })?;
    coordinator.inner().with_app_shortcuts(operation)?
}

pub(crate) fn register_app_shortcut(
    app: &AppHandle,
    shortcut: &str,
    target_code: &str,
) -> Result<(), String> {
    with_registry(app, |registry| {
        registry.register_single(&mut TauriShortcutPort { app }, shortcut, target_code)
    })
}

pub(crate) fn replace_app_shortcuts(
    app: &AppHandle,
    shortcuts: &[SyncAppShortcutPayload],
) -> Result<OwnedAppShortcutSnapshot, String> {
    let desired = parse_desired(shortcuts)?;
    with_registry(app, |registry| {
        registry.replace_all(&mut TauriShortcutPort { app }, desired)
    })
}

pub(crate) fn restore_app_shortcuts(
    app: &AppHandle,
    snapshot: OwnedAppShortcutSnapshot,
) -> Result<(), String> {
    with_registry(app, |registry| {
        registry.restore_snapshot(&mut TauriShortcutPort { app }, snapshot)
    })
}

#[cfg(test)]
#[path = "app_shortcuts_tests.rs"]
mod tests;
