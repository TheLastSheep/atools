use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use url::form_urlencoded;

const DEFAULT_WINDOW_WIDTH: u32 = 800;
const DEFAULT_WINDOW_HEIGHT: f64 = 600.0;
pub const FLOATING_BALL_LABEL: &str = "floating-ball";
pub const FLOATING_BALL_WIDTH: u32 = 64;
pub const FLOATING_BALL_HEIGHT: u32 = 64;
pub const FLOATING_BALL_MARGIN: u32 = 24;
pub const SUPER_PANEL_LABEL: &str = "super-panel";
pub const SUPER_PANEL_WIDTH: u32 = 460;
pub const SUPER_PANEL_HEIGHT: u32 = 260;
pub const SUPER_PANEL_TOP_OFFSET: u32 = 96;
pub const PLUGIN_DETACH_LABEL: &str = "plugin-detach";
pub const PLUGIN_DETACH_WIDTH: u32 = 1024;
pub const PLUGIN_DETACH_HEIGHT: u32 = 720;

pub fn expand_main_window(app: &AppHandle, height: u32) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let scale = window.scale_factor().unwrap_or(1.0);
        let current_size = window.inner_size().unwrap_or(tauri::PhysicalSize::new(
            DEFAULT_WINDOW_WIDTH,
            DEFAULT_WINDOW_HEIGHT as u32,
        ));
        let new_height = (height as f64 * scale) as u32;
        window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            current_size.width,
            new_height,
        )))?;
    }
    Ok(())
}

pub fn reset_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let scale = window.scale_factor().unwrap_or(1.0);
        let current_size = window.inner_size().unwrap_or(tauri::PhysicalSize::new(
            DEFAULT_WINDOW_WIDTH,
            DEFAULT_WINDOW_HEIGHT as u32,
        ));
        let default_height = (DEFAULT_WINDOW_HEIGHT * scale) as u32;
        window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            current_size.width,
            default_height,
        )))?;
    }
    Ok(())
}

pub fn center_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.center()?;
    }
    Ok(())
}

pub fn floating_ball_initial_url() -> &'static str {
    "/#/floating-ball"
}

pub fn super_panel_initial_url() -> &'static str {
    "/#/super-panel"
}

pub fn plugin_detach_initial_url(feature_code: Option<&str>) -> String {
    match feature_code.and_then(|code| {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }) {
        Some(code) => format!("/#/plugin-detach?{}", encode_feature_code_param(code)),
        None => "/#/plugin-detach".to_string(),
    }
}

fn encode_feature_code_param(feature_code: &str) -> String {
    let mut encoder = form_urlencoded::Serializer::new(String::new());
    encoder.append_pair("feature_code", feature_code);
    encoder.finish()
}

