use super::{centered_default_anchor_position, clamp_position};
use tauri::{PhysicalPosition, PhysicalSize};

#[test]
fn default_anchor_uses_eight_hundred_by_six_hundred_logical_points_not_compact_extent() {
    let work_origin = PhysicalPosition::new(-1920, -100);
    let work_size = PhysicalSize::new(1920, 1080);
    let compact_extent = PhysicalSize::new(800, 58);

    let actual = centered_default_anchor_position(work_origin, work_size, 1.0, compact_extent);
    assert_eq!(actual, PhysicalPosition::new(-1360, 140));
    assert_ne!(
        actual.y,
        work_origin.y + (work_size.height - compact_extent.height) as i32 / 2,
        "the original launcher anchors at its default 600 logical point height"
    );
}

#[test]
fn retina_anchor_uses_the_selected_monitor_scale_and_preserves_negative_origins() {
    let work_origin = PhysicalPosition::new(-3200, -120);
    let work_size = PhysicalSize::new(3200, 1800);
    let compact_extent = PhysicalSize::new(1600, 116);

    assert_eq!(
        centered_default_anchor_position(work_origin, work_size, 2.0, compact_extent),
        PhysicalPosition::new(-2400, 180)
    );
}

#[test]
fn actual_extent_clamps_anchor_only_when_needed_for_a_short_work_area() {
    let work_origin = PhysicalPosition::new(-400, -300);
    let work_size = PhysicalSize::new(1000, 500);
    let compact_extent = PhysicalSize::new(800, 200);

    assert_eq!(
        centered_default_anchor_position(work_origin, work_size, 2.0, compact_extent),
        work_origin,
        "the oversized default anchor is centered first, then the visible window is clamped"
    );
    assert_eq!(
        clamp_position(
            PhysicalPosition::new(900, -900),
            PhysicalSize::new(1400, 600),
            work_origin,
            work_size,
        ),
        work_origin,
        "if actual extents exceed the work area, place the top-left at the work-area origin"
    );
}

#[test]
fn fractional_scale_floors_logical_offsets_before_clamping_actual_extent() {
    let work_origin = PhysicalPosition::new(40, 70);
    let work_size = PhysicalSize::new(1500, 901);
    let actual_size = PhysicalSize::new(900, 500);

    assert_eq!(
        centered_default_anchor_position(work_origin, work_size, 1.5, actual_size),
        PhysicalPosition::new(190, 70)
    );
}

#[test]
fn invalid_scale_retains_actual_extent_center_fallback() {
    let work_origin = PhysicalPosition::new(-100, 50);
    let work_size = PhysicalSize::new(1000, 800);
    let actual_size = PhysicalSize::new(600, 300);

    assert_eq!(
        centered_default_anchor_position(work_origin, work_size, f64::NAN, actual_size),
        PhysicalPosition::new(100, 300)
    );
}

#[test]
fn high_dpi_centering_floors_logical_offsets_before_physical_conversion() {
    let work_origin = PhysicalPosition::new(0, 66);
    let work_size = PhysicalSize::new(3024, 1898);
    let actual_window_size = PhysicalSize::new(1600, 1200);

    assert_eq!(
        centered_default_anchor_position(work_origin, work_size, 2.0, actual_window_size),
        PhysicalPosition::new(712, 414),
        "logical work area (0, 33, 1512, 949) floors to anchor position (356, 207)"
    );
}
