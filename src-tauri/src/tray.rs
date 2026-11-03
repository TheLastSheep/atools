use atools_core::db::DEFAULT_SHOW_TRAY_ICON;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    Manager,
};

pub(crate) const TRAY_ID: &str = "atools-tray";

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    if configured_tray_visible(app).map_err(setup_error)? {
        set_visible(app, true).map_err(setup_error)?;
    } else if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(false)?;
    }
    Ok(())
}

/// Retains the legacy platform setter while reusing one registered icon and menu.
pub(crate) fn set_visible(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        let tray = ensure_tray_icon(app)?;
        tray.set_visible(true).map_err(|error| error.to_string())
    } else if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(false).map_err(|error| error.to_string())
    } else {
        // A false setting at startup intentionally has no tray object to hide.
        Ok(())
    }
}

fn ensure_tray_icon(app: &tauri::AppHandle) -> Result<TrayIcon<tauri::Wry>, String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        return Ok(tray);
    }
    build_tray_icon(app).map_err(|error| error.to_string())
}

fn build_tray_icon(app: &tauri::AppHandle) -> tauri::Result<TrayIcon<tauri::Wry>> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("Default window icon is unavailable"))?;
    let show = MenuItemBuilder::with_id("show", "显示 ATools 3.0")
        .accelerator("Alt+Z")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "设置").build(app)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &settings, &separator, &quit])
        .build()?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("ATools 3.0")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => toggle_main_window(app),
            "settings" => open_settings_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
}

fn configured_tray_visible(app: &tauri::AppHandle) -> Result<bool, String> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| "Application state is unavailable for tray configuration".to_owned())?;
    let value = state
        .db
        .read_renderer_general_settings()
        .map_err(|_| "Tray visibility configuration could not be read".to_owned())?;
    tray_visible_from_settings(value.as_deref())
}

fn tray_visible_from_settings(value: Option<&str>) -> Result<bool, String> {
    let Some(raw) = value else {
        return Ok(DEFAULT_SHOW_TRAY_ICON);
    };
    let settings = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|_| "Tray visibility configuration is invalid JSON".to_owned())?;
    let settings = settings
        .as_object()
        .ok_or_else(|| "Tray visibility configuration must be an object".to_owned())?;
    match settings.get("showTrayIcon") {
        None => Ok(DEFAULT_SHOW_TRAY_ICON),
        Some(serde_json::Value::Bool(visible)) => Ok(*visible),
        Some(_) => Err("Tray visibility configuration must be a boolean".into()),
    }
}

fn setup_error(error: String) -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(error))
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
    use atools_core::db::DEFAULT_SHOW_TRAY_ICON;

    #[test]
    fn missing_tray_setting_uses_the_shared_true_default() {
        assert!(DEFAULT_SHOW_TRAY_ICON);
        assert_eq!(tray_visible_from_settings(None), Ok(true));
        assert_eq!(tray_visible_from_settings(Some("{}")), Ok(true));
    }

    #[test]
    fn explicit_tray_visibility_is_preserved() {
        assert_eq!(
            tray_visible_from_settings(Some(r#"{"showTrayIcon":true}"#)),
            Ok(true)
        );
        assert_eq!(
            tray_visible_from_settings(Some(r#"{"showTrayIcon":false}"#)),
            Ok(false)
        );
    }

    #[test]
    fn malformed_tray_configuration_is_an_error_not_a_hidden_default() {
        for value in [
            Some("not-json"),
            Some("[]"),
            Some(r#"{"showTrayIcon":null}"#),
        ] {
            assert!(tray_visible_from_settings(value).is_err());
        }
    }
}
