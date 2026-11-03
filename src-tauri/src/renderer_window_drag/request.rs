use serde::Deserialize;
use tauri::{PhysicalPosition, PhysicalSize};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "operation", deny_unknown_fields)]
pub(crate) enum Request {
    #[serde(rename = "position")]
    Position {},
    #[serde(rename = "lock")]
    Lock { locked: bool },
    #[serde(rename = "move")]
    Move { x: f64, y: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Position {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

/// Logical content size, matching Tauri's window set_size units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct WindowSize {
    pub(super) width: f64,
    pub(super) height: f64,
}

pub(super) const INVALID_GEOMETRY: &str = "window drag geometry is invalid";
pub(super) const CALLER_REJECTED: &str = "renderer window drag caller rejected";

pub(super) fn is_main_caller(webview_label: &str, window_label: &str) -> bool {
    webview_label == "main" && window_label == "main"
}

pub(super) fn valid_scale_factor(scale: f64) -> Result<f64, &'static str> {
    if scale.is_finite() && scale > 0.0 {
        Ok(scale)
    } else {
        Err(INVALID_GEOMETRY)
    }
}

pub(super) fn logical_position(
    physical: PhysicalPosition<i32>,
    scale: f64,
) -> Result<Position, &'static str> {
    let scale = valid_scale_factor(scale)?;
    let position = Position {
        x: f64::from(physical.x) / scale,
        y: f64::from(physical.y) / scale,
    };
    if position.x.is_finite() && position.y.is_finite() {
        Ok(position)
    } else {
        Err(INVALID_GEOMETRY)
    }
}

pub(super) fn logical_size(
    physical: PhysicalSize<u32>,
    scale: f64,
) -> Result<WindowSize, &'static str> {
    let scale = valid_scale_factor(scale)?;
    if physical.width == 0 || physical.height == 0 {
        return Err(INVALID_GEOMETRY);
    }
    let size = WindowSize {
        width: f64::from(physical.width) / scale,
        height: f64::from(physical.height) / scale,
    };
    validate_window_size(size, scale)
}

pub(super) fn validate_window_size(
    size: WindowSize,
    scale: f64,
) -> Result<WindowSize, &'static str> {
    let scale = valid_scale_factor(scale)?;
    let physical_width = size.width * scale;
    let physical_height = size.height * scale;
    if size.width.is_finite()
        && size.height.is_finite()
        && size.width > 0.0
        && size.height > 0.0
        && physical_width.is_finite()
        && physical_height.is_finite()
        && physical_width >= 1.0
        && physical_height >= 1.0
        && physical_width <= f64::from(u32::MAX)
        && physical_height <= f64::from(u32::MAX)
    {
        Ok(size)
    } else {
        Err(INVALID_GEOMETRY)
    }
}

pub(super) fn validate_position(x: f64, y: f64, scale: f64) -> Result<Position, &'static str> {
    let scale = valid_scale_factor(scale)?;
    let position = Position { x, y };
    if coordinate_is_representable(x, scale) && coordinate_is_representable(y, scale) {
        Ok(position)
    } else {
        Err(INVALID_GEOMETRY)
    }
}

fn coordinate_is_representable(value: f64, scale: f64) -> bool {
    let physical = value * scale;
    value.is_finite()
        && physical.is_finite()
        && physical >= f64::from(i32::MIN)
        && physical <= f64::from(i32::MAX)
}

pub(super) fn main_local_root_url(url: &tauri::Url) -> bool {
    let local_app_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    local_app_origin
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
