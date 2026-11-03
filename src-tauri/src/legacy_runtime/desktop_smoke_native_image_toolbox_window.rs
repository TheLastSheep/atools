//! Tauri-only window adapter for pure Image-Toolbox geometry contracts.
use serde_json::{json, Value};
use tauri::{utils::config::WindowConfig, WebviewWindow};

use super::native_image_toolbox_window_contract::{self as contract, WindowConfigSize};
pub(super) use super::native_image_toolbox_window_contract::{
    evaluate_window_geometry, matches_export_canvas, original_export_passed,
    production_window_geometry_passed, reported_export_matches_canvas, visible_canvas_object,
    ConfiguredMainWindow,
};

const PRODUCTION_GLOBAL_CSS: &str = include_str!("../../../src/styles/global.css");

/// Reads the production main-window dimensions before the smoke clears startup windows.
pub(super) fn configured_main_window_size(
    windows: &[WindowConfig],
) -> Result<ConfiguredMainWindow, &'static str> {
    let rows = windows
        .iter()
        .map(|window| WindowConfigSize {
            label: window.label.as_str(),
            width: window.width,
            height: window.height,
            decorations: window.decorations,
        })
        .collect::<Vec<_>>();
    contract::configured_main_window_size(&rows)
}

/// Reports native physical/logical dimensions and scale; unavailable measurements stay null.
pub(super) fn measure_window(window: &WebviewWindow) -> Value {
    let scale = window
        .scale_factor()
        .ok()
        .filter(|value| value.is_finite() && (0.1..=16.0).contains(value));
    let physical = window.inner_size().ok();
    let logical_width = physical
        .zip(scale)
        .map(|(size, scale)| f64::from(size.width) / scale);
    let logical_height = physical
        .zip(scale)
        .map(|(size, scale)| f64::from(size.height) / scale);
    json!({"scaleFactor":scale,
        "physical":{"width":physical.map(|size|size.width),"height":physical.map(|size|size.height)},
        "logical":{"width":logical_width,"height":logical_height},"decorations":window.is_decorated().ok()})
}

pub(super) fn fixture_document(csp: &str) -> String {
    contract::fixture_document(PRODUCTION_GLOBAL_CSS, csp)
}
