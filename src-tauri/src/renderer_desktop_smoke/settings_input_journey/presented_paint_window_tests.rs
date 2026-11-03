use super::{trace::NativePresentationObservation, WindowFacts};
use serde_json::json;

fn facts(visible: bool) -> WindowFacts {
    WindowFacts {
        observation: NativePresentationObservation {
            visible: Some(visible),
            occlusion_visible: Some(visible),
            on_active_space: Some(visible),
            window_focused: Some(false),
            window_key: Some(false),
            app_active: Some(false),
            app_hidden: Some(false),
            frontmost_is_self: Some(false),
        },
        focus_gained_events: 0,
        app_activation_events: Some(0),
        main_key_events: Some(0),
        observer_state_valid: true,
    }
}

#[test]
fn presentation_requires_visibility_and_unchanged_focus_observers() {
    let hidden = facts(false);
    assert!(hidden.initially_hidden_unfocused());

    let visible = facts(true);
    assert!(visible.visible_unfocused_since(hidden));
    assert!(!visible.initially_hidden_unfocused());

    let occluded = WindowFacts {
        observation: NativePresentationObservation {
            occlusion_visible: Some(false),
            ..visible.observation
        },
        ..visible
    };
    assert!(!occluded.visible_unfocused_since(hidden));

    let other_space = WindowFacts {
        observation: NativePresentationObservation {
            on_active_space: Some(false),
            ..visible.observation
        },
        ..visible
    };
    assert!(!other_space.visible_unfocused_since(hidden));

    let focused = WindowFacts {
        observation: NativePresentationObservation {
            window_key: Some(true),
            ..visible.observation
        },
        ..visible
    };
    assert!(focused.focus_changed_since(hidden));
    assert!(!focused.visible_unfocused_since(hidden));

    let app_activated = WindowFacts {
        app_activation_events: Some(1),
        ..visible
    };
    assert!(app_activated.focus_changed_since(hidden));
    assert!(!app_activated.visible_unfocused_since(hidden));
}

#[test]
fn presentation_and_cleanup_payloads_keep_the_bounded_contract() {
    assert_eq!(
        facts(true).presentation(),
        json!({
            "visible": true,
            "windowFocused": false,
            "windowKey": false,
            "appActive": false,
            "frontmostIsSelf": false,
        })
    );
    assert_eq!(
        facts(false).cleanup(),
        json!({
            "hideConfirmed": true,
            "visible": false,
            "windowFocused": false,
            "windowKey": false,
            "appActive": false,
            "frontmostIsSelf": false,
        })
    );
    assert_eq!(facts(true).cleanup()["hideConfirmed"], false);
}

#[test]
fn missing_native_or_observer_facts_never_pass_a_gate() {
    let mut baseline = facts(false);
    baseline.observation.window_focused = None;
    assert!(!baseline.initially_hidden_unfocused());

    let baseline = facts(false);
    let mut visible = facts(true);
    visible.observation.app_hidden = None;
    assert!(!visible.after_order_front_unfocused());
    assert!(!visible.visible_unfocused_since(baseline));

    let mut invalid_observers = facts(true);
    invalid_observers.observer_state_valid = false;
    assert!(!invalid_observers.visible_unfocused_since(baseline));
}
