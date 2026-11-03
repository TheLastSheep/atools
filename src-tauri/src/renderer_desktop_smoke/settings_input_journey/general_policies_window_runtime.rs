use serde_json::{json, Value};
use tauri::{AppHandle, Monitor, PhysicalPosition, Window, Wry};

const WINDOW_ERROR: &str = super::general_policies_schema::WINDOW_GEOMETRY_INVALID;

pub(super) async fn apply_production_policy(app: &AppHandle<Wry>) -> Result<Value, &'static str> {
    let window = crate::window::main_window(app).map_err(|_| WINDOW_ERROR)?;
    crate::window::position_main_window(app, &window).map_err(|_| WINDOW_ERROR)?;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    Ok(position_sample(app, &window))
}

pub(super) fn remember_current_position(app: &AppHandle<Wry>) -> Result<Value, &'static str> {
    let window = crate::window::main_window(app).map_err(|_| WINDOW_ERROR)?;
    let sample = position_sample(app, &window);
    crate::window::remember_main_window_position(&window);
    Ok(sample)
}

pub(super) async fn move_window_away(app: &AppHandle<Wry>) -> Result<(Value, Value), &'static str> {
    let window = crate::window::main_window(app).map_err(|_| WINDOW_ERROR)?;
    let saved = position_sample(app, &window);
    let Some(monitor) = window.current_monitor().ok().flatten() else {
        return Ok((saved, empty_point()));
    };
    let (Some(position), Some(size)) = (window.outer_position().ok(), window.outer_size().ok())
    else {
        return Ok((saved, empty_point()));
    };
    let area = monitor.work_area();
    let origin = area.position;
    let extent = area.size;
    let max_x = origin
        .x
        .saturating_add(extent.width.saturating_sub(size.width).min(i32::MAX as u32) as i32);
    let max_y = origin.y.saturating_add(
        extent
            .height
            .saturating_sub(size.height)
            .min(i32::MAX as u32) as i32,
    );
    let moved_x = alternate(position.x, origin.x, max_x);
    let moved_y = alternate(position.y, origin.y, max_y);
    window
        .set_position(PhysicalPosition::new(moved_x, moved_y))
        .map_err(|_| WINDOW_ERROR)?;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let actual = window.outer_position().ok();
    let moved = actual
        .map(|point| json!({"x": point.x, "y": point.y}))
        .unwrap_or_else(empty_point);
    Ok((saved, moved))
}

pub(super) fn position_sample(app: &AppHandle<Wry>, window: &Window<Wry>) -> Value {
    let primary = app.primary_monitor().ok().flatten();
    let monitor = window.current_monitor().ok().flatten();
    let cursor = app.cursor_position().ok();
    let position = window.outer_position().ok();
    let size = window.outer_size().ok();
    let monitor_value = monitor
        .as_ref()
        .map(|current| monitor_value(current, primary.as_ref()))
        .unwrap_or_else(empty_monitor);
    let cursor_x = cursor.as_ref().and_then(|point| coordinate(point.x));
    let cursor_y = cursor.as_ref().and_then(|point| coordinate(point.y));
    let window_x = position.as_ref().map(|point| point.x);
    let window_y = position.as_ref().map(|point| point.y);
    let window_width = size.as_ref().map(|size| size.width);
    let window_height = size.as_ref().map(|size| size.height);
    json!({
        "cursor": {
            "x": cursor_x,
            "y": cursor_y,
        },
        "monitor": monitor_value,
        "window": {
            "x": window_x,
            "y": window_y,
            "width": window_width,
            "height": window_height,
        },
    })
}

pub(super) fn observe_hidden_window(app: &AppHandle<Wry>) -> (Option<bool>, Option<bool>) {
    let Ok(window) = crate::window::main_window(app) else {
        return (None, None);
    };
    (window.is_visible().ok(), window.is_focused().ok())
}

fn alternate(position: i32, minimum: i32, maximum: i32) -> i32 {
    if position < maximum {
        position.saturating_add(64).min(maximum)
    } else if position > minimum {
        position.saturating_sub(64).max(minimum)
    } else {
        position
    }
}

fn coordinate(value: f64) -> Option<i64> {
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        None
    } else {
        Some(value.round() as i64)
    }
}

fn monitor_value(current: &Monitor, primary: Option<&Monitor>) -> Value {
    let position = current.position();
    let size = current.size();
    let area = current.work_area();
    let is_primary =
        primary.map(|primary| primary.position() == position && primary.size() == size);
    json!({
        "x": position.x, "y": position.y,
        "width": size.width, "height": size.height,
        "workX": area.position.x, "workY": area.position.y,
        "workWidth": area.size.width, "workHeight": area.size.height,
        "scaleFactor": current.scale_factor(), "isPrimary": is_primary,
    })
}

fn empty_monitor() -> Value {
    json!({
        "x": null, "y": null, "width": null, "height": null,
        "workX": null, "workY": null, "workWidth": null, "workHeight": null,
        "scaleFactor": null, "isPrimary": null,
    })
}

fn empty_point() -> Value {
    json!({"x": null, "y": null})
}
