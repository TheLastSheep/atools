use super::{stage_is_valid, Stage, StageFacts};
use serde_json::{json, Value};

pub(super) fn stage_facts(stage: Stage, app_active: bool) -> StageFacts {
    let is_shown = matches!(stage, Stage::Shown | Stage::Reshown);
    let main_key_delta = match stage {
        Stage::Baseline => 0,
        Stage::Shown | Stage::Hidden => 1,
        Stage::Reshown => 2,
    };
    StageFacts {
        foreground: json!({
            "appActive": app_active,
            "appHidden": false,
            "frontmostIsSelf": app_active,
            "mainWindowAvailable": true,
            "mainVisible": is_shown,
            "mainKey": is_shown,
            "mainFocused": is_shown,
            "mainOnActiveSpace": is_shown,
            "mainOcclusionVisible": is_shown
        }),
        frontmost_matches_baseline: Some(true),
        input_found: Some(true),
        input_focused: Some(is_shown),
        content_view_stable: Some(true),
        document_visible: is_shown,
        document_has_focus: is_shown,
        app_activation_events: Some(0),
        app_activation_event_delta: Some(0),
        main_key_events: Some(main_key_delta),
        main_key_event_delta: Some(main_key_delta),
    }
}

#[test]
fn stage_report_serializes_document_visibility_with_frozen_camel_case_keys() {
    let shown = serde_json::to_value(stage_facts(Stage::Shown, false)).unwrap();
    assert_eq!(shown["documentVisible"], true);
    assert_eq!(shown["documentHasFocus"], true);
    assert_eq!(shown["contentViewStable"], true);
    assert!(shown.get("document_visible").is_none());
}

#[test]
fn every_stage_requires_native_content_view_stability() {
    for stage in Stage::ALL {
        let mut facts = stage_facts(stage, false);
        assert!(stage_is_valid(stage, &facts, Some(false)));
        facts.content_view_stable = Some(false);
        assert!(!stage_is_valid(stage, &facts, Some(false)));
        facts.content_view_stable = None;
        assert!(!stage_is_valid(stage, &facts, Some(false)));
    }
}

#[test]
fn accepts_baseline_with_either_external_or_already_active_app() {
    for active in [false, true] {
        let baseline = stage_facts(Stage::Baseline, active);
        assert!(stage_is_valid(Stage::Baseline, &baseline, Some(active)));
    }
}

#[test]
fn rejects_baseline_when_foreground_or_app_state_is_unknown_or_inconsistent() {
    let mut unknown_app = stage_facts(Stage::Baseline, false);
    unknown_app.foreground["appActive"] = Value::Null;
    assert!(!stage_is_valid(Stage::Baseline, &unknown_app, Some(false)));

    let active = stage_facts(Stage::Baseline, true);
    assert!(!stage_is_valid(Stage::Baseline, &active, Some(false)));

    let mut unknown_window = stage_facts(Stage::Baseline, false);
    unknown_window.foreground["mainWindowAvailable"] = Value::Null;
    assert!(!stage_is_valid(
        Stage::Baseline,
        &unknown_window,
        Some(false)
    ));

    let mut unknown_frontmost = stage_facts(Stage::Baseline, false);
    unknown_frontmost.frontmost_matches_baseline = None;
    assert!(!stage_is_valid(
        Stage::Baseline,
        &unknown_frontmost,
        Some(false)
    ));

    let mut activated = stage_facts(Stage::Baseline, false);
    activated.app_activation_event_delta = Some(1);
    assert!(!stage_is_valid(Stage::Baseline, &activated, Some(false)));

    let mut unexpected_key_event = stage_facts(Stage::Baseline, false);
    unexpected_key_event.main_key_event_delta = Some(1);
    assert!(!stage_is_valid(
        Stage::Baseline,
        &unexpected_key_event,
        Some(false)
    ));

    let mut focused_document = stage_facts(Stage::Baseline, false);
    focused_document.document_has_focus = true;
    assert!(!stage_is_valid(
        Stage::Baseline,
        &focused_document,
        Some(false)
    ));
}

