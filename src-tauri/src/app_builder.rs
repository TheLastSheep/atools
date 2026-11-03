//! Shared host transport and production-only desktop plugin registration.

use tauri::{Builder, Wry};

use crate::{
    app_lifecycle, command_registry, plugin_asset_protocol, plugin_page_runtime, state::AppState,
    updater,
};

/// The actual command registry and window lifecycle used by the desktop host.
pub(super) fn host_builder(state: AppState) -> Builder<Wry> {
    let builder = crate::renderer_window_drag::register(
        crate::launcher_app_catalog_watch::register(crate::launcher_app_icons::register(
            plugin_page_runtime::register(plugin_asset_protocol::register(Builder::default())),
        )),
    )
    .manage(state)
    .manage(crate::hotkey::main_dispatch::Runtime::default())
    .manage(crate::window::TransientBlurGuard::default())
    .manage(crate::general_settings_runtime::GeneralSettingsCoordinator::default())
    .manage(updater::UpdateCoordinator::default())
    .on_window_event(app_lifecycle::on_window_event);
    #[cfg(feature = "ztools-multiwebview")]
    let builder = builder.manage(crate::window::AutoBackController::default());
    #[cfg(feature = "ztools-multiwebview")]
    let builder = crate::renderer_settings_view::register(builder);
    command_registry::register(crate::renderer_updater::register(
        crate::renderer_close_shortcut::register(builder),
    ))
}

/// Native service plugins belong to the ordinary desktop startup. Isolated
/// renderer acceptance uses the same host without initializing these services.
pub(super) fn with_desktop_plugins(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::sdk_host_marker())
}
