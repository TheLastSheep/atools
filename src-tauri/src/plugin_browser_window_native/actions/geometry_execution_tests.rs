use crate::plugin_browser_window_native::size_policy::{ConstraintBasis, NativeConstraints};
use serde_json::{json, Value};

#[path = "geometry_test_backend.rs"]
mod test_backend;

use test_backend::{Call, Failure, FakeBackend};

use super::{geometry, geometry_execution};

fn run(backend: &mut FakeBackend, action: &str, args: &[Value]) -> Result<Value, String> {
    let action = geometry::parse(action, args)?.ok_or_else(|| {
        format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: action {action:?} is not a geometry action")
    })?;
    geometry_execution::execute(backend, &action)
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.000_001,
        "{actual} != {expected}"
    );
}

fn pair(value: &Value) -> [f64; 2] {
    [
        value[0].as_f64().expect("first value should be numeric"),
        value[1].as_f64().expect("second value should be numeric"),
    ]
}

fn dimensions(value: &Value) -> [f64; 2] {
    [
        value["width"].as_f64().expect("width should be numeric"),
        value["height"].as_f64().expect("height should be numeric"),
    ]
}

#[test]
fn framed_size_and_bounds_convert_outer_size_and_return_the_same_readback() {
    let mut size_backend = FakeBackend::new(1.5, [1000, 700], [970, 652]);
    let size = run(&mut size_backend, "setSize", &[json!([641.0, 481.0])]).unwrap();
    let requested_inner = size_backend
        .calls
        .iter()
        .find_map(|call| match call {
            Call::SetInnerSize(size) => Some(*size),
            _ => None,
        })
        .expect("size setter should be called");
    close(requested_inner[0], 621.0);
    close(requested_inner[1], 449.0);
    assert_eq!(pair(&size["value"]), [641.0, 481.0]);
    close(size["snapshot"]["bounds"]["width"].as_f64().unwrap(), 641.0);
    close(
        size["snapshot"]["bounds"]["height"].as_f64().unwrap(),
        481.0,
    );

    let mut bounds_backend = FakeBackend::new(2.0, [1000, 700], [959, 639]);
    let bounds = run(
        &mut bounds_backend,
        "setBounds",
        &[json!({"x": 45.0, "y": 71.0, "width": 640.0, "height": 480.0})],
    )
    .unwrap();
    let requested_inner = bounds_backend
        .calls
        .iter()
        .find_map(|call| match call {
            Call::SetInnerSize(size) => Some(*size),
            _ => None,
        })
        .expect("bounds size setter should be called");
    close(requested_inner[0], 619.5);
    close(requested_inner[1], 449.5);
    assert_eq!(
        bounds_backend.calls,
        vec![
            Call::FrameMetrics,
            Call::Constraints,
            Call::SetInnerSize([requested_inner[0], requested_inner[1]]),
            Call::SetOuterPosition([45.0, 71.0]),
            Call::Snapshot,
        ]
    );
    assert_eq!(bounds["value"]["x"], json!(45.0));
    assert_eq!(bounds["value"]["y"], json!(71.0));
    close(bounds["value"]["width"].as_f64().unwrap(), 640.0);
    close(bounds["value"]["height"].as_f64().unwrap(), 480.0);
}

#[test]
fn content_size_and_frameless_size_use_inner_dimensions_directly() {
    let mut framed = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    let content = run(&mut framed, "setContentSize", &[json!(500.0), json!(300.0)]).unwrap();
    assert!(framed.calls.contains(&Call::SetInnerSize([500.0, 300.0])));
    assert_eq!(pair(&content["value"]), [500.0, 300.0]);
    assert_eq!(dimensions(&content["snapshot"]["bounds"]), [520.0, 330.0]);

    let mut frameless = FakeBackend::new(1.0, [1000, 700], [1000, 700]);
    let result = run(&mut frameless, "setSize", &[json!([640.0, 480.0])]).unwrap();
    assert!(frameless
        .calls
        .contains(&Call::SetInnerSize([640.0, 480.0])));
    assert_eq!(pair(&result["value"]), [640.0, 480.0]);
}

