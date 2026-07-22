use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示 ATools 3.0")
        .accelerator("Alt+Z")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "设置").build(app)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &settings, &separator, &quit])
        .build()?;

    let tray = TrayIconBuilder::with_id("atools-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("ATools 3.0")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                toggle_main_window(app);
            }
            "settings" => {
                open_settings_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    tray.set_visible(configured_tray_visible(app))?;

    Ok(())
}

fn configured_tray_visible(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return false;
    };
    let Ok(value) = state.db.get_setting("settings-general") else {
        return false;
    };
    tray_visible_from_settings(value.as_deref())
}

fn tray_visible_from_settings(value: Option<&str>) -> bool {
    value
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|json| json.get("showTrayIcon").and_then(|value| value.as_bool()))
        .unwrap_or(false)
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Err(error) = crate::window::toggle_main_window(app) {
        tracing::error!("Failed to toggle main window from tray: {error}");
    }
}

fn open_settings_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(800.0, 600.0)));
        let _ = window.center();
        window.show().ok();
        window.set_focus().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::tray_visible_from_settings;

    #[test]
    fn tray_visibility_defaults_to_false_when_setting_is_missing() {
        assert!(!tray_visible_from_settings(None));
    }

    #[test]
    fn tray_visibility_reads_saved_setting() {
        assert!(tray_visible_from_settings(Some(r#"{"showTrayIcon":true}"#)));
        assert!(!tray_visible_from_settings(Some(
            r#"{"showTrayIcon":false}"#
        )));
    }
}
