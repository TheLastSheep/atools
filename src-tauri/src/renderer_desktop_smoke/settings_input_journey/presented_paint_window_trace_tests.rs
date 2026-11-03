use super::{NativePresentationObservation, WindowTrace};
use serde_json::json;

fn known_observation(visible: bool) -> NativePresentationObservation {
    NativePresentationObservation {
        visible: Some(visible),
        occlusion_visible: Some(visible),
        on_active_space: Some(visible),
        window_focused: Some(false),
        window_key: Some(false),
        app_active: Some(false),
        app_hidden: Some(false),
        frontmost_is_self: Some(false),
    }
}

#[test]
fn empty_trace_has_fixed_schema_and_unknown_phases() {
    let trace = WindowTrace::new().snapshot();
    assert_eq!(
        trace,
        json!({
            "schemaVersion": 1,
            "baseline": null,
            "afterOrderFront": null,
            "lastVisibility": null,
            "afterHide": null,
            "visibilitySamples": 0,
        })
    );
}

#[test]
fn returned_all_unknown_native_observation_is_counted_as_a_real_sample() {
    let trace = WindowTrace::new();
    trace.visibility(NativePresentationObservation::default());
    let snapshot = trace.snapshot();
    assert_eq!(snapshot["visibilitySamples"], 1);
    assert_eq!(
        snapshot["lastVisibility"],
        json!({
            "visible": null,
            "occlusionVisible": null,
            "onActiveSpace": null,
            "windowFocused": null,
            "windowKey": null,
            "appActive": null,
            "appHidden": null,
            "frontmostIsSelf": null,
        })
    );
}

#[test]
fn transport_failure_does_not_create_or_overwrite_a_native_sample() {
    let trace = WindowTrace::new();
    assert!(super::record_visibility_capture(&trace, Err("dispatch-failed")).is_err());
    let empty = trace.snapshot();
    assert_eq!(empty["visibilitySamples"], 0);
    assert!(empty["lastVisibility"].is_null());

    let actual = known_observation(true);
    assert_eq!(
        super::record_visibility_capture(&trace, Ok(actual)),
        Ok(actual)
    );
    let before_failure = trace.snapshot();
    assert!(super::record_visibility_capture(&trace, Err("timeout")).is_err());
    assert_eq!(trace.snapshot(), before_failure);
}

#[test]
fn trace_stores_each_phase_and_caps_visibility_samples() {
    let trace = WindowTrace::new();
    let baseline = known_observation(false);
    let front = known_observation(true);
    trace.baseline(baseline);
    trace.after_order_front(front);
    for _ in 0..300 {
        trace.visibility(front);
    }
    trace.after_hide(baseline);

    let snapshot = trace.snapshot();
    assert_eq!(snapshot["baseline"]["visible"], false);
    assert_eq!(snapshot["afterOrderFront"]["visible"], true);
    assert_eq!(snapshot["afterHide"]["visible"], false);
    assert_eq!(snapshot["visibilitySamples"], 256);
    assert_eq!(snapshot["lastVisibility"]["visible"], true);
    assert_eq!(snapshot.as_object().unwrap().len(), 6);
    for phase in ["baseline", "afterOrderFront", "lastVisibility", "afterHide"] {
        assert_eq!(snapshot[phase].as_object().unwrap().len(), 8);
    }
}

#[test]
fn after_order_front_requires_known_unfocused_app_facts_but_allows_space_delay() {
    let safe = NativePresentationObservation {
        visible: Some(true),
        occlusion_visible: None,
        on_active_space: Some(false),
        window_focused: Some(false),
        window_key: Some(false),
        app_active: Some(false),
        app_hidden: Some(false),
        frontmost_is_self: Some(false),
    };
    assert!(safe.after_order_front_unfocused());

    let mut unknown = safe;
    unknown.app_hidden = None;
    assert!(!unknown.after_order_front_unfocused());
    let mut visible_unknown = safe;
    visible_unknown.visible = None;
    assert!(!visible_unknown.after_order_front_unfocused());
    let mut focused = safe;
    focused.window_key = Some(true);
    assert!(!focused.after_order_front_unfocused());
}

#[test]
fn visibility_sample_count_is_zero_exactly_when_last_sample_is_null() {
    let trace = WindowTrace::new();
    let mut snapshot = trace.snapshot();
    assert!(snapshot["lastVisibility"].is_null());
    assert_eq!(snapshot["visibilitySamples"], 0);

    trace.visibility(known_observation(true));
    snapshot = trace.snapshot();
    assert!(!snapshot["lastVisibility"].is_null());
    assert_eq!(snapshot["visibilitySamples"], 1);
}
