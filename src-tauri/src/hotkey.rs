use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub(crate) mod double_tap;
mod double_tap_input;
mod double_tap_native;
pub(crate) mod main_binding;
pub(crate) mod main_dispatch;
mod owned_main;
mod paste_stack;
mod paste_shelf_owner;
mod shutdown_owners;
pub(crate) mod recording;
pub(crate) mod recording_runtime;
pub(crate) use owned_main::{
    apply_owned_main_hotkey, mark_startup_attempted, read_owned_main_hotkey,
    read_owned_main_hotkey_state, release_owned_main_hotkey, restore_owned_main_hotkey,
    restore_owned_main_hotkey_state, set_owned_main_hotkey, setup_owned_main_hotkey,
    validate_main_hotkey_label, OwnedMainHotkeyRegistry, OwnedMainHotkeySnapshot,
    OwnedMainHotkeyStateSnapshot,
};
pub(crate) use paste_stack::{
    activate as activate_paste_stack_shortcut, deactivate as deactivate_paste_stack_shortcut,
};

pub(crate) const PASTE_STACK_SHORTCUT: &str = "Cmd+V";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MainHotkeyStartup {
    Registered,
    NeedsRecovery,
}

pub(crate) fn setup_hotkey(app: &AppHandle) -> tauri::Result<MainHotkeyStartup> {
    let startup = initialize_main_hotkey_from_settings(app)
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?;
    let pasteboard_shortcut = configured_pasteboard_hotkey(app);
    if let Err(error) = register_pasteboard_hotkey(app, &pasteboard_shortcut) {
        tracing::warn!(shortcut = pasteboard_shortcut, %error, "Failed to register Paste clipboard hotkey");
    }
    Ok(startup)
}

pub(crate) fn initialize_main_hotkey_from_settings(
    app: &AppHandle,
) -> Result<MainHotkeyStartup, String> {
    let shortcut = read_configured_hotkey(app)?;
    initialize_main_hotkey(
        &shortcut,
        |label| setup_owned_main_hotkey(app, label),
        || mark_startup_attempted(app),
    )
}

fn startup_status(result: Result<(), String>) -> Result<MainHotkeyStartup, String> {
    match result {
        Ok(()) => Ok(MainHotkeyStartup::Registered),
        Err(error) if known_hotkey_rejection(&error) => Ok(MainHotkeyStartup::NeedsRecovery),
        Err(error) => Err(error),
    }
}

pub fn update_hotkey(app: &AppHandle, shortcut: &str) -> tauri::Result<()> {
    set_owned_main_hotkey(app, shortcut)
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))
}

pub(crate) fn update_hotkey_from(
    app: &AppHandle,
    previous: &str,
    requested: &str,
) -> tauri::Result<()> {
    owned_main::set_owned_main_hotkey_from(app, previous, requested)
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))
}

pub(crate) fn is_shortcut_registered(app: &AppHandle, shortcut: &str) -> bool {
    let shortcut = normalize_shortcut(shortcut);
    app.global_shortcut().is_registered(shortcut.as_str())
}

/// Register a custom app/plugin direct launch shortcut
pub fn register_app_shortcut(
    app: &AppHandle,
    shortcut: &str,
    target_code: &str,
) -> tauri::Result<()> {
    crate::general_settings_runtime::register_app_shortcut(app, shortcut, target_code)
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))
}

fn register_pasteboard_hotkey(app: &AppHandle, shortcut: &str) -> tauri::Result<()> {
    let coordinator = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .ok_or_else(|| {
            tauri::Error::Anyhow(anyhow::anyhow!(
                "General settings coordinator is unavailable"
            ))
        })?;
    coordinator
        .with_hotkey_operation(|| register_pasteboard_hotkey_unlocked(app, shortcut))
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))
}

fn register_pasteboard_hotkey_unlocked(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let handle = app.clone();
    let shortcut = normalize_shortcut(shortcut);
    if app.global_shortcut().is_registered(shortcut.as_str()) {
        return Err("Paste clipboard shortcut is registered by another ATools feature".into());
    }
    let gate = crate::app_global_shortcuts::recording::gate(app)?;
    let receipt = gate.receipt(None)?;
    app.manage(paste_shelf_owner::Runtime::default());
    let owner = app.state::<paste_shelf_owner::Runtime>();
    let callback_receipt = receipt.clone();
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), move |_app, _shortcut, event| {
            if let Some(epoch) = callback_receipt.edge(event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed) {
                let app = handle.clone();
                let receipt = std::sync::Arc::downgrade(&callback_receipt);
                tauri::async_runtime::spawn(async move {
                    let target = app.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        let Some(receipt) = receipt.upgrade() else { return; };
                        let Some(_permit) = receipt.admit(epoch) else { return; };
                        drop(receipt);
                        if let Err(error) = crate::pasteboard_window::toggle_pasteboard_shelf(&target) {
                            tracing::error!(%error, "Failed to toggle Paste clipboard shelf from global shortcut");
                        }
                    }) { tracing::error!(%error, "Paste clipboard shortcut action could not be scheduled"); }
                });
            }
        })
        .map_err(|_| "Paste clipboard shortcut registration failed".to_owned())?;
    *owner.shortcut.lock() = Some(shortcut.clone());
    if !app.global_shortcut().is_registered(shortcut.as_str()) {
        return Err("Paste clipboard shortcut registration readback failed".into());
    }
    receipt.publish();
    tracing::info!(shortcut, "Paste clipboard global shortcut registered");
    Ok(())
}

