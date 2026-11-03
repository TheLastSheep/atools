use super::*;

fn native(logical_width: f64, logical_height: f64, scale: f64) -> Value {
    json!({"scaleFactor":scale,"decorations":false,"logical":{"width":logical_width,"height":logical_height},
            "physical":{"width":(logical_width*scale) as u64,"height":(logical_height*scale) as u64}})
}
fn configured_main() -> ConfiguredMainWindow {
    ConfiguredMainWindow {
        size: LogicalWindowSize {
            width: 800.,
            height: 320.,
        },
        decorations: false,
    }
}
fn base_report() -> (Value, Value, Value, Value) {
    let report = json!({"geometry":{"canvas":{"width":528,"height":480,"zoom":1},
            "container":{"left":136,"top":0,"right":664,"bottom":480,"width":528,"height":480},
            "child":{"innerWidth":800,"innerHeight":520,"devicePixelRatio":2}},
            "parentViewportInitial":{"innerWidth":800,"innerHeight":320,"devicePixelRatio":2},
            "parentViewportFinal":{"innerWidth":800,"innerHeight":560,"devicePixelRatio":2},"activationWindowHeight":541});
    (
        report,
        native(800., 320., 2.),
        native(800., 560., 2.),
        json!({"received":2,"handlerAccepted":2,"handlerNotMatched":0}),
    )
}

#[test]
fn main_window_config_is_selected_and_bounded() {
    let config = [
        WindowConfigSize {
            label: "settings",
            width: 900.,
            height: 600.,
            decorations: true,
        },
        WindowConfigSize {
            label: "main",
            width: 800.,
            height: 320.,
            decorations: false,
        },
    ];
    assert_eq!(
        configured_main_window_size(&config).unwrap(),
        configured_main()
    );
    assert_eq!(configured_main().decorations, false);
    assert_eq!(
        configured_main_window_size(&[]).unwrap_err(),
        "main-window-config-missing"
    );
    assert_eq!(
        configured_main_window_size(&[config[1], config[1]]).unwrap_err(),
        "main-window-config-ambiguous"
    );
    assert_eq!(
        configured_main_window_size(&[WindowConfigSize {
            width: f64::INFINITY,
            ..config[1]
        }])
        .unwrap_err(),
        "main-window-config-size-invalid"
    );
}

#[test]
fn native_parent_child_and_canvas_dimensions_require_exact_viewport_and_configured_decorations() {
    let (report, initial, final_size, receipt) = base_report();
    assert!(production_window_geometry_passed(
        &report,
        configured_main(),
        &initial,
        &final_size,
        Some(541),
        &receipt
    ));
    let mut viewport_inset = report.clone();
    viewport_inset["parentViewportInitial"]["innerHeight"] = json!(288);
    viewport_inset["parentViewportFinal"]["innerHeight"] = json!(528);
    assert!(!production_window_geometry_passed(
        &viewport_inset,
        configured_main(),
        &initial,
        &final_size,
        Some(541),
        &receipt
    ));
    let mut decoration_mismatch = final_size.clone();
    decoration_mismatch["decorations"] = json!(true);
    assert!(!production_window_geometry_passed(
        &report,
        configured_main(),
        &initial,
        &decoration_mismatch,
        Some(541),
        &receipt
    ));
    let mut oversize_child = report.clone();
    oversize_child["geometry"]["child"]["innerHeight"] = json!(562);
    assert!(!production_window_geometry_passed(
        &oversize_child,
        configured_main(),
        &initial,
        &final_size,
        Some(541),
        &receipt
    ));
    let mut wrong_physical = final_size.clone();
    wrong_physical["physical"]["width"] = json!(1599);
    assert!(!production_window_geometry_passed(
        &report,
        configured_main(),
        &initial,
        &wrong_physical,
        Some(541),
        &receipt
    ));
}

#[test]
fn scale_uses_strict_tolerance_independent_of_pixel_size_tolerance() {
    assert!(near(10.0, 10.5));
    assert!(!near_scale(1.0, 2.0));
    let (mut report, initial, final_size, receipt) = base_report();
    report["geometry"]["child"]["devicePixelRatio"] = json!(1.0);
    assert!(!production_window_geometry_passed(
        &report,
        configured_main(),
        &initial,
        &final_size,
        Some(541),
        &receipt
    ));
}

#[test]
fn output_and_visible_rects_are_checked_with_consistent_boxes() {
    let mut report = base_report().0;
    report["exportWidth"] = json!(528);
    report["exportHeight"] = json!(480);
    report["imageBounds"] =
        json!({"left":0,"top":0,"right":528,"bottom":480,"width":528,"height":480});
    report["annotationBounds"] =
        json!({"left":0,"top":0,"right":528,"bottom":480,"width":528,"height":480});
    assert!(reported_export_matches_canvas(&report));
    assert!(visible_canvas_object(&report, "imageBounds"));
    let mut outside = report.clone();
    outside["annotationBounds"] =
        json!({"left":0,"top":0,"right":530,"bottom":480,"width":530,"height":480});
    assert!(!visible_canvas_object(&outside, "annotationBounds"));
    let mut inconsistent = report.clone();
    inconsistent["annotationBounds"] =
        json!({"left":0,"top":0,"right":528,"bottom":480,"width":526,"height":480});
    assert!(!visible_canvas_object(&inconsistent, "annotationBounds"));
}

#[test]
fn hosted_panel_document_loads_production_global_css_and_sized_mount_root() {
    let css = include_str!("../../../src/styles/global.css");
    let html = fixture_document(css, "default-src 'self'");
    assert!(html.contains(css));
    assert!(html.contains("html,body{width:100%;height:100%;margin:0;overflow:hidden}"));
    assert!(html.contains(
        "#app{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0}"
    ));
    assert!(html.contains("id=\"app\""));
    assert!(html.contains("atools-image-toolbox://localhost/panel.js"));
}
