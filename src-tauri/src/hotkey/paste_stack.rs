use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcut, GlobalShortcutExt, ShortcutState};

use super::PASTE_STACK_SHORTCUT;

enum Activation {
    AlreadyOwned,
    Register,
}

enum Deactivation {
    AlreadyInactive,
    Unregister,
}

fn activation(owned: bool, registered: bool, primary_owned: bool) -> Result<Activation, String> {
    if owned {
        return if registered {
            Ok(Activation::AlreadyOwned)
        } else {
            Err("Owned Paste Stack shortcut is missing from the application manager".into())
        };
    }
    if primary_owned {
        return Err("Paste Stack shortcut conflicts with the owned main hotkey".into());
    }
    if registered {
        return Err("Paste Stack shortcut is registered by another ATools feature".into());
    }
    Ok(Activation::Register)
}

fn deactivation(owned: bool, registered: bool) -> Result<Deactivation, String> {
    if !owned {
        return if registered {
            Err("Paste Stack shortcut is registered by another ATools feature".into())
        } else {
            Ok(Deactivation::AlreadyInactive)
        };
    }
    if registered {
        Ok(Deactivation::Unregister)
    } else {
        Err("Owned Paste Stack shortcut is missing from the application manager".into())
    }
}

pub(crate) fn activate(app: &AppHandle) -> tauri::Result<()> {
    let coordinator = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .ok_or_else(|| {
            tauri::Error::Anyhow(anyhow::anyhow!(
                "General settings coordinator is unavailable"
            ))
        })?;
    coordinator
        .with_hotkey_registries(|primary, owned| {
            let registered = is_registered(app)?;
            let primary_owned = if *owned {
                false
            } else {
                super::owned_main::owned_registry_uses_shortcut(primary, app, PASTE_STACK_SHORTCUT)?
            };
            match activation(*owned, registered, primary_owned)? {
                Activation::AlreadyOwned => Ok(()),
                Activation::Register => register_owned(app, owned),
            }
        })
        .and_then(|result| result)
        .map_err(|error: String| tauri::Error::Anyhow(anyhow::anyhow!(error)))
}

pub(crate) fn deactivate(app: &AppHandle) -> tauri::Result<()> {
    let coordinator = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .ok_or_else(|| {
            tauri::Error::Anyhow(anyhow::anyhow!(
                "General settings coordinator is unavailable"
            ))
        })?;
    coordinator
        .with_hotkey_registries(|_primary, owned| {
            match deactivation(*owned, is_registered(app)?)? {
                Deactivation::AlreadyInactive => Ok(()),
                Deactivation::Unregister => {
                    let _ = app.global_shortcut().unregister(PASTE_STACK_SHORTCUT);
                    if is_registered(app)? {
                        Err("Owned Paste Stack shortcut could not be suspended".into())
                    } else {
                        *owned = false;
                        Ok(())
                    }
                }
            }
        })
        .and_then(|result| result)
        .map_err(|error: String| tauri::Error::Anyhow(anyhow::anyhow!(error)))
}

pub(super) fn shutdown_locked(app: &AppHandle, owned: &mut bool) -> Result<(), String> {
    if *owned {
        app.global_shortcut().unregister(PASTE_STACK_SHORTCUT).map_err(|_| "Paste Stack unregister failed")?;
        if is_registered(app)? { return Err("Paste Stack unregister readback failed".into()); }
        *owned = false;
    }
    Ok(())
}

fn register_owned(app: &AppHandle, owned: &mut bool) -> Result<(), String> {
    match register(app) {
        Ok(receipt) => {
            *owned = true;
            if is_registered(app)? {
                receipt.publish();
                Ok(())
            } else {
                Err("Owned Paste Stack shortcut registration readback failed".into())
            }
        }
        Err(error) => {
            if is_registered(app)? {
                Err(
                    "Paste Stack shortcut ownership is indeterminate after registration failure"
                        .into(),
                )
            } else {
                Err(error)
            }
        }
    }
}

fn is_registered(app: &AppHandle) -> Result<bool, String> {
    app.try_state::<GlobalShortcut<tauri::Wry>>()
        .map(|manager| manager.inner().is_registered(PASTE_STACK_SHORTCUT))
        .ok_or_else(|| "Global shortcut manager is unavailable".into())
}

fn register(app: &AppHandle) -> Result<std::sync::Arc<crate::app_global_shortcuts::recording_gate::Receipt>, String> {
    let handle = app.clone();
    let gate = crate::app_global_shortcuts::recording::gate(app)?;
    let receipt = gate.receipt(None)?;
    let callback_receipt = receipt.clone();
    app.global_shortcut()
        .on_shortcut(PASTE_STACK_SHORTCUT, move |_app, _shortcut, event| {
            let Some(epoch) = callback_receipt.edge(event.state == ShortcutState::Pressed) else { return; };
            let handle = handle.clone();
            let receipt = std::sync::Arc::downgrade(&callback_receipt);
            tauri::async_runtime::spawn(async move {
                let Some(receipt) = receipt.upgrade() else { return; };
                let Some(_permit) = receipt.admit(epoch) else { return; };
                drop(receipt);
                if let Err(error) = deactivate(&handle) {
                    tracing::warn!(%error, "Failed to suspend Paste Stack shortcut");
                    return;
                }
                let state = handle.state::<crate::state::AppState>();
                let Some(item_id) = state.pasteboard_runtime.pop_paste_stack_item() else {
                    let status = state.pasteboard_runtime.paste_stack_status();
                    let _ = handle.emit("pasteboard://stack", status);
                    return;
                };
                let result = state.pasteboard_runtime.paste_item(&item_id, false).await;
                let status = state.pasteboard_runtime.paste_stack_status();
                let _ = handle.emit("pasteboard://stack", &status);
                if let Err(error) = result {
                    tracing::error!(%error, item_id, "Paste Stack item failed");
                }
                if status.active {
                    if let Err(error) = activate(&handle) {
                        tracing::error!(%error, "Failed to re-arm Paste Stack shortcut");
                    }
                }
            });
        })
        .map_err(|_| "Paste Stack shortcut registration failed".to_owned())?;
    Ok(receipt)
}

#[cfg(test)]
#[path = "paste_stack_tests.rs"]
mod tests;
