use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, Window};

const DEFAULT_MAIN_WINDOW_LOGICAL_WIDTH: f64 = 800.0;
const DEFAULT_MAIN_WINDOW_LOGICAL_HEIGHT: f64 = 600.0;

static MAIN_WINDOW_POSITIONS: LazyLock<
    Mutex<std::collections::HashMap<String, PhysicalPosition<i32>>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainWindowPositionStrategy {
    Remember,
    Cursor,
    Primary,
    LastActive,
}

/// Positions the main window without inspecting another application's window context.
/// This is also the path used by startup and hidden QA setup.
pub(crate) fn position_main_window(app: &AppHandle, window: &Window) -> tauri::Result<()> {
    position_main_window_with_policy(app, window, false)
}

/// Positions a foreground show, allowing `lastActive` to select a monitor from one bounded read.
pub(crate) fn position_main_window_for_foreground(
    app: &AppHandle,
    window: &Window,
) -> tauri::Result<()> {
    position_main_window_with_policy(app, window, true)
}

fn position_main_window_with_policy(
    app: &AppHandle,
    window: &Window,
    allow_external_window: bool,
) -> tauri::Result<()> {
    let strategy = main_window_position_strategy(app);
    let cursor_monitor = cursor_monitor(app);
    let monitor = match strategy {
        MainWindowPositionStrategy::Primary => app.primary_monitor()?,
        MainWindowPositionStrategy::LastActive => {
            last_active_monitor(app, allow_external_window).or(cursor_monitor)
        }
        MainWindowPositionStrategy::Cursor | MainWindowPositionStrategy::Remember => cursor_monitor,
    }
    .or(app.primary_monitor()?)
    .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return window.center();
    };

    let actual_size = window.outer_size()?;
    if strategy == MainWindowPositionStrategy::Remember {
        let key = monitor_key(&monitor);
        let mut positions = MAIN_WINDOW_POSITIONS.lock().ok();
        if let Some(positions_guard) = positions.as_mut() {
            if positions_guard.is_empty() {
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    if let Ok(Some(json)) = state.db.get_setting("atools:window_positions") {
                        if let Ok(deserialized) = serde_json::from_str::<std::collections::HashMap<String, (i32, i32)>>(&json) {
                            for (k, (x, y)) in deserialized {
                                positions_guard.insert(k, PhysicalPosition::new(x, y));
                            }
                        }
                    }
                }
            }
            if let Some(saved) = positions_guard.get(&key).copied() {
                return window.set_position(clamp_position(
                    saved,
                    actual_size,
                    monitor.work_area().position,
                    monitor.work_area().size,
                ));
            }
        }
    }

    let position = centered_default_anchor_position(
        monitor.work_area().position,
        monitor.work_area().size,
        monitor.scale_factor(),
        actual_size,
    );
    window.set_position(position)
}

pub(crate) fn remember_main_window_position(window: &Window) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let key = monitor_key(&monitor);
    if let Ok(mut positions) = MAIN_WINDOW_POSITIONS.lock() {
        positions.insert(key, position);
        if let Some(state) = window.app_handle().try_state::<crate::state::AppState>() {
            let serializable: std::collections::HashMap<&str, (i32, i32)> = positions
                .iter()
                .map(|(k, pos)| (k.as_str(), (pos.x, pos.y)))
                .collect();
            if let Ok(json) = serde_json::to_string(&serializable) {
                let _ = state.db.set_setting("atools:window_positions", &json);
            }
        }
    }
}

fn main_window_position_strategy(app: &AppHandle) -> MainWindowPositionStrategy {
    let value = app
        .try_state::<crate::state::AppState>()
        .and_then(|state| state.db.read_renderer_general_settings().ok().flatten())
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

fn cursor_monitor(app: &AppHandle) -> Option<Monitor> {
    app.cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
}

fn last_active_monitor(app: &AppHandle, allow_external_window: bool) -> Option<Monitor> {
    if !allow_external_window {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        super::position_macos::monitor_for_frontmost_external_window(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

fn monitor_key(monitor: &Monitor) -> String {
    // Dock/menu-bar changes alter the work area without changing the display.
    // Keep the saved point and clamp it to the new work area when restoring.
    let origin = monitor.position();
    let size = monitor.size();
    format!("{}:{}:{}:{}", origin.x, origin.y, size.width, size.height)
}

fn centered_default_anchor_position(
    work_origin: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    scale_factor: f64,
    actual_window_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let centered = match logical_center_offsets(work_size, scale_factor) {
        Some(offset) => PhysicalPosition::new(
            work_origin.x.saturating_add(offset.x),
            work_origin.y.saturating_add(offset.y),
        ),
        None => center_size_in_work_area(work_origin, work_size, actual_window_size),
    };
    clamp_position(centered, actual_window_size, work_origin, work_size)
}

fn logical_center_offsets(
    work_size: PhysicalSize<u32>,
    scale_factor: f64,
) -> Option<PhysicalPosition<i32>> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return None;
    }
    Some(PhysicalPosition::new(
        logical_center_offset(
            work_size.width,
            DEFAULT_MAIN_WINDOW_LOGICAL_WIDTH,
            scale_factor,
        )?,
        logical_center_offset(
            work_size.height,
            DEFAULT_MAIN_WINDOW_LOGICAL_HEIGHT,
            scale_factor,
        )?,
    ))
}

fn logical_center_offset(
    physical_work_extent: u32,
    logical_anchor_extent: f64,
    scale_factor: f64,
) -> Option<i32> {
    let logical_work_extent = physical_work_extent as f64 / scale_factor;
    let logical_offset = ((logical_work_extent - logical_anchor_extent) / 2.0).floor();
    // tao's dpi::Pixel::from_f64 rounds logical-to-physical integer coordinates.
    let physical_offset = (logical_offset * scale_factor).round();
    if !logical_work_extent.is_finite()
        || !logical_offset.is_finite()
        || !physical_offset.is_finite()
        || physical_offset < i32::MIN as f64
        || physical_offset > i32::MAX as f64
    {
        return None;
    }
    Some(physical_offset as i32)
}

fn center_size_in_work_area(
    origin: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    anchor_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let x_offset = work_size.width.saturating_sub(anchor_size.width) / 2;
    let y_offset = work_size.height.saturating_sub(anchor_size.height) / 2;
    PhysicalPosition::new(
        origin
            .x
            .saturating_add(x_offset.min(i32::MAX as u32) as i32),
        origin
            .y
            .saturating_add(y_offset.min(i32::MAX as u32) as i32),
    )
}

fn clamp_position(
    position: PhysicalPosition<i32>,
    actual_window_size: PhysicalSize<u32>,
    work_origin: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let max_x = work_origin.x.saturating_add(
        work_size
            .width
            .saturating_sub(actual_window_size.width)
            .min(i32::MAX as u32) as i32,
    );
    let max_y = work_origin.y.saturating_add(
        work_size
            .height
            .saturating_sub(actual_window_size.height)
            .min(i32::MAX as u32) as i32,
    );
    PhysicalPosition::new(
        position.x.max(work_origin.x).min(max_x.max(work_origin.x)),
        position.y.max(work_origin.y).min(max_y.max(work_origin.y)),
    )
}

#[cfg(test)]
#[path = "position_tests.rs"]
mod tests;
