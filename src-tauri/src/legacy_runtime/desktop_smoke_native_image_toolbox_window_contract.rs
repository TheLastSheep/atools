//! Pure bounded contracts for the Image-Toolbox hidden-window smoke.
use serde_json::{json, Value};

const MAX_LOGICAL_DIMENSION: f64 = 8192.0;
const ORIGINAL_APP_REQUESTED_HEIGHT: f64 = 560.0;
const SIZE_TOLERANCE: f64 = 1.0;
const SCALE_TOLERANCE: f64 = 0.000_001;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct LogicalWindowSize {
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct ConfiguredMainWindow {
    pub(super) size: LogicalWindowSize,
    pub(super) decorations: bool,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct WindowConfigSize<'a> {
    pub(super) label: &'a str,
    pub(super) width: f64,
    pub(super) height: f64,
    pub(super) decorations: bool,
}

pub(super) fn configured_main_window_size(
    windows: &[WindowConfigSize<'_>],
) -> Result<ConfiguredMainWindow, &'static str> {
    let mut main = windows.iter().filter(|window| window.label == "main");
    let window = main.next().ok_or("main-window-config-missing")?;
    if main.next().is_some() {
        return Err("main-window-config-ambiguous");
    }
    if !valid_dimension(window.width) || !valid_dimension(window.height) {
        return Err("main-window-config-size-invalid");
    }
    Ok(ConfiguredMainWindow {
        size: LogicalWindowSize {
            width: window.width,
            height: window.height,
        },
        decorations: window.decorations,
    })
}

pub(super) fn fixture_document(css: &str, csp: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=utf-8><meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\"><style>{css}</style><style>html,body{{width:100%;height:100%;margin:0;overflow:hidden}}#app{{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0}}</style><link rel=\"stylesheet\" href=\"atools-image-toolbox://localhost/panel.css\"></head><body><div id=\"app\"></div><script src=\"atools-image-toolbox://localhost/panel.js\"></script></body></html>"
    )
}

fn valid_dimension(value: f64) -> bool {
    value.is_finite() && (1.0..=MAX_LOGICAL_DIMENSION).contains(&value)
}

fn valid_coordinate(value: f64) -> bool {
    value.is_finite() && (-8192.0..=8192.0).contains(&value)
}

pub(super) fn matches_export_canvas(report: &Value, width: u32, height: u32) -> bool {
    let Some(canvas) = report.get("geometry").and_then(|value| value.get("canvas")) else {
        return false;
    };
    dimension(canvas.get("width")) == Some(width) && dimension(canvas.get("height")) == Some(height)
}

pub(super) fn original_export_passed(
    report: &Value,
    artifact_passed: bool,
    geometry_passed: bool,
    window_geometry_passed: bool,
) -> bool {
    report.get("exportDecoded").and_then(Value::as_bool) == Some(true)
        && report.get("exportFormat").and_then(Value::as_str) == Some("png")
        && reported_export_matches_canvas(report)
        && report
            .get("originalWriteImageFileAvailable")
            .and_then(Value::as_bool)
            == Some(true)
        && report
            .get("originalWriteImageFileCalled")
            .and_then(Value::as_bool)
            == Some(true)
        && report
            .get("outputFileWriteSucceeded")
            .and_then(Value::as_bool)
            == Some(true)
        && artifact_passed
        && geometry_passed
        && window_geometry_passed
        && visible_canvas_object(report, "imageBounds")
        && visible_canvas_object(report, "annotationBounds")
}

pub(super) fn reported_export_matches_canvas(report: &Value) -> bool {
    let width = report
        .get("exportWidth")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    let height = report
        .get("exportHeight")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    width
        .zip(height)
        .is_some_and(|(width, height)| matches_export_canvas(report, width, height))
}

fn dimension(value: Option<&Value>) -> Option<u32> {
    let value = value?.as_f64()?;
    if !value.is_finite() || value < 1.0 || value > MAX_LOGICAL_DIMENSION || value.fract() != 0.0 {
        return None;
    }
    Some(value as u32)
}