#[test]
fn shown_and_reshown_require_visible_key_focused_and_baseline_stability() {
    for stage in [Stage::Shown, Stage::Reshown] {
        for active in [false, true] {
            let shown = stage_facts(stage, active);
            assert!(stage_is_valid(stage, &shown, Some(active)));

            let mut mismatched = shown.clone();
            mismatched.foreground["appActive"] = Value::Bool(!active);
            assert!(!stage_is_valid(stage, &mismatched, Some(active)));

            let mut no_focus = shown.clone();
            no_focus.foreground["mainFocused"] = Value::Null;
            assert!(!stage_is_valid(stage, &no_focus, Some(active)));
            no_focus.foreground["mainFocused"] = Value::Bool(false);
            assert!(!stage_is_valid(stage, &no_focus, Some(active)));

            let mut no_key = shown.clone();
            no_key.foreground["mainKey"] = Value::Bool(false);
            assert!(!stage_is_valid(stage, &no_key, Some(active)));

            let mut no_occlusion = shown.clone();
            no_occlusion.foreground["mainOcclusionVisible"] = Value::Null;
            assert!(!stage_is_valid(stage, &no_occlusion, Some(active)));
            no_occlusion.foreground["mainOcclusionVisible"] = Value::Bool(false);
            assert!(!stage_is_valid(stage, &no_occlusion, Some(active)));

            for field in ["appHidden", "mainVisible", "mainOnActiveSpace"] {
                for unknown in [false, true] {
                    let mut invalid = shown.clone();
                    invalid.foreground[field] = if unknown {
                        Value::Null
                    } else {
                        Value::Bool(if field == "appHidden" { true } else { false })
                    };
                    assert!(
                        !stage_is_valid(stage, &invalid, Some(active)),
                        "accepted invalid {field}"
                    );
                }
            }

            let mut no_document_visibility = shown.clone();
            no_document_visibility.document_visible = false;
            assert!(!stage_is_valid(
                stage,
                &no_document_visibility,
                Some(active)
            ));

            let mut no_document_focus = shown.clone();
            no_document_focus.document_has_focus = false;
            assert!(!stage_is_valid(stage, &no_document_focus, Some(active)));

            let mut no_input_focus = shown.clone();
            no_input_focus.input_focused = None;
            assert!(!stage_is_valid(stage, &no_input_focus, Some(active)));

            let mut unknown_frontmost = shown.clone();
            unknown_frontmost.frontmost_matches_baseline = None;
            assert!(!stage_is_valid(stage, &unknown_frontmost, Some(active)));

            let mut activated = shown.clone();
            activated.app_activation_event_delta = Some(1);
            assert!(!stage_is_valid(stage, &activated, Some(active)));
        }
    }
}

#[test]
fn hidden_stage_keeps_app_state_and_requires_window_to_be_nonkey() {
    for active in [false, true] {
        let hidden = stage_facts(Stage::Hidden, active);
        assert!(stage_is_valid(Stage::Hidden, &hidden, Some(active)));

        let mut inconsistent = hidden.clone();
        inconsistent.foreground["appActive"] = Value::Bool(!active);
        assert!(!stage_is_valid(Stage::Hidden, &inconsistent, Some(active)));

        let mut still_key = hidden.clone();
        still_key.foreground["mainKey"] = Value::Bool(true);
        assert!(!stage_is_valid(Stage::Hidden, &still_key, Some(active)));

        for field in ["mainVisible", "mainFocused"] {
            let mut still_active = hidden.clone();
            still_active.foreground[field] = Value::Bool(true);
            assert!(!stage_is_valid(Stage::Hidden, &still_active, Some(active)));
        }

        let mut focused_document = hidden.clone();
        focused_document.document_has_focus = true;
        assert!(!stage_is_valid(
            Stage::Hidden,
            &focused_document,
            Some(active)
        ));

        let mut activated = hidden.clone();
        activated.app_activation_event_delta = Some(1);
        assert!(!stage_is_valid(Stage::Hidden, &activated, Some(active)));
    }
}