#[test]
fn observed_clamp_and_delayed_layout_are_returned_without_inventing_target() {
    let mut clamped = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    clamped.clamp_inner_size = Some([500.0, 400.0]);
    let result = run(&mut clamped, "setSize", &[json!([900.0, 700.0])]).unwrap();
    assert_eq!(pair(&result["value"]), [520.0, 430.0]);
    assert_eq!(
        dimensions(&result["snapshot"]["contentBounds"]),
        [500.0, 400.0]
    );

    let mut delayed = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    delayed.defer_inner_size = true;
    let result = run(&mut delayed, "setSize", &[json!([900.0, 700.0])]).unwrap();
    assert_eq!(pair(&result["value"]), [820.0, 620.0]);
    assert_eq!(dimensions(&result["snapshot"]["bounds"]), [820.0, 620.0]);
    assert!(delayed.calls.contains(&Call::SetInnerSize([880.0, 670.0])));
}

#[test]
fn getter_values_come_from_one_snapshot_without_geometry_sampling_or_ipc_writes() {
    let mut backend = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    let result = run(&mut backend, "getContentSize", &[]).unwrap();
    assert_eq!(pair(&result["value"]), [800.0, 590.0]);
    assert_eq!(backend.calls, vec![Call::Snapshot]);
}

#[test]
fn content_basis_initial_constraints_merge_in_outer_space_then_convert_once() {
    let mut backend = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    backend.raw_constraints = NativeConstraints {
        min_width: Some(200.0),
        min_height: Some(100.0),
        max_width: Some(700.0),
        max_height: Some(600.0),
        basis: ConstraintBasis::Content,
    };

    let result = run(&mut backend, "setMinimumSize", &[json!([300.0, 0.0])]).unwrap();
    let expected_inner = NativeConstraints {
        min_width: Some(280.0),
        min_height: None,
        max_width: Some(700.0),
        max_height: Some(600.0),
        basis: ConstraintBasis::Content,
    };
    let expected_outer = NativeConstraints {
        min_width: Some(300.0),
        min_height: None,
        max_width: Some(720.0),
        max_height: Some(630.0),
        basis: ConstraintBasis::Outer,
    };
    assert_eq!(backend.accepted_inner_constraints, Some(expected_inner));
    assert_eq!(backend.raw_constraints, expected_outer);
    assert_eq!(backend.snapshot.minimum_size, [300.0, 0.0]);
    assert_eq!(backend.snapshot.maximum_size, [720.0, 630.0]);
    assert_eq!(pair(&result["value"]), [300.0, 0.0]);
    assert!(backend
        .calls
        .contains(&Call::RememberConstraints(expected_outer)));
}

#[test]
fn zero_constraints_are_unbounded_and_impossible_limits_reject_before_mutation() {
    let mut clear = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    clear.raw_constraints = NativeConstraints {
        min_width: Some(200.0),
        min_height: Some(100.0),
        max_width: Some(800.0),
        max_height: Some(700.0),
        basis: ConstraintBasis::Outer,
    };
    let result = run(&mut clear, "setMaximumSize", &[json!([0.0, 0.0])]).unwrap();
    assert_eq!(
        clear.accepted_inner_constraints.unwrap().maximum(),
        [0.0, 0.0]
    );
    assert_eq!(clear.raw_constraints.maximum(), [0.0, 0.0]);
    assert_eq!(pair(&result["value"]), [0.0, 0.0]);

    let mut reversed = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    reversed.raw_constraints.max_width = Some(500.0);
    let error = run(&mut reversed, "setMinimumSize", &[json!([600.0, 0.0])]).unwrap_err();
    assert!(
        error.contains("minimum size cannot exceed maximum"),
        "{error}"
    );
    assert!(!reversed.setters_ran());

    let mut too_small = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    let error = run(&mut too_small, "setMaximumSize", &[json!([20.0, 100.0])]).unwrap_err();
    assert!(
        error.contains("maximum outer constraint cannot contain measured window chrome"),
        "{error}"
    );
    assert!(!too_small.setters_ran());
}

#[test]
fn geometry_validation_and_backend_failures_do_not_claim_unperformed_work() {
    let mut invalid = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    assert!(run(
        &mut invalid,
        "setBounds",
        &[json!({"x": 1, "y": 2, "width": 300, "height": 200, "extra": 1})]
    )
    .is_err());
    assert!(run(
        &mut invalid,
        "setContentSize",
        &[json!(300), json!(200), json!(true)]
    )
    .is_err());
    assert!(invalid.calls.is_empty());

    let mut metrics_error = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    metrics_error.metrics = Err("fake frame sampling failure".into());
    assert_eq!(
        run(&mut metrics_error, "setSize", &[json!([300.0, 200.0])]).unwrap_err(),
        "fake frame sampling failure"
    );
    assert!(!metrics_error.setters_ran());

    let mut write_error = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    write_error.fail(Failure::InnerSize);
    assert_eq!(
        run(&mut write_error, "setSize", &[json!([300.0, 200.0])]).unwrap_err(),
        "fake inner size failure"
    );
    assert!(!write_error.calls.contains(&Call::Snapshot));

    let mut readback_error = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    readback_error.fail(Failure::Snapshot);
    assert_eq!(
        run(
            &mut readback_error,
            "setContentSize",
            &[json!([300.0, 200.0])]
        )
        .unwrap_err(),
        "fake snapshot failure"
    );
    assert!(readback_error
        .calls
        .contains(&Call::SetInnerSize([300.0, 200.0])));
}

