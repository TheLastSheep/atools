#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ResizePlan {
    pub(super) inner_height: u32,
    pub(super) outer_y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResizeBoundsError {
    InvalidScaleFactor,
    NoUsableWorkAreaHeight,
    UnrepresentablePosition,
}

impl std::fmt::Display for ResizeBoundsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidScaleFactor => "Main window scale factor is invalid",
            Self::NoUsableWorkAreaHeight => "Monitor work area cannot fit the main window frame",
            Self::UnrepresentablePosition => "Bounded main window position is out of range",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ResizeBoundsError {}

#[cfg(test)]
pub(super) fn plan_resize(
    requested_logical_height: u32,
    scale_factor: f64,
    work_area_top: i32,
    work_area_height: u32,
    outer_frame_height: u32,
    current_outer_y: i32,
) -> Result<ResizePlan, ResizeBoundsError> {
    plan_resize_f64(
        f64::from(requested_logical_height),
        scale_factor,
        work_area_top,
        work_area_height,
        outer_frame_height,
        current_outer_y,
    )
}

pub(super) fn plan_resize_f64(
    requested_logical_height: f64,
    scale_factor: f64,
    work_area_top: i32,
    work_area_height: u32,
    outer_frame_height: u32,
    current_outer_y: i32,
) -> Result<ResizePlan, ResizeBoundsError> {
    if !requested_logical_height.is_finite() || requested_logical_height < 0.0 {
        return Err(ResizeBoundsError::NoUsableWorkAreaHeight);
    }
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err(ResizeBoundsError::InvalidScaleFactor);
    }

    let available_inner_height = work_area_height
        .checked_sub(outer_frame_height)
        .filter(|height| *height > 0)
        .ok_or(ResizeBoundsError::NoUsableWorkAreaHeight)?;
    let requested = requested_logical_height.max(58.0) * scale_factor;
    let inner_height = if !requested.is_finite() || requested >= f64::from(available_inner_height) {
        available_inner_height
    } else {
        (requested.ceil() as u32).max(1)
    };
    let outer_height = inner_height
        .checked_add(outer_frame_height)
        .ok_or(ResizeBoundsError::NoUsableWorkAreaHeight)?;

    let work_top = i64::from(work_area_top);
    let work_bottom = work_top + i64::from(work_area_height);
    let max_outer_y = work_bottom - i64::from(outer_height);
    if max_outer_y < work_top {
        return Err(ResizeBoundsError::NoUsableWorkAreaHeight);
    }
    let bounded_outer_y = i64::from(current_outer_y).clamp(work_top, max_outer_y);
    let outer_y =
        i32::try_from(bounded_outer_y).map_err(|_| ResizeBoundsError::UnrepresentablePosition)?;

    Ok(ResizePlan {
        inner_height,
        outer_y,
    })
}

#[cfg(test)]
mod tests {
    use super::{plan_resize, plan_resize_f64, ResizeBoundsError};

    #[test]
    fn preserves_current_y_when_the_resized_window_fits() {
        let plan = plan_resize(600, 1.0, 100, 900, 30, 200).unwrap();

        assert_eq!(plan.inner_height, 600);
        assert_eq!(plan.inner_height + 30, 630);
        assert_eq!(plan.outer_y, 200);
    }

    #[test]
    fn clamps_to_available_work_area_after_accounting_for_frame() {
        let plan = plan_resize(u32::MAX, 2.0, -1080, 1000, 40, 200).unwrap();

        assert_eq!(plan.inner_height, 960);
        assert_eq!(plan.inner_height + 40, 1000);
        assert_eq!(plan.outer_y, -1080);
    }

    #[test]
    fn converts_fractional_scale_and_enforces_the_logical_minimum() {
        let plan = plan_resize(0, 1.25, 0, 1000, 24, 80).unwrap();

        assert_eq!(plan.inner_height, 73);
        assert_eq!(plan.outer_y, 80);
    }

    #[test]
    fn prioritizes_tiny_work_area_over_the_logical_minimum() {
        let plan = plan_resize(0, 2.0, -50, 70, 12, -40).unwrap();

        assert_eq!(plan.inner_height, 58);
        assert_eq!(plan.inner_height + 12, 70);
        assert_eq!(plan.outer_y, -50);
    }

    #[test]
    fn moves_only_up_when_the_new_window_would_cross_the_work_area_bottom() {
        let plan = plan_resize(200, 1.0, 100, 900, 24, 800).unwrap();

        assert_eq!(plan.outer_y, 776);
        assert_eq!(
            i64::from(plan.outer_y) + i64::from(plan.inner_height) + 24,
            1000
        );
    }

    #[test]
    fn keeps_negative_display_coordinates_and_handles_large_work_area_edges() {
        let negative = plan_resize(400, 1.0, -1200, 1000, 20, -1000).unwrap();
        assert_eq!(negative.outer_y, -1000);

        let large = plan_resize(500, 1.0, i32::MAX - 100, 400, 0, i32::MAX - 50).unwrap();
        assert_eq!(large.inner_height, 400);
        assert_eq!(large.outer_y, i32::MAX - 100);
    }

    #[test]
    fn rejects_invalid_scale_and_work_area_without_guessing_dimensions() {
        assert_eq!(
            plan_resize(600, f64::NAN, 0, 900, 20, 0),
            Err(ResizeBoundsError::InvalidScaleFactor)
        );
        assert_eq!(
            plan_resize(600, 1.0, 0, 20, 20, 0),
            Err(ResizeBoundsError::NoUsableWorkAreaHeight)
        );
    }
    #[test]
    fn fractional_settings_request_keeps_header_and_parent_workarea_clipping_separate() {
        assert_eq!(
            plan_resize_f64(541.0 + 58.0, 1.0, 0, 1000, 0, 0)
                .unwrap()
                .inner_height,
            599
        );
        assert_eq!(
            plan_resize_f64(542.0 + 58.0, 1.0, 0, 1000, 0, 0)
                .unwrap()
                .inner_height,
            600
        );
        assert_eq!(
            plan_resize_f64(200.5 + 58.0, 2.0, 0, 1000, 0, 0)
                .unwrap()
                .inner_height,
            517
        );
        assert_eq!(
            plan_resize_f64(2001.0 + 58.0, 2.0, 0, 1000, 20, 0)
                .unwrap()
                .inner_height,
            980
        );
        assert!(plan_resize_f64(f64::NAN, 1.0, 0, 1000, 0, 0).is_err());
    }
}
