pub(crate) mod app_shortcut_registry;
mod app_shortcuts;
mod auto_check_effect;
mod close_shortcut_effect;
pub(crate) mod commands;
mod coordinator;
mod effects;
pub(crate) mod login_items;
mod renderer_native_effect_transaction;
mod renderer_native_hotkey_effect;
mod settings;
mod system_effects;
mod transaction;

pub(crate) use app_shortcut_registry::OwnedAppShortcutSnapshot;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use app_shortcuts::register_app_shortcut;
pub(crate) use app_shortcuts::{replace_app_shortcuts, restore_app_shortcuts};
pub(crate) use commands::{read_general_settings, run_renderer_patch};
pub(crate) use coordinator::{GeneralSettingsCoordinator, HotkeyOperationLease};

pub(crate) const GENERAL_SETTINGS_EVENT: &str = "atools://renderer-general-settings";

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct GeneralSettingsEvent {
    version: u8,
    raw: String,
}

/// Notify Main using the same bounded projection as its startup settings snapshot.
pub(crate) fn emit_projected_general_settings(app: &tauri::AppHandle, raw: &str) -> bool {
    auto_check_effect::committed(app, raw);
    emit_general_projection(app, raw)
}
pub(super) fn emit_general_projection(app: &tauri::AppHandle, raw: &str) -> bool {
    use tauri::{Emitter, EventTarget};
    crate::renderer_updater::general_committed(app, raw);
    let Ok(raw) = crate::renderer_settings::project_general_settings(raw) else {
        return false;
    };
    app.emit_to(
        EventTarget::webview("main"),
        GENERAL_SETTINGS_EVENT,
        GeneralSettingsEvent { version: 1, raw },
    )
    .is_ok()
}

pub(crate) use app_shortcuts::shutdown_locked as shutdown_feature_shortcuts_locked;
