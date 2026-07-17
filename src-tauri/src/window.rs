use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
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
pub const PASTEBOARD_SHELF_LABEL: &str = "pasteboard-shelf";
pub const PASTEBOARD_SHELF_FEATURE_CODE: &str = "pasteboard-pro-atools";
pub const PASTEBOARD_SHELF_WIDTH: u32 = 1180;
pub const PASTEBOARD_SHELF_HEIGHT: u32 = 330;
pub const PASTEBOARD_SHELF_MARGIN: u32 = 24;
pub const PASTEBOARD_SHELF_SNAP_ZONE: u32 = 12;
const PASTEBOARD_SHELF_PLACEMENT_SETTING_KEY: &str = "pasteboard.shelf_placement";
const PASTEBOARD_SHELF_PLACEMENT_VERSION: u8 = 1;
const PASTEBOARD_SHELF_EVENT_DEBOUNCE_MS: u64 = 180;
static PASTEBOARD_SHELF_EVENT_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasteboardShelfEdge {
    Floating,
    Bottom,
    Left,
    Right,
}

impl PasteboardShelfEdge {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Floating => "floating",
            Self::Bottom => "bottom",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasteboardShelfPlacement {
    version: u8,
    monitor_name: Option<String>,
    monitor_work_area_x: i32,
    monitor_work_area_y: i32,
    monitor_work_area_width: u32,
    monitor_work_area_height: u32,
    scale_factor: f64,
    edge: PasteboardShelfEdge,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl PasteboardShelfPlacement {
    fn is_valid(&self) -> bool {
        self.version == PASTEBOARD_SHELF_PLACEMENT_VERSION
            && self.width > 0
            && self.height > 0
            && self.width <= 100_000
            && self.height <= 100_000
            && self.monitor_work_area_width > 0
            && self.monitor_work_area_height > 0
            && self.scale_factor.is_finite()
            && (0.1..=10.0).contains(&self.scale_factor)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardShelfWindowSnapshot {
    pub edge: String,
    pub monitor_name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

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

pub fn pasteboard_shelf_initial_url() -> String {
    format!(
        "/#/pasteboard-shelf?{}",
        encode_feature_code_param(PASTEBOARD_SHELF_FEATURE_CODE)
    )
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

pub fn ensure_pasteboard_shelf_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(PASTEBOARD_SHELF_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        PASTEBOARD_SHELF_LABEL,
        WebviewUrl::App(pasteboard_shelf_initial_url().into()),
    )
    .title("PasteboardPro")
    .inner_size(
        PASTEBOARD_SHELF_WIDTH as f64,
        PASTEBOARD_SHELF_HEIGHT as f64,
    )
    .min_inner_size(680.0, 220.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .content_protected(true)
    .shadow(false)
    .visible(false)
    .build()?;
    restore_pasteboard_shelf_window(app, &window)?;
    Ok(window)
}

pub fn position_pasteboard_shelf_window(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = pasteboard_shelf_monitor_for_window(window)? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    let margin = (PASTEBOARD_SHELF_MARGIN as f64 * scale).round() as i32;
    let width = (PASTEBOARD_SHELF_WIDTH as f64 * scale).round() as u32;
    let height = (PASTEBOARD_SHELF_HEIGHT as f64 * scale).round() as u32;
    let available_width = work_area
        .size
        .width
        .saturating_sub((margin.max(0) as u32) * 2);
    let width = width.min(available_width.max(1));
    let x = work_area
        .position
        .x
        .saturating_add((work_area.size.width.saturating_sub(width) / 2) as i32);
    let y = work_area
        .position
        .y
        .saturating_add(work_area.size.height.saturating_sub(height) as i32);
    window.set_size(tauri::Size::Physical(PhysicalSize::new(width, height)))?;
    window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)))?;
    Ok(())
}

pub fn start_pasteboard_shelf_drag(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != PASTEBOARD_SHELF_LABEL {
        return Err("Only the PasteboardPro shelf may start shelf dragging".to_string());
    }
    window.start_dragging().map_err(|error| error.to_string())
}

pub fn schedule_pasteboard_shelf_reconcile(window: &WebviewWindow) {
    if window.label() != PASTEBOARD_SHELF_LABEL {
        return;
    }
    let generation = PASTEBOARD_SHELF_EVENT_GENERATION
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PASTEBOARD_SHELF_EVENT_DEBOUNCE_MS)).await;
        if PASTEBOARD_SHELF_EVENT_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        let Some(window) = app.get_webview_window(PASTEBOARD_SHELF_LABEL) else {
            return;
        };
        if let Err(error) = reconcile_and_persist_pasteboard_shelf_window(&app, &window) {
            tracing::warn!("Failed to persist PasteboardPro shelf placement: {error}");
        }
    });
}