pub fn floating_ball_enabled_from_settings(settings_json: Option<&str>) -> bool {
    settings_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|json| {
            json.get("floatingBallEnabled")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

pub fn super_panel_enabled_from_settings(settings_json: Option<&str>) -> bool {
    settings_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|json| {
            json.get("superPanelEnabled")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

pub fn floating_ball_position_for_monitor(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let margin = FLOATING_BALL_MARGIN as i32;
    let width = FLOATING_BALL_WIDTH as i32;
    let height = FLOATING_BALL_HEIGHT as i32;
    let right = position.x.saturating_add(size.width as i32);
    let bottom = position.y.saturating_add(size.height as i32);
    PhysicalPosition::new(
        right
            .saturating_sub(width + margin)
            .max(position.x.saturating_add(margin)),
        bottom
            .saturating_sub(height + margin)
            .max(position.y.saturating_add(margin)),
    )
}

pub fn super_panel_position_for_monitor(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let margin = FLOATING_BALL_MARGIN as i32;
    let width = SUPER_PANEL_WIDTH as i32;
    let height = SUPER_PANEL_HEIGHT as i32;
    let left = position.x;
    let top = position.y;
    let right = position.x.saturating_add(size.width as i32);
    let bottom = position.y.saturating_add(size.height as i32);
    let min_x = left.saturating_add(margin);
    let max_x = right.saturating_sub(width.saturating_add(margin));
    let min_y = top.saturating_add(margin);
    let max_y = bottom.saturating_sub(height.saturating_add(margin));
    let centered_x = left.saturating_add((size.width as i32).saturating_sub(width) / 2);
    let desired_y = top.saturating_add(SUPER_PANEL_TOP_OFFSET as i32);

    PhysicalPosition::new(
        clamp_monitor_position(centered_x, min_x, max_x),
        clamp_monitor_position(desired_y, min_y, max_y),
    )
}

pub fn ensure_floating_ball_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(FLOATING_BALL_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        FLOATING_BALL_LABEL,
        WebviewUrl::App(floating_ball_initial_url().into()),
    )
    .title("ATools 悬浮球")
    .inner_size(FLOATING_BALL_WIDTH as f64, FLOATING_BALL_HEIGHT as f64)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .build()?;
    position_floating_ball_window(&window)?;
    Ok(window)
}

pub fn ensure_super_panel_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(SUPER_PANEL_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        SUPER_PANEL_LABEL,
        WebviewUrl::App(super_panel_initial_url().into()),
    )
    .title("ATools 超级面板")
    .inner_size(SUPER_PANEL_WIDTH as f64, SUPER_PANEL_HEIGHT as f64)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .visible(false)
    .build()?;
    position_super_panel_window(&window)?;
    Ok(window)
}

pub fn ensure_plugin_detach_window(
    app: &AppHandle,
    feature_code: Option<&str>,
) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(PLUGIN_DETACH_LABEL) {
        let app_url = window.url()?;
        let route_url = app_url
            .join(&plugin_detach_initial_url(feature_code))
            .map_err(tauri::Error::InvalidUrl)?;
        window.navigate(route_url)?;
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        PLUGIN_DETACH_LABEL,
        WebviewUrl::App(plugin_detach_initial_url(feature_code).into()),
    )
    .title("ATools 插件分离窗口")
    .inner_size(PLUGIN_DETACH_WIDTH as f64, PLUGIN_DETACH_HEIGHT as f64)
    .resizable(true)
    .visible(false)
    .build()?;
    Ok(window)
}

pub fn set_floating_ball_visible(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if !visible {
        if let Some(window) = app.get_webview_window(FLOATING_BALL_LABEL) {
            window.hide()?;
        }
        return Ok(());
    }

    let window = ensure_floating_ball_window(app)?;
    position_floating_ball_window(&window)?;
    window.show()?;
    Ok(())
}

pub fn set_super_panel_visible(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if !visible {
        if let Some(window) = app.get_webview_window(SUPER_PANEL_LABEL) {
            window.hide()?;
        }
        return Ok(());
    }

    let window = ensure_super_panel_window(app)?;
    position_super_panel_window(&window)?;
    window.show()?;
    Ok(())
}

fn position_floating_ball_window(window: &WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = window.primary_monitor()? {
        let position = floating_ball_position_for_monitor(*monitor.position(), *monitor.size());
        window.set_position(tauri::Position::Physical(position))?;
    }
    Ok(())
}

fn position_super_panel_window(window: &WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = window.primary_monitor()? {
        let position = super_panel_position_for_monitor(*monitor.position(), *monitor.size());
        window.set_position(tauri::Position::Physical(position))?;
    }
    Ok(())
}

fn clamp_monitor_position(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        min
    } else {
        value.max(min).min(max)
    }
}

#[cfg(test)]
mod tests {
    use super::plugin_detach_initial_url;

    #[test]
    fn plugin_detach_initial_url_encodes_feature_code() {
        assert_eq!(
            plugin_detach_initial_url(Some("foo bar&x=1")),
            "/#/plugin-detach?feature_code=foo+bar%26x%3D1"
        );
    }

    #[test]
    fn plugin_detach_initial_url_trims_and_handles_empty_input() {
        assert_eq!(plugin_detach_initial_url(Some("   ")), "/#/plugin-detach");
        assert_eq!(plugin_detach_initial_url(None), "/#/plugin-detach");
    }
}
