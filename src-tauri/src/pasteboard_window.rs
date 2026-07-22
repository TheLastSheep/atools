//! Native shelf window and monitor-aware docking geometry for Paste剪切板.

use serde::{Deserialize, Serialize};
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const PASTEBOARD_SHELF_LABEL: &str = "pasteboard-shelf";
pub const PASTEBOARD_ROUTE: &str = "/#/pasteboard-shelf";
pub const PASTEBOARD_DIALOG_LABEL: &str = "pasteboard-dialog";
const HORIZONTAL_HEIGHT: u32 = 356;
const HORIZONTAL_COMPACT_HEIGHT: u32 = 276;
const VERTICAL_WIDTH: u32 = 430;
const VERTICAL_COMPACT_WIDTH: u32 = 350;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PasteboardDockEdge {
    Top,
    Bottom,
    Left,
    Right,
}

impl Default for PasteboardDockEdge {
    fn default() -> Self {
        Self::Bottom
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardShelfBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub edge: PasteboardDockEdge,
    pub compact: bool,
}

pub fn ensure_pasteboard_shelf_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(PASTEBOARD_SHELF_LABEL) {
        return Ok(window);
    }
    let preferences = preferences(app);
    let bounds = bounds_for_cursor_monitor(app, preferences.edge, preferences.compact)?;
    let window = WebviewWindowBuilder::new(
        app,
        PASTEBOARD_SHELF_LABEL,
        WebviewUrl::App(PASTEBOARD_ROUTE.into()),
    )
    .title("Paste剪切板")
    .position(0.0, 0.0)
    .inner_size(320.0, 220.0)
    .min_inner_size(320.0, 220.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()?;
    window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
    window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
    Ok(window)
}

pub fn show_pasteboard_shelf(app: &tauri::AppHandle) -> tauri::Result<()> {
    let preferences = preferences(app);
    let bounds = bounds_for_cursor_monitor(app, preferences.edge, preferences.compact)?;
    let window = ensure_pasteboard_shelf_window(app)?;
    window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
    window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub fn hide_pasteboard_shelf(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(PASTEBOARD_SHELF_LABEL) {
        window.hide()?;
    }
    Ok(())
}

pub fn toggle_pasteboard_shelf(app: &tauri::AppHandle) -> tauri::Result<bool> {
    let window = ensure_pasteboard_shelf_window(app)?;
    if window.is_visible()? {
        window.hide()?;
        return Ok(false);
    }
    show_pasteboard_shelf(app)?;
    Ok(true)
}

pub fn reposition_pasteboard_shelf(app: &tauri::AppHandle) -> tauri::Result<PasteboardShelfBounds> {
    let preferences = preferences(app);
    let bounds = bounds_for_cursor_monitor(app, preferences.edge, preferences.compact)?;
    if let Some(window) = app.get_webview_window(PASTEBOARD_SHELF_LABEL) {
        window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
        window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
    }
    Ok(bounds)
}

pub fn open_pasteboard_dialog(
    app: &tauri::AppHandle,
    mode: &str,
    item_id: Option<&str>,
) -> tauri::Result<()> {
    let mode = match mode {
        "preview" | "editor" | "settings" | "sync" => mode,
        _ => "preview",
    };
    let (width, height) = match mode {
        "settings" => (620u32, 680u32),
        "editor" => (680u32, 600u32),
        "sync" => (600u32, 620u32),
        _ => (760u32, 640u32),
    };
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("mode", mode);
    if let Some(item_id) = item_id.filter(|value| !value.trim().is_empty()) {
        serializer.append_pair("itemId", item_id);
    }
    let route = format!("/#/pasteboard-dialog?{}", serializer.finish());
    let bounds = centered_dialog_bounds(app, width, height)?;
    if let Some(window) = app.get_webview_window(PASTEBOARD_DIALOG_LABEL) {
        let url = window
            .url()?
            .join(&route)
            .map_err(tauri::Error::InvalidUrl)?;
        window.navigate(url)?;
        window.set_size(PhysicalSize::new(bounds.2, bounds.3))?;
        window.set_position(PhysicalPosition::new(bounds.0, bounds.1))?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    let window =
        WebviewWindowBuilder::new(app, PASTEBOARD_DIALOG_LABEL, WebviewUrl::App(route.into()))
            .title("Paste剪切板")
            .position(0.0, 0.0)
            .inner_size(width as f64, height as f64)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .build()?;
    window.set_size(PhysicalSize::new(bounds.2, bounds.3))?;
    window.set_position(PhysicalPosition::new(bounds.0, bounds.1))?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub fn hide_pasteboard_dialog(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(PASTEBOARD_DIALOG_LABEL) {
        window.hide()?;
    }
    Ok(())
}

fn centered_dialog_bounds(
    app: &tauri::AppHandle,
    width: u32,
    height: u32,
) -> tauri::Result<(i32, i32, u32, u32)> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| {
            tauri::Error::Anyhow(anyhow::anyhow!("No monitor available for Paste dialog"))
        })?;
    let work = monitor.work_area();
    let width = scale_logical_pixels(width, monitor.scale_factor()).min(work.size.width);
    let height = scale_logical_pixels(height, monitor.scale_factor()).min(work.size.height);
    Ok((
        work.position
            .x
            .saturating_add(work.size.width.saturating_sub(width) as i32 / 2),
        work.position
            .y
            .saturating_add(work.size.height.saturating_sub(height) as i32 / 2),
        width,
        height,
    ))
}

fn bounds_for_cursor_monitor(
    app: &tauri::AppHandle,
    edge: PasteboardDockEdge,
    compact: bool,
) -> tauri::Result<PasteboardShelfBounds> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| {
            tauri::Error::Anyhow(anyhow::anyhow!("No monitor available for Paste shelf"))
        })?;
    let work_area = monitor.work_area();
    Ok(resolve_pasteboard_shelf_bounds_with_scale(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        monitor.scale_factor(),
        edge,
        compact,
    ))
}

