//! Route lifecycle observations to the selected isolated acceptance journey.

use tauri::{webview::PageLoadPayload, Manager, Webview, Window, WindowEvent, Wry};

use super::{catalog_journey, controller};

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    if webview
        .app_handle()
        .try_state::<super::updater_journey::Harness>()
        .is_some()
    {
        super::updater_journey::on_page_load(webview, payload);
        return;
    }
    if super::manual_ui::active(webview.app_handle()) {
        return;
    }
    if super::clipboard_context_wiring::on_page_load(webview, payload) {
        return;
    }
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    if webview
        .app_handle()
        .try_state::<super::main_panel_journey::Harness>()
        .is_some()
    {
        super::main_panel_journey::on_page_load(webview, payload);
        return;
    }
    #[cfg(feature = "ztools-multiwebview")]
    if webview
        .app_handle()
        .try_state::<super::settings_input_journey::Harness>()
        .is_some()
    {
        super::settings_input_journey::on_page_load(webview, payload);
        return;
    }
    #[cfg(feature = "legacy-node-smoke")]
    if webview
        .app_handle()
        .try_state::<super::launch_return_journey::Harness>()
        .is_some()
    {
        super::launch_return_journey::on_page_load(webview, payload);
        return;
    }
    if webview
        .app_handle()
        .try_state::<catalog_journey::Harness>()
        .is_some()
    {
        catalog_journey::on_page_load(webview, payload);
    } else {
        controller::on_page_load(webview, payload);
    }
}

pub(super) fn on_window_event(window: &Window<Wry>, event: &WindowEvent) {
    if window
        .app_handle()
        .try_state::<super::updater_journey::Harness>()
        .is_some()
    {
        super::updater_journey::on_window_event(window, event);
        return;
    }
    if super::manual_ui::active(window.app_handle()) {
        return;
    }
    if super::clipboard_context_wiring::active(window.app_handle()) {
        return;
    }
    // The panel journey observes AppKit activation/key notifications itself.
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    if window
        .app_handle()
        .try_state::<super::main_panel_journey::Harness>()
        .is_some()
    {
        if window.label() == "main"
            && crate::window::macos_main_panel::is_active(window.app_handle())
        {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
        }
        return;
    }
    #[cfg(feature = "ztools-multiwebview")]
    if window
        .app_handle()
        .try_state::<super::settings_input_journey::Harness>()
        .is_some()
    {
        super::settings_input_journey::record_window_event(window, event);
        return;
    }
    #[cfg(feature = "legacy-node-smoke")]
    if window
        .app_handle()
        .try_state::<super::launch_return_journey::Harness>()
        .is_some()
    {
        super::launch_return_journey::record_window_event(window, event);
        return;
    }
    if window
        .app_handle()
        .try_state::<catalog_journey::Harness>()
        .is_some()
    {
        catalog_journey::record_window_event(window, event);
    } else {
        controller::record_window_event(window, event);
    }
}

// Ready dispatch shares the same journey selection as page/window observations.
pub(super) fn start(app: &tauri::AppHandle, builtin_state_enabled: bool) -> bool {
    if app.try_state::<super::updater_journey::Harness>().is_some() {
        super::updater_journey::start(app.clone());
        return true;
    }

    if super::manual_ui::start(app) {
        return true;
    }
    if super::clipboard_context_wiring::start_if_enabled(app) {
        return true;
    }
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    if app
        .try_state::<super::main_panel_journey::Harness>()
        .is_some()
    {
        super::main_panel_journey::start(app.clone());
        return true;
    }
    #[cfg(feature = "ztools-multiwebview")]
    if app
        .try_state::<super::settings_input_journey::Harness>()
        .is_some()
    {
        #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
        if builtin_state_enabled {
            super::settings_input_journey::start_builtin_state(app.clone());
            return true;
        }
        super::settings_input_journey::start(app.clone());
        return true;
    }
    #[cfg(feature = "legacy-node-smoke")]
    if app
        .try_state::<super::launch_return_journey::Harness>()
        .is_some()
    {
        super::launch_return_journey::start(app.clone());
    } else if app.try_state::<catalog_journey::Harness>().is_some() {
        catalog_journey::start(app.clone());
    } else {
        controller::start(app.clone());
    }
    #[cfg(not(feature = "legacy-node-smoke"))]
    if app.try_state::<catalog_journey::Harness>().is_some() {
        catalog_journey::start(app.clone());
    } else {
        controller::start(app.clone());
    }
    false
}
