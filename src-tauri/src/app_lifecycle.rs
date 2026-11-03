//! Production window and shutdown handling, shared by isolated native acceptance.
use crate::{
    app_setup, host_runtime, legacy_runtime, pasteboard_window, plugin_ai_runtime,
    plugin_asset_protocol, plugin_browser_window_runtime, plugin_data_runtime,
    plugin_detach_runtime, plugin_dialog_runtime, plugin_display_runtime, plugin_file_drop,
    plugin_lifecycle, plugin_main_push, plugin_page_runtime, plugin_secret_storage_runtime,
    plugin_system_paths, state::AppState,
};
use std::sync::Arc;
use tauri::Manager;

pub(super) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Focused(_)) {
        crate::renderer_close_shortcut::focus_changed(window.app_handle());
    }
    #[cfg(feature = "ztools-multiwebview")]
    crate::window::handle_main_child_layout_event(window, event);

    match event {
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position })
            if window.label() == "main" =>
        {
            if let Ok(scale) = window.scale_factor() {
                plugin_file_drop::on_native_drop(
                    window.app_handle(),
                    window.label(),
                    paths.to_vec(),
                    position.x,
                    position.y,
                    scale,
                );
            }
        }
        tauri::WindowEvent::Destroyed => {
            if window.label() == "main" {
                crate::app_global_shortcuts::feature_dispatch::destroy_main(window);
            }
            #[cfg(feature = "ztools-multiwebview")]
            if window.label() == "main" {
                crate::renderer_settings_view::on_main_window_destroyed(window);
                crate::renderer_main_drop::stop(window.app_handle());
                crate::window::stop_auto_back(window.app_handle());
            }
            #[cfg(feature = "ztools-multiwebview")]
            if window.label() != "main" {
                crate::renderer_settings_view::on_window_destroyed(
                    window.app_handle(),
                    window.label(),
                );
            }
            crate::renderer_window_material::on_window_destroyed(
                window.app_handle(),
                window.label(),
            );
            plugin_browser_window_runtime::close_window(window.app_handle(), window.label());
            plugin_detach_runtime::close_window(window.app_handle(), window.label());
            plugin_main_push::close_window(window.app_handle(), window.label());
            plugin_page_runtime::close_window(window.app_handle(), window.label());
            plugin_asset_protocol::close_window(window.app_handle(), window.label());
            let app = window.app_handle().clone();
            let label = window.label().to_string();
            tauri::async_runtime::spawn(async move {
                plugin_lifecycle::close_window_resources(&app, &label).await;
            });
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if window.label() == "main" {
                if crate::renderer_close_shortcut::main_window_request(window.app_handle()) {
                    api.prevent_close();
                    return;
                }
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    plugin_dialog_runtime::close_window(&app, "main").await;
                });
                crate::window::remember_main_window_position(window);
                crate::renderer_window_drag::clear(window.app_handle());
                if window.hide().is_ok() {
                    #[cfg(feature = "ztools-multiwebview")]
                    crate::window::main_window_hidden(window.app_handle());
                }
                api.prevent_close();
            }
        }
        tauri::WindowEvent::Focused(focused) if window.label() == "main" && !focused => {
            let release_smoke_enabled = window
                .app_handle()
                .state::<AppState>()
                .release_smoke
                .lock()
                .is_some();
            if !crate::window::transient_blur_suppressed(window.app_handle())
                && !release_smoke_enabled
                && !app_setup::visual_smoke_enabled()
                && !plugin_dialog_runtime::modal_active(window.app_handle(), window.label())
                && !crate::renderer_context_menu::popup_active(window.app_handle())
            {
                crate::window::hide_main_window(window.app_handle()).ok();
            }
        }
        tauri::WindowEvent::Focused(false)
            if window.label() == pasteboard_window::PASTEBOARD_SHELF_LABEL =>
        {
            if !app_setup::pasteboard_shelf_smoke_enabled() {
                window.hide().ok();
            }
        }
        _ => {}
    }
}

pub(super) fn on_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if crate::app_global_shortcuts::request_exit(app_handle, code.unwrap_or(0)) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            #[cfg(feature = "ztools-multiwebview")]
            crate::renderer_settings_view::revoke_main_for_shutdown(app_handle);
            crate::renderer_updater::stop(app_handle);
            crate::renderer_main_drop::stop(app_handle);
            crate::renderer_close_shortcut::stop(app_handle);
            crate::hotkey::main_dispatch::quiesce(app_handle);
            crate::hotkey::recording_runtime::shutdown(app_handle);
            if let Err(error) = crate::hotkey::release_owned_main_hotkey(app_handle) {
                tracing::error!(%error, "Owned Main hotkey shutdown was incomplete");
            }
            #[cfg(feature = "ztools-multiwebview")]
            crate::window::stop_auto_back(app_handle);
            #[cfg(feature = "ztools-multiwebview")]
            crate::renderer_settings_view::stop(app_handle);
            if let Err(error) = crate::renderer_window_material::stop(app_handle) {
                tracing::error!(%error, "Window material shutdown was incomplete");
            }
            plugin_browser_window_runtime::stop(app_handle);
            plugin_detach_runtime::clear_all(app_handle);
            plugin_file_drop::stop_on_main_thread(app_handle);
            crate::plugin_file_drag::stop_on_main_thread(app_handle);
            tauri::async_runtime::block_on(plugin_file_drop::stop(app_handle));
            tauri::async_runtime::block_on(crate::plugin_file_drag::stop(app_handle));
            tauri::async_runtime::block_on(plugin_ai_runtime::stop(app_handle));
            plugin_dialog_runtime::stop_on_main_thread(app_handle);
            tauri::async_runtime::block_on(plugin_dialog_runtime::stop(app_handle));
            plugin_system_paths::stop(app_handle);
            tauri::async_runtime::block_on(plugin_display_runtime::stop(app_handle));
            tauri::async_runtime::block_on(plugin_data_runtime::stop(app_handle));
            tauri::async_runtime::block_on(plugin_secret_storage_runtime::stop(app_handle));
            if crate::plugin_background_runtime::is_installed(app_handle) {
                if let Err(error) = tauri::async_runtime::block_on(
                    crate::plugin_background_runtime::stop(app_handle),
                ) {
                    tracing::error!(%error, "Background plugin shutdown was incomplete");
                }
            }
            if let Ok(runtime) = host_runtime::manager(app_handle) {
                tauri::async_runtime::block_on(runtime.close(None, None, true));
            }
            if let Some(runtime) = app_handle.try_state::<Arc<legacy_runtime::Sessions>>() {
                tauri::async_runtime::block_on(runtime.stop_all());
            }
        }
        _ => {}
    }
}
