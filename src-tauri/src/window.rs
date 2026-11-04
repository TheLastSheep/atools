use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window,
};

mod activation;
mod blur_guard;
pub(crate) use blur_guard::{
    restore_double_tap_blur, suppress_double_tap_blur, transient_blur_suppressed,
    TransientBlurGuard,
};
#[cfg(feature = "ztools-multiwebview")]
mod auto_back;
#[cfg(any(feature = "ztools-multiwebview", test))]
mod content_height;
#[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
pub(crate) mod macos_main_panel;
#[cfg(feature = "ztools-multiwebview")]
mod main_child_layout;
mod main_roles;
mod position;
#[cfg(target_os = "macos")]
mod position_macos;
mod presentation;
mod resize_apply;
mod resize_bounds;
#[cfg(any(feature = "ztools-multiwebview", test))]
mod settings_height_geometry;
#[cfg(feature = "ztools-multiwebview")]
pub(crate) use content_height::{
    create_settings_child, resize_settings_content_on_window, validate_settings_content,
};

#[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
pub(crate) use activation::state::ForegroundSnapshot as MainWindowSnapshot;

#[cfg(feature = "ztools-multiwebview")]
pub(crate) use auto_back::{
    cancel_auto_back_on_show, main_window_hidden, stop_auto_back, AutoBackController,
};
#[cfg(all(feature = "ztools-multiwebview", feature = "legacy-node-smoke"))]
pub(crate) use main_child_layout::attach_main_child_layout;
#[cfg(feature = "ztools-multiwebview")]
pub(crate) use main_child_layout::handle_main_child_layout_event;
#[cfg(feature = "ztools-multiwebview")]
pub(crate) use main_child_layout::{
    attach_settings_child_layout_on_window, main_child_is_visible, main_child_layout_active_count,
    MainChildLayoutLease,
};
pub(crate) use main_roles::{main_webview, main_window};
pub(crate) use position::position_main_window_for_foreground;
pub(crate) use position::remember_main_window_position;

const DEFAULT_WINDOW_HEIGHT: u32 = 600;

pub(crate) fn position_main_window(app: &AppHandle, window: &Window) -> tauri::Result<()> {
    position::position_main_window(app, window)
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
    resize_main_window_to_height(app, height)
}

pub fn expand_window(app: &AppHandle, height: u32) -> tauri::Result<()> {
    expand_main_window(app, height)
}

pub fn reset_main_window(app: &AppHandle) -> tauri::Result<()> {
    resize_main_window_to_height(app, DEFAULT_WINDOW_HEIGHT)
}

fn resize_main_window_to_height(
    app: &AppHandle,
    requested_logical_height: u32,
) -> tauri::Result<()> {
    resize_main_window_to_logical_height(app, f64::from(requested_logical_height))
}

enum HeightRequest {
    Total(f64),
    #[cfg(feature = "ztools-multiwebview")]
    SettingsContent(f64),
}
impl HeightRequest {
    fn resolve(
        self,
        #[cfg_attr(not(feature = "ztools-multiwebview"), allow(unused_variables))] scale: f64,
    ) -> Result<f64, String> {
        match self {
            Self::Total(height) => Ok(height),
            #[cfg(feature = "ztools-multiwebview")]
            Self::SettingsContent(desired) => content_height::parent_request(desired, scale),
        }
    }
}
fn resize_main_window_to_logical_height(app: &AppHandle, requested: f64) -> tauri::Result<()> {
    resize_main_window_height(app, HeightRequest::Total(requested))
}
fn resize_main_window_height(app: &AppHandle, request: HeightRequest) -> tauri::Result<()> {
    let window = main_window(app)?;
    resize_window_height(app, &window, request)
}
fn resize_window_height(
    app: &AppHandle,
    window: &tauri::Window,
    request: HeightRequest,
) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => monitor,
        None => app.primary_monitor()?.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Unable to determine monitor for main window resize",
            )
        })?,
    };
    let scale_factor = window.scale_factor()?;
    let requested_logical_height = request
        .resolve(scale_factor)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let inner_size = window.inner_size()?;
    let outer_size = window.outer_size()?;
    let frame_height = outer_size
        .height
        .checked_sub(inner_size.height)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Main window outer height is smaller than inner height",
            )
        })?;
    let original_position = window.outer_position()?;
    let work_area = monitor.work_area();
    let plan = resize_bounds::plan_resize_f64(
        requested_logical_height,
        scale_factor,
        work_area.position.y,
        work_area.size.height,
        frame_height,
        original_position.y,
    )
    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let target_position = PhysicalPosition::new(original_position.x, plan.outer_y);

    resize_apply::apply(
        window,
        resize_apply::Geometry {
            position: original_position,
            size: inner_size,
        },
        resize_apply::Geometry {
            position: target_position,
            size: PhysicalSize::new(inner_size.width, plan.inner_height),
        },
    )?;
    crate::renderer_window_drag::resized(
        app,
        PhysicalSize::new(inner_size.width, plan.inner_height),
        scale_factor,
    );
    Ok(())
}