#[test]
fn frame_measurement_and_physical_pixel_representability_fail_before_writes() {
    let mut inconsistent = FakeBackend::new(1.0, [100, 100], [101, 100]);
    assert!(inconsistent.metrics.as_ref().is_err());
    let error = run(&mut inconsistent, "setSize", &[json!([300.0, 200.0])]).unwrap_err();
    assert!(
        error.contains("outer size cannot be smaller than content size"),
        "{error}"
    );
    assert!(!inconsistent.setters_ran());

    let mut too_small = FakeBackend::new(2.0, [100, 100], [100, 100]);
    let error = run(&mut too_small, "setSize", &[json!([0.1, 100.0])]).unwrap_err();
    assert!(
        error.contains("cannot be represented in physical pixels"),
        "{error}"
    );
    assert!(!too_small.setters_ran());

    let mut tiny_content = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    let error = run(&mut tiny_content, "setContentSize", &[json!([0.1, 100.0])]).unwrap_err();
    assert!(
        error.contains("width cannot be represented in physical pixels"),
        "{error}"
    );
    assert!(!tiny_content.setters_ran());

    let mut tiny_max = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    let error = run(&mut tiny_max, "setMaximumSize", &[json!([20.4, 100.0])]).unwrap_err();
    assert!(
        error.contains("maximum width cannot be represented in physical pixels"),
        "{error}"
    );
    assert!(!tiny_max.setters_ran());

    let mut below_chrome = FakeBackend::new(1.0, [120, 130], [100, 100]);
    let error = run(&mut below_chrome, "setSize", &[json!([19.0, 80.0])]).unwrap_err();
    assert!(
        error.contains("smaller than measured window chrome"),
        "{error}"
    );
    assert!(!below_chrome.setters_ran());
}

#[test]
fn set_bounds_position_failure_reports_partial_commit_without_rollback_claim() {
    let mut backend = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    backend.fail(Failure::OuterPosition);
    let error = run(
        &mut backend,
        "setBounds",
        &[json!({"x": 70.0, "y": 80.0, "width": 700.0, "height": 500.0})],
    )
    .unwrap_err();
    assert!(
        error.contains("ERR_ATOOLS_NATIVE_WINDOW_PARTIAL_BOUNDS"),
        "{error}"
    );
    assert!(
        error.contains("position failed: fake outer position failure"),
        "{error}"
    );
    assert_eq!(backend.snapshot.bounds.width, 700.0);
    assert_eq!(backend.snapshot.bounds.height, 500.0);
    assert_eq!(backend.snapshot.bounds.x, 10.0);
    assert_eq!(backend.snapshot.bounds.y, 20.0);
    assert!(!backend.calls.contains(&Call::Snapshot));
    assert!(matches!(backend.calls[2], Call::SetInnerSize(_)));
    assert_eq!(backend.calls[3], Call::SetOuterPosition([70.0, 80.0]));
}

#[test]
fn constraint_write_failure_does_not_update_the_outer_mirror() {
    let mut backend = FakeBackend::new(1.0, [1020, 630], [1000, 600]);
    let original = NativeConstraints {
        min_width: Some(100.0),
        min_height: None,
        max_width: None,
        max_height: None,
        basis: ConstraintBasis::Outer,
    };
    backend.raw_constraints = original;
    backend.fail(Failure::InnerConstraints);
    let error = run(&mut backend, "setMinimumSize", &[json!([200.0, 0.0])]).unwrap_err();
    assert_eq!(error, "fake constraint write failure");
    assert_eq!(backend.raw_constraints, original);
    assert!(!backend
        .calls
        .iter()
        .any(|call| matches!(call, Call::RememberConstraints(_))));
    assert!(!backend.calls.contains(&Call::Snapshot));
}