/// The caller holds the OS operation lease and has permanently closed the App gate.
pub(crate) fn shutdown_recording_owners(app: &AppHandle) -> Result<(), String> {
    let c = app.try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .ok_or("General settings coordinator is unavailable")?;
    c.with_shutdown_registries(|features, main, stack, recording| {
        shutdown_owners::run(
            |withdrawn| recording_runtime::shutdown_locked(app, recording, withdrawn),
            || crate::general_settings_runtime::shutdown_feature_shortcuts_locked(app, features),
            || owned_main::shutdown_locked(app, main),
            || paste_stack::shutdown_locked(app, stack),
            || paste_shelf_owner::shutdown(app),
        )
    })
}

pub(crate) fn configured_hotkey(app: &AppHandle) -> String {
    read_configured_hotkey(app).unwrap_or_default()
}

fn read_configured_hotkey(app: &AppHandle) -> Result<String, String> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| "Application state is unavailable for hotkey startup".to_owned())?;
    let raw = state
        .db
        .get_setting("settings-general")
        .map_err(|_| "General settings could not be read for hotkey startup".to_owned())?;
    configured_hotkey_from_settings(raw.as_deref())
}

fn configured_hotkey_from_settings(raw: Option<&str>) -> Result<String, String> {
    let Some(raw) = raw else {
        return Ok(default_hotkey_label().to_owned());
    };
    let value = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|_| "General settings JSON is invalid for hotkey startup".to_owned())?;
    let settings = value
        .as_object()
        .ok_or_else(|| "General settings must be an object for hotkey startup".to_owned())?;
    match settings.get("hotkey") {
        None => Ok(default_hotkey_label().to_owned()),
        Some(serde_json::Value::String(label)) => Ok(label.clone()),
        Some(_) => Ok(String::new()),
    }
}

pub(crate) fn configured_pasteboard_hotkey(app: &AppHandle) -> String {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return default_pasteboard_hotkey_label().to_string();
    };
    let Ok(Some(value)) = state.db.get_setting("settings-general") else {
        return default_pasteboard_hotkey_label().to_string();
    };
    serde_json::from_str::<serde_json::Value>(&value)
        .ok()
        .and_then(|json| {
            json.get("pasteboardHotkey")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_pasteboard_hotkey_label().to_string())
}

fn default_pasteboard_hotkey_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Shift+Cmd+V"
    } else {
        "Shift+Alt+V"
    }
}

fn default_hotkey_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Option+Z"
    } else {
        "Alt+Z"
    }
}

pub(crate) fn normalize_shortcut(shortcut: &str) -> String {
    shortcut
        .trim()
        .replace("Option+", "Alt+")
        .replace("option+", "Alt+")
        .replace("Command+", "Cmd+")
        .replace("command+", "Cmd+")
}

pub(crate) fn toggle_main_window(app: &AppHandle) -> tauri::Result<bool> {
    #[cfg(feature = "ztools-multiwebview")]
    crate::window::cancel_auto_back_on_show(app);
    let is_visible = crate::window::main_window(app)?.is_visible()?;
    if !is_visible && wakeup_blacklisted(app) {
        return Ok(false);
    }
    crate::window::toggle_main_window(app)
}

fn wakeup_blacklisted(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return false;
    };
    let settings = state.db.get_setting("settings-general").ok().flatten();
    should_suppress_wakeup_for_foreground_app(
        settings.as_deref(),
        read_foreground_app_name().as_deref(),
    )
}

fn should_suppress_wakeup_for_foreground_app(
    settings_json: Option<&str>,
    foreground_app: Option<&str>,
) -> bool {
    let foreground_app = normalize_wakeup_app_name(foreground_app.unwrap_or_default());
    if foreground_app.is_empty() {
        return false;
    }
    wakeup_blacklist_from_settings(settings_json)
        .iter()
        .any(|app| normalize_wakeup_app_name(app) == foreground_app)
}

fn wakeup_blacklist_from_settings(settings_json: Option<&str>) -> Vec<String> {
    let Some(settings_json) = settings_json else {
        return Vec::new();
    };
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()
        .and_then(|json| json.get("wakeupBlacklist").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_wakeup_app_name(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(crate) fn read_foreground_app_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;

        let workspace = NSWorkspace::sharedWorkspace();
        let value = workspace
            .frontmostApplication()?
            .localizedName()?
            .to_string();
        let value = value.trim().to_string();
        return (!value.is_empty()).then_some(value);
    }

    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(test)]
#[path = "hotkey/tests.rs"]
mod tests;

pub(crate) fn known_hotkey_rejection(error: &str) -> bool {
    matches!(
        error,
        "SETTINGS_HOTKEY_REJECTED"
            | "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED"
            | "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED"
    )
}

fn initialize_main_hotkey(
    label: &str,
    setup: impl FnOnce(&str) -> Result<(), String>,
    mark: impl FnOnce() -> Result<(), String>,
) -> Result<MainHotkeyStartup, String> {
    let startup = startup_status(setup(label))?;
    mark()?;
    Ok(startup)
}

pub(crate) fn toggle_main_window_from_double_tap(app: &AppHandle) -> tauri::Result<bool> {
    let window = crate::window::main_window(app)?;
    if window.is_visible()? && window.is_focused()? {
        crate::window::hide_main_window(app)?;
        return Ok(false);
    }
    if wakeup_blacklisted(app) {
        return Ok(false);
    }
    #[cfg(feature = "ztools-multiwebview")]
    crate::window::cancel_auto_back_on_show(app);
    let previous = crate::window::suppress_double_tap_blur(app);
    if let Err(error) = crate::window::show_main_window(app) {
        crate::window::restore_double_tap_blur(app, previous);
        return Err(error);
    }
    Ok(true)
}