pub fn center_main_window(app: &AppHandle) -> tauri::Result<()> {
    main_window(app)?.center()?;
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    presentation::show_main_window(app, presentation::ShowIntent::Foreground)
}

pub fn show_main_window_for_startup(app: &AppHandle) -> tauri::Result<()> {
    presentation::show_main_window(app, presentation::ShowIntent::Startup)
}

pub fn hide_main_window(app: &AppHandle) -> tauri::Result<()> {
    if crate::plugin_dialog_runtime::modal_active(app, "main") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "文件选择窗口仍打开，请先完成或取消选择",
        )
        .into());
    }
    let window = main_window(app)?;
    remember_main_window_position(&window);
    crate::renderer_window_drag::clear(app);
    window.hide()?;
    #[cfg(feature = "ztools-multiwebview")]
    main_window_hidden(app);
    Ok(())
}

pub fn toggle_main_window(app: &AppHandle) -> tauri::Result<bool> {
    let window = main_window(app)?;
    let modal_active = crate::plugin_dialog_runtime::modal_active(app, "main");
    let visible = window.is_visible()?;
    #[cfg(feature = "ztools-multiwebview")]
    if modal_active || visible {
        cancel_auto_back_on_show(app);
    }
    if modal_active {
        return Ok(visible);
    }
    if visible {
        remember_main_window_position(&window);
        crate::renderer_window_drag::clear(app);
        window.hide()?;
        #[cfg(feature = "ztools-multiwebview")]
        main_window_hidden(app);
        return Ok(false);
    }
    // Multi-window coordination: hide floating overlays before showing launcher
    if let Some(super_panel) = app.get_webview_window(SUPER_PANEL_LABEL) {
        let _ = super_panel.hide();
    }
    if let Some(shelf) = app.get_webview_window(crate::pasteboard_window::PASTEBOARD_SHELF_LABEL) {
        let _ = shelf.hide();
    }
    show_main_window(app)?;
    Ok(true)
}

#[cfg(target_os = "macos")]
fn prepare_main_window_for_macos_spaces(window: &Window) -> tauri::Result<()> {
    window.set_visible_on_all_workspaces(true)?;
    window.set_always_on_top(true)
}

#[cfg(not(target_os = "macos"))]
fn prepare_main_window_for_macos_spaces(_window: &Window) -> tauri::Result<()> {
    Ok(())
}

pub fn floating_ball_initial_url() -> &'static str {
    "/#/floating-ball"
}

pub fn super_panel_initial_url() -> &'static str {
    "/#/super-panel"
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
    .visible_on_all_workspaces(true)
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
    .visible_on_all_workspaces(true)
    .shadow(true)
    .visible(false)
    .build()?;
    position_super_panel_window(&window)?;
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
    // Multi-window coordination: dismiss shelf when super panel opens
    if let Some(shelf) = app.get_webview_window(crate::pasteboard_window::PASTEBOARD_SHELF_LABEL) {
        let _ = shelf.hide();
    }
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
