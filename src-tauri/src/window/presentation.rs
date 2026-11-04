use tauri::AppHandle;

use super::{
    activation, main_window, position_main_window, position_main_window_for_foreground,
    prepare_main_window_for_macos_spaces,
};

pub(super) enum ShowIntent {
    Startup,
    Foreground,
}

pub(crate) fn main_panel_active(app: &AppHandle) -> bool {
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    {
        super::macos_main_panel::is_active(app)
    }
    #[cfg(not(all(target_os = "macos", feature = "macos-main-panel-prototype")))]
    {
        let _ = app;
        false
    }
}

pub(super) fn show_main_window(app: &AppHandle, intent: ShowIntent) -> tauri::Result<()> {
    #[cfg(feature = "ztools-multiwebview")]
    super::cancel_auto_back_on_show(app);
    let window = main_window(app)?;
    if matches!(intent, ShowIntent::Foreground) {
        crate::host_runtime::capture_external_target_before_show();
    }
    if matches!(intent, ShowIntent::Foreground) {
        position_main_window_for_foreground(app, &window)?;
    } else {
        position_main_window(app, &window)?;
    }
    let panel_active = main_panel_active(app);
    if !panel_active {
        prepare_main_window_for_macos_spaces(&window)?;
    }
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    if panel_active {
        return super::macos_main_panel::show_scoped(app)
            .map_err(|error| std::io::Error::other(error).into());
    }
    window.show()?;
    crate::renderer_main_drop::resume(app);
    if matches!(intent, ShowIntent::Foreground) && !panel_active {
        // Tao makes this window key and requests application activation.
        // An earlier NSRunningApplication request may be declined before
        // the window is key, preventing the focus request from ever running.
        window.set_focus()?;
        activation::activate_current_application(app)?;
    }
    Ok(())
}
