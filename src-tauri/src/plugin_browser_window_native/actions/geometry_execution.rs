//! Geometry actions with one measured frame conversion and an actual native
//! readback. The backend seam keeps policy testable without Tauri or a GUI.

use serde_json::{json, Value};
use tauri::{
    LogicalPosition, LogicalSize, PixelUnit, Position, Size, WebviewWindow, WindowSizeConstraints,
};

use crate::plugin_browser_window_native::{
    size_policy::{ConstraintBasis, FrameMetrics, NativeConstraints},
    snapshot::{native_error, snapshot_now, NativeSnapshot},
};

use super::geometry::GeometryAction;

pub(super) trait GeometryBackend {
    fn frame_metrics(&mut self) -> Result<FrameMetrics, String>;
    /// Raw adapter mirror, which may still be in the constructor's basis.
    fn constraints(&mut self) -> NativeConstraints;
    fn set_inner_size(&mut self, size: [f64; 2]) -> Result<(), String>;
    fn set_outer_position(&mut self, position: [f64; 2]) -> Result<(), String>;
    fn center(&mut self) -> Result<(), String>;
    fn set_inner_constraints(&mut self, constraints: NativeConstraints) -> Result<(), String>;
    /// Store the canonical outer-basis mirror only after Tauri accepts update.
    fn remember_constraints(&mut self, constraints: NativeConstraints);
    fn snapshot(&mut self) -> Result<NativeSnapshot, String>;
}

/// Execute one parsed action against a backend, then derive both returned
/// values from one actual snapshot. A successful setter only means the native
/// request was accepted; these values describe what is observed immediately.
pub(super) fn execute<B: GeometryBackend>(
    backend: &mut B,
    action: &GeometryAction,
) -> Result<Value, String> {
    match action {
        GeometryAction::SetBounds {
            x,
            y,
            width,
            height,
        } => {
            let metrics = backend.frame_metrics()?;
            let _inner_constraints = validated_inner_constraints(backend, metrics)?;
            let content = metrics.content_size_for_outer([*width, *height])?;
            backend.set_inner_size(content)?;
            backend
                .set_outer_position([*x, *y])
                .map_err(|error| partial_bounds_error(error))?;
        }
        GeometryAction::SetSize { width, height } => {
            let metrics = backend.frame_metrics()?;
            let _inner_constraints = validated_inner_constraints(backend, metrics)?;
            let content = metrics.content_size_for_outer([*width, *height])?;
            backend.set_inner_size(content)?;
        }
        GeometryAction::SetContentSize { width, height } => {
            let metrics = backend.frame_metrics()?;
            let _inner_constraints = validated_inner_constraints(backend, metrics)?;
            let content = metrics.validate_content_size([*width, *height])?;
            backend.set_inner_size(content)?;
        }
        GeometryAction::SetPosition { x, y } => backend.set_outer_position([*x, *y])?,
        GeometryAction::Center => backend.center()?,
        GeometryAction::SetMinimumSize { width, height } => {
            set_constraints(backend, |mut outer| {
                outer.min_width = *width;
                outer.min_height = *height;
                outer
            })?;
        }
        GeometryAction::SetMaximumSize { width, height } => {
            set_constraints(backend, |mut outer| {
                outer.max_width = *width;
                outer.max_height = *height;
                outer
            })?;
        }
        GeometryAction::GetBounds
        | GeometryAction::GetSize
        | GeometryAction::GetContentSize
        | GeometryAction::GetMinimumSize
        | GeometryAction::GetMaximumSize
        | GeometryAction::GetPosition => {}
    }

    let snapshot = backend.snapshot()?;
    let value = value_from_snapshot(&snapshot, action).ok_or_else(|| {
        "ERR_ATOOLS_NATIVE_WINDOW_ACTION_RESULT: missing geometry readback".to_string()
    })?;
    Ok(json!({"value": value, "snapshot": snapshot.to_value()?}))
}

pub(super) fn execute_window(
    window: &WebviewWindow,
    action: &GeometryAction,
) -> Result<Value, String> {
    let mut backend = TauriGeometryBackend { window };
    execute(&mut backend, action)
}

