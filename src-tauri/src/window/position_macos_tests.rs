use super::{
    tao_monitor_matches_display, tao_physical_origin, unique_display_for_point,
    unique_tao_monitor_index, DisplayGeometry, LogicalBounds, LogicalPoint, TaoMonitorGeometry,
};
use tauri::PhysicalPosition;

#[test]
fn external_window_center_selects_the_unique_cg_display_in_global_coordinates() {
    let displays = [
        DisplayGeometry {
            display_id: 10,
            bounds: LogicalBounds {
                x: -1280.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            },
        },
        DisplayGeometry {
            display_id: 20,
            bounds: LogicalBounds {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
        },
    ];

    let selected = unique_display_for_point(
        LogicalPoint {
            x: -640.0,
            y: 400.0,
        },
        &displays,
    )
    .unwrap();
    assert_eq!(selected.display_id, 10);
    assert_eq!(
        tao_physical_origin(selected.bounds, 2.0),
        Some(PhysicalPosition::new(-2560, 0))
    );
    assert_eq!(
        tao_physical_origin(displays[1].bounds, 1.0),
        Some(PhysicalPosition::new(0, 0)),
        "each candidate uses its own scale, so adjacent mixed-DPI displays are not globally scaled"
    );
}

#[test]
fn overlapping_or_unmatched_display_geometry_falls_back_instead_of_guessing() {
    let overlapping = [
        DisplayGeometry {
            display_id: 1,
            bounds: LogicalBounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 700.0,
            },
        },
        DisplayGeometry {
            display_id: 2,
            bounds: LogicalBounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 700.0,
            },
        },
    ];
    assert!(unique_display_for_point(LogicalPoint { x: 50.0, y: 50.0 }, &overlapping).is_none());
    assert!(unique_display_for_point(LogicalPoint { x: 1200.0, y: 50.0 }, &overlapping).is_none());
}

#[test]
fn tao_monitor_mapping_matches_model_and_candidate_scaled_physical_origin_uniquely() {
    let display = DisplayGeometry {
        display_id: 4,
        bounds: LogicalBounds {
            x: -1280.0,
            y: 20.5,
            width: 1280.0,
            height: 800.0,
        },
    };
    let retina = TaoMonitorGeometry {
        name: Some("Monitor #77"),
        position: PhysicalPosition::new(-2560, 41),
        scale_factor: 2.0,
    };
    let wrong_model = TaoMonitorGeometry {
        name: Some("Monitor #78"),
        ..retina
    };
    let lower_scale_candidate = TaoMonitorGeometry {
        position: PhysicalPosition::new(-1280, 21),
        scale_factor: 1.0,
        ..retina
    };
    assert!(tao_monitor_matches_display(
        &display,
        "Monitor #77",
        &retina
    ));
    assert!(!tao_monitor_matches_display(
        &display,
        "Monitor #77",
        &wrong_model
    ));
    assert!(tao_monitor_matches_display(
        &display,
        "Monitor #77",
        &lower_scale_candidate
    ));
    assert_eq!(
        unique_tao_monitor_index(&display, "Monitor #77", &[retina]),
        Some(0)
    );
    assert!(
        unique_tao_monitor_index(&display, "Monitor #77", &[retina, lower_scale_candidate])
            .is_none()
    );
}
