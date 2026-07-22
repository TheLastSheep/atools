use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use url::form_urlencoded;

const DEFAULT_WINDOW_WIDTH: u32 = 800;
const DEFAULT_WINDOW_HEIGHT: f64 = 600.0;
static MAIN_WINDOW_POSITIONS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, PhysicalPosition<i32>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
static LAST_USED_MAIN_MONITOR: std::sync::LazyLock<std::sync::Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainWindowPositionStrategy {
    Remember,
    Cursor,
    Primary,
    LastActive,
}
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

pub fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        position_main_window(app, &window)?;
        prepare_main_window_for_macos_spaces(&window)?;
        window.show()?;
        activate_macos_app(app)?;
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn activate_macos_app(app: &AppHandle) -> tauri::Result<()> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).activate();
        return Ok(());
    }

    app.run_on_main_thread(|| {
        let mtm = MainThreadMarker::new().expect("AppKit activation runs on the main thread");
        NSApplication::sharedApplication(mtm).activate();
    })
}

#[cfg(not(target_os = "macos"))]
fn activate_macos_app(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

pub fn hide_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        remember_main_window_position(&window);
        window.hide()?;
    }
    Ok(())
}

pub fn toggle_main_window(app: &AppHandle) -> tauri::Result<bool> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(false);
    };
    if window.is_visible()? {
        remember_main_window_position(&window);
        window.hide()?;
        return Ok(false);
    }
    position_main_window(app, &window)?;
    prepare_main_window_for_macos_spaces(&window)?;
    window.show()?;
    activate_macos_app(app)?;
    window.set_focus()?;
    Ok(true)
}

fn main_window_position_strategy(app: &AppHandle) -> MainWindowPositionStrategy {
    let value = app
        .try_state::<crate::state::AppState>()
        .and_then(|state| state.db.get_setting("settings-general").ok().flatten())
        .and_then(|settings| serde_json::from_str::<serde_json::Value>(&settings).ok())
        .and_then(|settings| {
            settings
                .get("windowPositionStrategy")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    match value.as_deref() {
        Some("cursor") => MainWindowPositionStrategy::Cursor,
        Some("primary") => MainWindowPositionStrategy::Primary,
        Some("lastActive") => MainWindowPositionStrategy::LastActive,
        _ => MainWindowPositionStrategy::Remember,
    }
}

fn position_main_window(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let strategy = main_window_position_strategy(app);
    let cursor_monitor = cursor_monitor(app);
    let monitor = match strategy {
        MainWindowPositionStrategy::Primary => app.primary_monitor()?,
        MainWindowPositionStrategy::LastActive => last_used_monitor(app).or(cursor_monitor),
        MainWindowPositionStrategy::Cursor | MainWindowPositionStrategy::Remember => cursor_monitor,
    }
    .or(app.primary_monitor()?)
    .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return window.center();
    };

    if strategy == MainWindowPositionStrategy::Remember {
        let key = monitor_key(&monitor);
        if let Some(saved) = MAIN_WINDOW_POSITIONS
            .lock()
            .ok()
            .and_then(|positions| positions.get(&key).copied())
        {
            let position = clamp_window_position(saved, window.outer_size()?, &monitor);
            return window.set_position(position);
        }
    }

    window.set_position(centered_window_position(window.outer_size()?, &monitor))
}

fn remember_main_window_position(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let key = monitor_key(&monitor);
    if let Ok(mut positions) = MAIN_WINDOW_POSITIONS.lock() {
        positions.insert(key.clone(), position);
    }
    if let Ok(mut last) = LAST_USED_MAIN_MONITOR.lock() {
        *last = Some(key);
    }
}

fn cursor_monitor(app: &AppHandle) -> Option<Monitor> {
    app.cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
}

fn last_used_monitor(app: &AppHandle) -> Option<Monitor> {
    let key = LAST_USED_MAIN_MONITOR.lock().ok()?.clone()?;
    app.available_monitors()
        .ok()?
        .into_iter()
        .find(|monitor| monitor_key(monitor) == key)
}

fn monitor_key(monitor: &Monitor) -> String {
    let work = monitor.work_area();
    format!(
        "{}:{}:{}:{}",
        work.position.x, work.position.y, work.size.width, work.size.height
    )
}

fn centered_window_position(size: PhysicalSize<u32>, monitor: &Monitor) -> PhysicalPosition<i32> {
    let work = monitor.work_area();
    let x = work
        .position
        .x
        .saturating_add(work.size.width.saturating_sub(size.width) as i32 / 2);
    let y = work
        .position
        .y
        .saturating_add(work.size.height.saturating_sub(size.height) as i32 / 2);
    PhysicalPosition::new(x, y)
}

fn clamp_window_position(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor: &Monitor,
) -> PhysicalPosition<i32> {
    let work = monitor.work_area();
    let max_x = work
        .position
        .x
        .saturating_add(work.size.width.saturating_sub(size.width) as i32);
    let max_y = work
        .position
        .y
        .saturating_add(work.size.height.saturating_sub(size.height) as i32);
    PhysicalPosition::new(
        position
            .x
            .max(work.position.x)
            .min(max_x.max(work.position.x)),
        position
            .y
            .max(work.position.y)
            .min(max_y.max(work.position.y)),
    )
}

#[cfg(target_os = "macos")]
fn prepare_main_window_for_macos_spaces(window: &WebviewWindow) -> tauri::Result<()> {
    window.set_visible_on_all_workspaces(true)?;
    window.set_always_on_top(true)
}

#[cfg(not(target_os = "macos"))]
fn prepare_main_window_for_macos_spaces(_window: &WebviewWindow) -> tauri::Result<()> {
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