pub fn resolve_pasteboard_shelf_bounds(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    edge: PasteboardDockEdge,
    compact: bool,
) -> PasteboardShelfBounds {
    resolve_pasteboard_shelf_bounds_with_scale(
        work_x,
        work_y,
        work_width,
        work_height,
        1.0,
        edge,
        compact,
    )
}

pub fn resolve_pasteboard_shelf_bounds_with_scale(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    scale_factor: f64,
    edge: PasteboardDockEdge,
    compact: bool,
) -> PasteboardShelfBounds {
    let horizontal_height = if compact {
        HORIZONTAL_COMPACT_HEIGHT
    } else {
        HORIZONTAL_HEIGHT
    };
    let horizontal_height = scale_logical_pixels(horizontal_height, scale_factor).min(work_height);
    let vertical_width = if compact {
        VERTICAL_COMPACT_WIDTH
    } else {
        VERTICAL_WIDTH
    };
    let vertical_width = scale_logical_pixels(vertical_width, scale_factor).min(work_width);
    match edge {
        PasteboardDockEdge::Top => PasteboardShelfBounds {
            x: work_x,
            y: work_y,
            width: work_width,
            height: horizontal_height,
            edge,
            compact,
        },
        PasteboardDockEdge::Bottom => PasteboardShelfBounds {
            x: work_x,
            y: work_y.saturating_add(work_height.saturating_sub(horizontal_height) as i32),
            width: work_width,
            height: horizontal_height,
            edge,
            compact,
        },
        PasteboardDockEdge::Left => PasteboardShelfBounds {
            x: work_x,
            y: work_y,
            width: vertical_width,
            height: work_height,
            edge,
            compact,
        },
        PasteboardDockEdge::Right => PasteboardShelfBounds {
            x: work_x.saturating_add(work_width.saturating_sub(vertical_width) as i32),
            y: work_y,
            width: vertical_width,
            height: work_height,
            edge,
            compact,
        },
    }
}

fn scale_logical_pixels(value: u32, scale_factor: f64) -> u32 {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    ((value as f64 * scale_factor).round()).clamp(1.0, u32::MAX as f64) as u32
}

#[derive(Debug, Clone, Copy)]
struct PasteboardWindowPreferences {
    edge: PasteboardDockEdge,
    compact: bool,
}

fn preferences(app: &tauri::AppHandle) -> PasteboardWindowPreferences {
    let settings = app
        .try_state::<crate::state::AppState>()
        .and_then(|state| state.db.get_setting("settings-general").ok().flatten())
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let edge = match settings
        .get("pasteboardDockEdge")
        .and_then(serde_json::Value::as_str)
    {
        Some("top") => PasteboardDockEdge::Top,
        Some("left") => PasteboardDockEdge::Left,
        Some("right") => PasteboardDockEdge::Right,
        _ => PasteboardDockEdge::Bottom,
    };
    let compact = settings
        .get("pasteboardCompact")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    PasteboardWindowPreferences { edge, compact }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horizontal_edges_fill_the_entire_work_area_width() {
        let bottom =
            resolve_pasteboard_shelf_bounds(1440, 0, 1920, 1080, PasteboardDockEdge::Bottom, false);
        assert_eq!(bottom.x, 1440);
        assert_eq!(bottom.width, 1920);
        assert_eq!(bottom.y + bottom.height as i32, 1080);

        let top =
            resolve_pasteboard_shelf_bounds(-1920, 24, 1920, 1056, PasteboardDockEdge::Top, true);
        assert_eq!(top.x, -1920);
        assert_eq!(top.y, 24);
        assert_eq!(top.width, 1920);
    }

    #[test]
    fn vertical_compact_mode_changes_width_and_fills_height() {
        let regular =
            resolve_pasteboard_shelf_bounds(0, 25, 1512, 957, PasteboardDockEdge::Right, false);
        let compact =
            resolve_pasteboard_shelf_bounds(0, 25, 1512, 957, PasteboardDockEdge::Right, true);
        assert_eq!(regular.height, 957);
        assert_eq!(regular.x + regular.width as i32, 1512);
        assert!(compact.width < regular.width);
    }

    #[test]
    fn retina_scale_preserves_logical_shelf_thickness() {
        let horizontal = resolve_pasteboard_shelf_bounds_with_scale(
            0,
            0,
            3024,
            1890,
            2.0,
            PasteboardDockEdge::Bottom,
            false,
        );
        assert_eq!(horizontal.height, HORIZONTAL_HEIGHT * 2);
        assert_eq!(horizontal.width, 3024);

        let vertical = resolve_pasteboard_shelf_bounds_with_scale(
            0,
            0,
            3024,
            1890,
            2.0,
            PasteboardDockEdge::Left,
            true,
        );
        assert_eq!(vertical.width, VERTICAL_COMPACT_WIDTH * 2);
        assert_eq!(vertical.height, 1890);
    }
}