pub(super) fn evaluate_window_geometry(
    report: &Value,
    configured: ConfiguredMainWindow,
    initial_native: &Value,
    final_native: &Value,
    receipts: &Value,
) -> (Value, bool) {
    let expand = receipts
        .get("startupCommands")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("code").and_then(Value::as_str) == Some("expand_window"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let action_height = report
        .get("activationWindowHeight")
        .and_then(Value::as_u64)
        .and_then(|height| u32::try_from(height).ok());
    let passed = production_window_geometry_passed(
        report,
        configured,
        initial_native,
        final_native,
        action_height,
        &expand,
    );
    let evidence = json!({
        "configuredMainWindow":{"logical":{"width":configured.size.width,"height":configured.size.height},"decorations":configured.decorations},
        "initialNative":initial_native,"finalNative":final_native,
        "parentViewportInitial":report.get("parentViewportInitial").unwrap_or(&Value::Null),
        "parentViewportFinal":report.get("parentViewportFinal").unwrap_or(&Value::Null),
        "activationWindowHeight":action_height,"expandWindowHandlerReceipt":expand,"passed":passed
    });
    (evidence, passed)
}

pub(super) fn production_window_geometry_passed(
    report: &Value,
    configured: ConfiguredMainWindow,
    initial_native: &Value,
    final_native: &Value,
    activation_height: Option<u32>,
    height_receipt: &Value,
) -> bool {
    let Some(initial) = native_geometry(initial_native) else {
        return false;
    };
    let Some(final_size) = native_geometry(final_native) else {
        return false;
    };
    let parent_start = report.get("parentViewportInitial").and_then(viewport);
    let parent_end = report.get("parentViewportFinal").and_then(viewport);
    let child = report.get("geometry").and_then(|value| value.get("child"));
    let parent_initial_dpr = report
        .get("parentViewportInitial")
        .and_then(|value| finite_scale(value.get("devicePixelRatio")));
    let parent_final_dpr = report
        .get("parentViewportFinal")
        .and_then(|value| finite_scale(value.get("devicePixelRatio")));
    let child_dpr = child.and_then(|value| finite_scale(value.get("devicePixelRatio")));
    let (Some(child_width), Some(child_height)) = (
        dimension(child.and_then(|value| value.get("innerWidth"))),
        dimension(child.and_then(|value| value.get("innerHeight"))),
    ) else {
        return false;
    };
    let Some((parent_initial_width, parent_initial_height)) = parent_start else {
        return false;
    };
    let Some((parent_final_width, parent_final_height)) = parent_end else {
        return false;
    };
    activation_height == Some(541)
        && initial.decorations == configured.decorations
        && final_size.decorations == configured.decorations
        && near(initial.logical_width, configured.size.width)
        && near(initial.logical_height, configured.size.height)
        && near(parent_initial_width, configured.size.width)
        && near(parent_initial_height, configured.size.height)
        && near(final_size.logical_width, configured.size.width)
        && near(final_size.logical_height, ORIGINAL_APP_REQUESTED_HEIGHT)
        && near(parent_final_width, final_size.logical_width)
        && near(parent_final_height, final_size.logical_height)
        // PluginPanel contains its own header; the hosted plugin iframe is narrower
        // only when measured, and never claims more viewport than its parent.
        && child_width as f64 <= parent_final_width + SIZE_TOLERANCE
        && child_height as f64 <= parent_final_height + SIZE_TOLERANCE
        && canvas_matches_container(report)
        && near_scale(initial.scale, parent_initial_dpr.unwrap_or(f64::NAN))
        && near_scale(final_size.scale, parent_final_dpr.unwrap_or(f64::NAN))
        && near_scale(final_size.scale, child_dpr.unwrap_or(f64::NAN))
        && receipt_is_exact(height_receipt)
}

#[derive(Clone, Copy)]
struct NativeGeometry {
    logical_width: f64,
    logical_height: f64,
    scale: f64,
    decorations: bool,
}

fn native_geometry(value: &Value) -> Option<NativeGeometry> {
    let logical = value.get("logical")?;
    let physical = value.get("physical")?;
    let logical_width = finite_dimension(logical.get("width"))?;
    let logical_height = finite_dimension(logical.get("height"))?;
    let scale = finite_scale(value.get("scaleFactor"))?;
    let decorations = value.get("decorations")?.as_bool()?;
    let physical_width = physical.get("width")?.as_u64()? as f64;
    let physical_height = physical.get("height")?.as_u64()? as f64;
    if !near_scale(physical_width, logical_width * scale)
        || !near_scale(physical_height, logical_height * scale)
    {
        return None;
    }
    Some(NativeGeometry {
        logical_width,
        logical_height,
        scale,
        decorations,
    })
}

fn receipt_is_exact(receipt: &Value) -> bool {
    receipt.get("received").and_then(Value::as_u64) == Some(2)
        && receipt.get("handlerAccepted").and_then(Value::as_u64) == Some(2)
        && receipt.get("handlerNotMatched").and_then(Value::as_u64) == Some(0)
}

fn canvas_matches_container(report: &Value) -> bool {
    let geometry = report.get("geometry");
    let canvas = geometry.and_then(|value| value.get("canvas"));
    let container = geometry.and_then(|value| value.get("container"));
    let (
        Some(canvas_width),
        Some(canvas_height),
        Some(left),
        Some(top),
        Some(right),
        Some(bottom),
        Some(width),
        Some(height),
    ) = (
        canvas.and_then(|value| finite_dimension(value.get("width"))),
        canvas.and_then(|value| finite_dimension(value.get("height"))),
        container.and_then(|value| coordinate(value.get("left"))),
        container.and_then(|value| coordinate(value.get("top"))),
        container.and_then(|value| coordinate(value.get("right"))),
        container.and_then(|value| coordinate(value.get("bottom"))),
        container.and_then(|value| finite_dimension(value.get("width"))),
        container.and_then(|value| finite_dimension(value.get("height"))),
    )
    else {
        return false;
    };
    near(canvas_width, width)
        && near(canvas_height, height)
        && near(right - left, width)
        && near(bottom - top, height)
}

fn viewport(value: &Value) -> Option<(f64, f64)> {
    Some((
        finite_dimension(value.get("innerWidth"))?,
        finite_dimension(value.get("innerHeight"))?,
    ))
}
fn finite_scale(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    (value.is_finite() && (0.1..=16.0).contains(&value)).then_some(value)
}
fn finite_dimension(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    valid_dimension(value).then_some(value)
}
fn coordinate(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    valid_coordinate(value).then_some(value)
}
fn near(left: f64, right: f64) -> bool {
    left.is_finite() && right.is_finite() && (left - right).abs() <= SIZE_TOLERANCE
}
fn near_scale(left: f64, right: f64) -> bool {
    left.is_finite() && right.is_finite() && (left - right).abs() <= SCALE_TOLERANCE
}

pub(super) fn visible_canvas_object(report: &Value, key: &str) -> bool {
    let Some(bounds) = report.get(key) else {
        return false;
    };
    let Some(canvas) = report.get("geometry").and_then(|value| value.get("canvas")) else {
        return false;
    };
    let (Some(width), Some(height)) = (
        finite_dimension(canvas.get("width")),
        finite_dimension(canvas.get("height")),
    ) else {
        return false;
    };
    let (Some(left), Some(top), Some(right), Some(bottom), Some(box_width), Some(box_height)) = (
        coordinate(bounds.get("left")),
        coordinate(bounds.get("top")),
        coordinate(bounds.get("right")),
        coordinate(bounds.get("bottom")),
        finite_dimension(bounds.get("width")),
        finite_dimension(bounds.get("height")),
    ) else {
        return false;
    };
    left >= 0.0
        && top >= 0.0
        && right > left
        && bottom > top
        && near(right - left, box_width)
        && near(bottom - top, box_height)
        && right <= width + SIZE_TOLERANCE
        && bottom <= height + SIZE_TOLERANCE
}

#[cfg(test)]
#[path = "desktop_smoke_native_image_toolbox_window_contract_tests.rs"]
mod tests;