pub fn pasteboard_shelf_window_snapshot(
    window: &WebviewWindow,
) -> Result<PasteboardShelfWindowSnapshot, String> {
    let monitor = pasteboard_shelf_monitor_for_window(window)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "PasteboardPro shelf monitor is unavailable".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let (edge, _, _) = pasteboard_shelf_snapped_geometry(
        position,
        size,
        monitor.work_area().position,
        monitor.work_area().size,
        monitor.scale_factor(),
    );
    Ok(PasteboardShelfWindowSnapshot {
        edge: edge.as_str().to_string(),
        monitor_name: monitor.name().cloned(),
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn restore_pasteboard_shelf_window(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let saved = load_pasteboard_shelf_placement(app);
    let monitor = pasteboard_shelf_monitor_for_saved(window, saved.as_ref())?
        .or(window.primary_monitor()?)
        .or_else(|| window.available_monitors().ok()?.into_iter().next());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let placement = saved
        .as_ref()
        .map(|saved| pasteboard_shelf_restored_placement(saved, &monitor))
        .unwrap_or_else(|| pasteboard_shelf_default_placement(&monitor));
    apply_pasteboard_shelf_placement(window, &placement)?;
    if let Err(error) = save_pasteboard_shelf_placement(app, &placement) {
        tracing::warn!("Failed to save restored PasteboardPro shelf placement: {error}");
    }
    Ok(())
}

fn reconcile_and_persist_pasteboard_shelf_window(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(), String> {
    let monitor = pasteboard_shelf_monitor_for_window(window)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "PasteboardPro shelf monitor is unavailable".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let (edge, snapped_position, snapped_size) = pasteboard_shelf_snapped_geometry(
        position,
        size,
        monitor.work_area().position,
        monitor.work_area().size,
        monitor.scale_factor(),
    );
    let placement = pasteboard_shelf_placement(&monitor, edge, snapped_position, snapped_size);
    apply_pasteboard_shelf_placement(window, &placement).map_err(|error| error.to_string())?;
    save_pasteboard_shelf_placement(app, &placement)
}

fn load_pasteboard_shelf_placement(app: &AppHandle) -> Option<PasteboardShelfPlacement> {
    let state = app.state::<AppState>();
    let raw = match state
        .inner()
        .db
        .get_setting(PASTEBOARD_SHELF_PLACEMENT_SETTING_KEY)
    {
        Ok(value) => value?,
        Err(error) => {
            tracing::warn!("Failed to load PasteboardPro shelf placement: {error}");
            return None;
        }
    };
    match serde_json::from_str::<PasteboardShelfPlacement>(&raw) {
        Ok(placement) if placement.is_valid() => Some(placement),
        Ok(_) => {
            tracing::warn!("Ignoring invalid PasteboardPro shelf placement");
            None
        }
        Err(error) => {
            tracing::warn!("Ignoring malformed PasteboardPro shelf placement: {error}");
            None
        }
    }
}

fn save_pasteboard_shelf_placement(
    app: &AppHandle,
    placement: &PasteboardShelfPlacement,
) -> Result<(), String> {
    let serialized = serde_json::to_string(placement)
        .map_err(|error| format!("Failed to serialize PasteboardPro shelf placement: {error}"))?;
    app.state::<AppState>()
        .inner()
        .db
        .set_setting(PASTEBOARD_SHELF_PLACEMENT_SETTING_KEY, &serialized)
        .map_err(|error| error.to_string())
}

fn pasteboard_shelf_monitor_for_saved(
    window: &WebviewWindow,
    saved: Option<&PasteboardShelfPlacement>,
) -> tauri::Result<Option<Monitor>> {
    let Some(saved) = saved else {
        return pasteboard_shelf_monitor_for_window(window);
    };
    let monitors = window.available_monitors()?;
    if let Some(name) = saved.monitor_name.as_deref() {
        if let Some(monitor) = monitors
            .iter()
            .filter(|monitor| monitor.name().map(String::as_str) == Some(name))
            .min_by_key(|monitor| pasteboard_shelf_monitor_distance(monitor, saved))
        {
            return Ok(Some(monitor.clone()));
        }
        return window.primary_monitor();
    }
    let center_x = saved.x as f64 + saved.width as f64 / 2.0;
    let center_y = saved.y as f64 + saved.height as f64 / 2.0;
    if let Some(monitor) = window.monitor_from_point(center_x, center_y)? {
        return Ok(Some(monitor));
    }
    Ok(window
        .primary_monitor()?
        .or_else(|| monitors.into_iter().next()))
}

fn pasteboard_shelf_monitor_for_window(window: &WebviewWindow) -> tauri::Result<Option<Monitor>> {
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
        let center_x = position.x as f64 + size.width as f64 / 2.0;
        let center_y = position.y as f64 + size.height as f64 / 2.0;
        if let Some(monitor) = window.monitor_from_point(center_x, center_y)? {
            return Ok(Some(monitor));
        }
    }
    Ok(window.current_monitor()?.or(window.primary_monitor()?))
}

fn pasteboard_shelf_monitor_distance(monitor: &Monitor, saved: &PasteboardShelfPlacement) -> i64 {
    let work_area = monitor.work_area();
    i64::from(work_area.position.x.abs_diff(saved.monitor_work_area_x))
        + i64::from(work_area.position.y.abs_diff(saved.monitor_work_area_y))
        + i64::from(work_area.size.width.abs_diff(saved.monitor_work_area_width))
        + i64::from(
            work_area
                .size
                .height
                .abs_diff(saved.monitor_work_area_height),
        )
}

fn pasteboard_shelf_default_placement(monitor: &Monitor) -> PasteboardShelfPlacement {
    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width =
        ((PASTEBOARD_SHELF_WIDTH as f64 * scale).round() as u32).min(work_area.size.width.max(1));
    let height =
        ((PASTEBOARD_SHELF_HEIGHT as f64 * scale).round() as u32).min(work_area.size.height.max(1));
    let x = work_area
        .position
        .x
        .saturating_add(work_area.size.width.saturating_sub(width).saturating_div(2) as i32);
    let y = pasteboard_work_area_bottom(work_area.position.y, work_area.size.height)
        .saturating_sub(pasteboard_u32_to_i32(height));
    pasteboard_shelf_placement(
        monitor,
        PasteboardShelfEdge::Bottom,
        PhysicalPosition::new(x, y),
        PhysicalSize::new(width, height),
    )
}

fn pasteboard_shelf_restored_placement(
    saved: &PasteboardShelfPlacement,
    monitor: &Monitor,
) -> PasteboardShelfPlacement {
    let work_area = monitor.work_area();
    let scale_ratio = monitor.scale_factor() / saved.scale_factor;
    let scaled_width = pasteboard_scaled_u32(saved.width, scale_ratio);
    let scaled_height = pasteboard_scaled_u32(saved.height, scale_ratio);
    let min_width =
        ((680.0 * monitor.scale_factor()).round() as u32).min(work_area.size.width.max(1));
    let min_height =
        ((220.0 * monitor.scale_factor()).round() as u32).min(work_area.size.height.max(1));
    let width = scaled_width.max(min_width).min(work_area.size.width.max(1));
    let height = scaled_height
        .max(min_height)
        .min(work_area.size.height.max(1));
    let relative_x = saved.x.saturating_sub(saved.monitor_work_area_x);
    let relative_y = saved.y.saturating_sub(saved.monitor_work_area_y);
    let desired = PhysicalPosition::new(
        work_area
            .position
            .x
            .saturating_add(pasteboard_scaled_i32(relative_x, scale_ratio)),
        work_area
            .position
            .y
            .saturating_add(pasteboard_scaled_i32(relative_y, scale_ratio)),
    );
    let (_, position, size) = pasteboard_shelf_geometry_for_edge(
        saved.edge,
        desired,
        PhysicalSize::new(width, height),
        work_area.position,
        work_area.size,
    );
    pasteboard_shelf_placement(monitor, saved.edge, position, size)
}

fn pasteboard_shelf_placement(
    monitor: &Monitor,
    edge: PasteboardShelfEdge,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> PasteboardShelfPlacement {
    let work_area = monitor.work_area();
    PasteboardShelfPlacement {
        version: PASTEBOARD_SHELF_PLACEMENT_VERSION,
        monitor_name: monitor.name().cloned(),
        monitor_work_area_x: work_area.position.x,
        monitor_work_area_y: work_area.position.y,
        monitor_work_area_width: work_area.size.width,
        monitor_work_area_height: work_area.size.height,
        scale_factor: monitor.scale_factor(),
        edge,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

fn pasteboard_shelf_snapped_geometry(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    scale_factor: f64,
) -> (
    PasteboardShelfEdge,
    PhysicalPosition<i32>,
    PhysicalSize<u32>,
) {
    let width = size.width.min(work_size.width.max(1));
    let height = size.height.min(work_size.height.max(1));
    let size = PhysicalSize::new(width, height);
    let right = position.x.saturating_add(pasteboard_u32_to_i32(size.width));
    let bottom = position
        .y
        .saturating_add(pasteboard_u32_to_i32(size.height));
    let work_right = pasteboard_work_area_right(work_position.x, work_size.width);
    let work_bottom = pasteboard_work_area_bottom(work_position.y, work_size.height);
    let zone = ((PASTEBOARD_SHELF_SNAP_ZONE as f64 * scale_factor).round() as u32).max(1);
    let candidates = [
        (PasteboardShelfEdge::Bottom, bottom.abs_diff(work_bottom)),
        (
            PasteboardShelfEdge::Left,
            position.x.abs_diff(work_position.x),
        ),
        (PasteboardShelfEdge::Right, right.abs_diff(work_right)),
    ];
    let mut edge = PasteboardShelfEdge::Floating;
    let mut best_gap = zone.saturating_add(1);
    for (candidate, gap) in candidates {
        if gap <= zone && gap < best_gap {
            edge = candidate;
            best_gap = gap;
        }
    }
    pasteboard_shelf_geometry_for_edge(edge, position, size, work_position, work_size)
}

fn pasteboard_shelf_geometry_for_edge(
    edge: PasteboardShelfEdge,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
) -> (
    PasteboardShelfEdge,
    PhysicalPosition<i32>,
    PhysicalSize<u32>,
) {
    let size = PhysicalSize::new(
        size.width.min(work_size.width.max(1)),
        size.height.min(work_size.height.max(1)),
    );
    let work_right = pasteboard_work_area_right(work_position.x, work_size.width);
    let work_bottom = pasteboard_work_area_bottom(work_position.y, work_size.height);
    let max_x = work_right.saturating_sub(pasteboard_u32_to_i32(size.width));
    let max_y = work_bottom.saturating_sub(pasteboard_u32_to_i32(size.height));
    let x = clamp_monitor_position(position.x, work_position.x, max_x);
    let y = clamp_monitor_position(position.y, work_position.y, max_y);
    let position = match edge {
        PasteboardShelfEdge::Floating => PhysicalPosition::new(x, y),
        PasteboardShelfEdge::Bottom => PhysicalPosition::new(x, max_y),
        PasteboardShelfEdge::Left => PhysicalPosition::new(work_position.x, y),
        PasteboardShelfEdge::Right => PhysicalPosition::new(max_x, y),
    };
    (edge, position, size)
}

fn apply_pasteboard_shelf_placement(
    window: &WebviewWindow,
    placement: &PasteboardShelfPlacement,
) -> tauri::Result<()> {
    let desired_size = PhysicalSize::new(placement.width, placement.height);
    if window.outer_size()? != desired_size {
        window.set_size(tauri::Size::Physical(desired_size))?;
    }
    let desired_position = PhysicalPosition::new(placement.x, placement.y);
    if window.outer_position()? != desired_position {
        window.set_position(tauri::Position::Physical(desired_position))?;
    }
    Ok(())
}

fn pasteboard_scaled_u32(value: u32, ratio: f64) -> u32 {
    (value as f64 * ratio).round().clamp(1.0, u32::MAX as f64) as u32
}

fn pasteboard_scaled_i32(value: i32, ratio: f64) -> i32 {
    (value as f64 * ratio)
        .round()
        .clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

fn pasteboard_u32_to_i32(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn pasteboard_work_area_right(x: i32, width: u32) -> i32 {
    x.saturating_add(pasteboard_u32_to_i32(width))
}

fn pasteboard_work_area_bottom(y: i32, height: u32) -> i32 {
    y.saturating_add(pasteboard_u32_to_i32(height))
}

pub fn set_pasteboard_shelf_visible(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if !visible {
        if let Some(window) = app.get_webview_window(PASTEBOARD_SHELF_LABEL) {
            if let Err(error) = reconcile_and_persist_pasteboard_shelf_window(app, &window) {
                tracing::warn!("Failed to persist hidden PasteboardPro shelf placement: {error}");
            }
            window.hide()?;
        }
        return Ok(());
    }
    let window = ensure_pasteboard_shelf_window(app)?;
    restore_pasteboard_shelf_window(app, &window)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
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
    use super::{
        pasteboard_shelf_snapped_geometry, plugin_detach_initial_url, PasteboardShelfEdge,
    };
    use tauri::{PhysicalPosition, PhysicalSize};

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

    #[test]
    fn pasteboard_shelf_snaps_to_each_supported_edge() {
        let work_position = PhysicalPosition::new(0, 0);
        let work_size = PhysicalSize::new(1_000, 800);
        let size = PhysicalSize::new(500, 200);

        let (edge, position, _) = pasteboard_shelf_snapped_geometry(
            PhysicalPosition::new(250, 590),
            size,
            work_position,
            work_size,
            1.0,
        );
        assert_eq!(edge, PasteboardShelfEdge::Bottom);
        assert_eq!(position, PhysicalPosition::new(250, 600));

        let (edge, position, _) = pasteboard_shelf_snapped_geometry(
            PhysicalPosition::new(8, 240),
            size,
            work_position,
            work_size,
            1.0,
        );
        assert_eq!(edge, PasteboardShelfEdge::Left);
        assert_eq!(position, PhysicalPosition::new(0, 240));

        let (edge, position, _) = pasteboard_shelf_snapped_geometry(
            PhysicalPosition::new(492, 240),
            size,
            work_position,
            work_size,
            1.0,
        );
        assert_eq!(edge, PasteboardShelfEdge::Right);
        assert_eq!(position, PhysicalPosition::new(500, 240));
    }

    #[test]
    fn pasteboard_shelf_floating_position_is_clamped_to_work_area() {
        let (edge, position, size) = pasteboard_shelf_snapped_geometry(
            PhysicalPosition::new(-50, -40),
            PhysicalSize::new(1_200, 900),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1_000, 800),
            1.0,
        );
        assert_eq!(edge, PasteboardShelfEdge::Floating);
        assert_eq!(position, PhysicalPosition::new(0, 0));
        assert_eq!(size, PhysicalSize::new(1_000, 800));
    }
}