fn set_constraints<B, F>(backend: &mut B, update: F) -> Result<(), String>
where
    B: GeometryBackend,
    F: FnOnce(NativeConstraints) -> NativeConstraints,
{
    let metrics = backend.frame_metrics()?;
    let current_outer = metrics.outer_constraints(backend.constraints())?;
    let mut next_outer = update(current_outer);
    next_outer.basis = ConstraintBasis::Outer;
    next_outer.validate()?;
    let next_inner = metrics.inner_constraints(next_outer)?;
    backend.set_inner_constraints(next_inner)?;
    backend.remember_constraints(next_outer);
    Ok(())
}

fn validated_inner_constraints<B>(
    backend: &mut B,
    metrics: FrameMetrics,
) -> Result<NativeConstraints, String>
where
    B: GeometryBackend,
{
    metrics.inner_constraints(backend.constraints())
}

fn value_from_snapshot(snapshot: &NativeSnapshot, action: &GeometryAction) -> Option<Value> {
    match action {
        GeometryAction::SetBounds { .. } => serde_json::to_value(&snapshot.bounds).ok(),
        GeometryAction::SetSize { .. } => {
            Some(json!([snapshot.bounds.width, snapshot.bounds.height]))
        }
        GeometryAction::SetContentSize { .. } => Some(json!([
            snapshot.content_bounds.width,
            snapshot.content_bounds.height
        ])),
        GeometryAction::SetPosition { .. } => Some(json!([snapshot.bounds.x, snapshot.bounds.y])),
        GeometryAction::SetMinimumSize { .. } | GeometryAction::GetMinimumSize => {
            Some(json!(snapshot.minimum_size))
        }
        GeometryAction::SetMaximumSize { .. } | GeometryAction::GetMaximumSize => {
            Some(json!(snapshot.maximum_size))
        }
        GeometryAction::Center => super::geometry::centered_value(snapshot, action),
        _ => super::geometry::read(snapshot, action),
    }
}

fn partial_bounds_error(error: String) -> String {
    format!(
        "ERR_ATOOLS_NATIVE_WINDOW_PARTIAL_BOUNDS: size request may already have been applied; position failed: {error}"
    )
}

struct TauriGeometryBackend<'a> {
    window: &'a WebviewWindow,
}

impl GeometryBackend for TauriGeometryBackend<'_> {
    fn frame_metrics(&mut self) -> Result<FrameMetrics, String> {
        let scale = self.window.scale_factor().map_err(native_error)?;
        let outer = self.window.outer_size().map_err(native_error)?;
        let inner = self.window.inner_size().map_err(native_error)?;
        FrameMetrics::new(
            scale,
            [outer.width, outer.height],
            [inner.width, inner.height],
        )
    }

    fn constraints(&mut self) -> NativeConstraints {
        super::super::snapshot::current_constraints(self.window.label())
    }

    fn set_inner_size(&mut self, size: [f64; 2]) -> Result<(), String> {
        self.window
            .set_size(Size::Logical(LogicalSize::new(size[0], size[1])))
            .map_err(native_error)
    }

    fn set_outer_position(&mut self, position: [f64; 2]) -> Result<(), String> {
        self.window
            .set_position(Position::Logical(LogicalPosition::new(
                position[0],
                position[1],
            )))
            .map_err(native_error)
    }

    fn center(&mut self) -> Result<(), String> {
        self.window.center().map_err(native_error)
    }

    fn set_inner_constraints(&mut self, constraints: NativeConstraints) -> Result<(), String> {
        self.window
            .set_size_constraints(to_native_constraints(constraints))
            .map_err(native_error)
    }

    fn remember_constraints(&mut self, constraints: NativeConstraints) {
        super::super::snapshot::remember_constraints(self.window.label(), constraints);
    }

    fn snapshot(&mut self) -> Result<NativeSnapshot, String> {
        snapshot_now(self.window)
    }
}

fn to_native_constraints(value: NativeConstraints) -> WindowSizeConstraints {
    fn unit(value: Option<f64>) -> Option<PixelUnit> {
        value
            .filter(|value| *value > 0.0)
            .map(|value| PixelUnit::Logical(value.into()))
    }
    WindowSizeConstraints {
        min_width: unit(value.min_width),
        min_height: unit(value.min_height),
        max_width: unit(value.max_width),
        max_height: unit(value.max_height),
    }
}
