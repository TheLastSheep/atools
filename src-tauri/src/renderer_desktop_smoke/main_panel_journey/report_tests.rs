use super::stage_tests::stage_facts;
use super::{text_method_state_matches, valid_conversion, valid_restoration};
use crate::renderer_desktop_smoke::{
    main_panel_journey::state::{ActivationFacts, CleanupFacts, Harness, Stage},
    profile::{PaintPresentation, Profile},
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

fn safe_conversion() -> Value {
    let level = i64::try_from(objc2_app_kit::NSModalPanelWindowLevel + 1)
        .expect("modal panel level plus one fits in i64");
    // This concrete tuple is also accepted by macos_main_panel::native::layout_is_safe tests.
    json!({
        "scopedIdentifierMatches": true,
        "mainWindowHiddenBeforeConversion": true,
        "sameNativeWindow": true,
        "originalClass": "TaoWindow",
        "originalClassAssessment": {
            "kind": "tao",
            "actualClass": "TaoWindow",
            "reportedClass": "TaoWindow",
            "actualSuperclass": "NSWindow",
            "actualInstanceSize": 512,
            "taoInstanceSize": 512,
            "ownIvarCount": 0,
            "ownMethodNames": [],
            "taoDirectSuperclassIsNsWindow": true
        },
        "panelClass": "AToolsMainPanel",
        "originalInstanceSize": 512,
        "panelInstanceSize": 448,
        "taoFocusableOffset": 480,
        "nsPanelOwnIvarCount": 0,
        "focusableLayoutSafe": true,
        "isPanel": true,
        "panelClassMatches": true,
        "nonactivatingStyle": true,
        "selectorAvailable": true,
        "canBecomeKey": true,
        "canBecomeMain": false,
        "stillHidden": true,
        "originalDelegateUnchanged": true,
        "contentViewAndParentUnchanged": true,
        "collectionBehaviorUnchanged": true,
        "releasedWhenClosedUnchanged": true,
        "subviewMasksAdjusted": true,
        "level": level,
        "floating": true,
        "hidesOnDeactivate": false,
        "becomesKeyOnlyIfNeeded": false,
        "subviewCount": 3,
        "textInputMethodAdded": false,
        "runtimeMethodLifetime": "until-process-exit",
        "runtimeMethodRemovalSupported": false
    })
}

fn complete_restoration() -> Value {
    json!({
        "sameNativeWindow": true,
        "originalClassRestored": true,
        "originalDelegateRestored": true,
        "releasedWhenClosedRestored": true,
        "subviewMasksRestored": true,
        "contentViewRestored": true,
        "styleMaskRestored": true,
        "levelRestored": true,
        "collectionBehaviorRestored": true,
        "hidesOnDeactivateRestored": true,
        "canBecomeKeyRestored": true,
        "canBecomeMainRestored": true,
        "panelFloatingBaselineRestored": true,
        "panelBecomesKeyBaselineRestored": true,
        "windowRestored": true,
        "textInputMethodRemains": null,
        "runtimeMethodLifetime": "until-process-exit",
        "runtimeMethodRemovalSupported": false
    })
}

fn report_harness(
    app_active: bool,
    text_method_added: Option<bool>,
    text_method_remains: Option<bool>,
) -> Harness {
    let profile = Profile {
        root: PathBuf::from("/private/tmp/main-panel-report-test"),
        dist: PathBuf::from("/private/tmp/main-panel-report-test/dist"),
        output: PathBuf::from("/private/tmp/main-panel-report-test/output"),
        auto_clear: "never".to_owned(),
        identifier: "dev.atools.renderer-smoke.00000000000000000000000000000000".to_owned(),
        run_id: "00000000000000000000000000000000".to_owned(),
        settings_journey: false,
        settings_height_case: None,
        manual_ui: false,
        settings_input_journey: false,
        builtin_state_seed: false,
        builtin_state_journey: false,
        resume_seed_pid: None,
        main_hotkey_recovery_first: false,
        main_hotkey_recovery_second: false,
        resume_hotkey_owner_pid: None,
        paint_presentation: PaintPresentation::Hidden,
        launcher_journey: false,
        launch_return_journey: false,
        launch_target_kind: crate::renderer_desktop_smoke::profile::LaunchTargetKind::App,
        registration_source: crate::renderer_desktop_smoke::profile::RegistrationSource::CoreSeed,
        catalog_journey: false,
        updater_journey: false,
        updater_about: false,
        window_drag: false,
        main_panel_journey: true,
        clipboard_context_journey: false,
    };
    let harness = Harness::new(Arc::new(profile));
    let mut state = harness.0.state.lock();
    let mut conversion = safe_conversion();
    conversion["textInputMethodAdded"] = text_method_added.map_or(Value::Null, Value::Bool);
    let mut restoration = complete_restoration();
    restoration["textInputMethodRemains"] = text_method_remains.map_or(Value::Null, Value::Bool);
    state.conversion = Some(conversion);
    state.restoration = Some(restoration);
    state.baseline_app_active = Some(app_active);
    for stage in Stage::ALL {
        state.stages[stage.index()] = Some(stage_facts(stage, app_active));
    }
    state.activation = ActivationFacts {
        baseline_app_activation_events: Some(0),
        final_app_activation_events: Some(0),
        app_activation_event_delta: Some(0),
        baseline_main_key_events: Some(0),
        final_main_key_events: Some(2),
        main_key_event_delta: Some(2),
        observer_registered: Some(2),
        observer_removed: Some(2),
        observer_installed: Some(false),
    };
    state.cleanup = CleanupFacts {
        window_hidden: Some(true),
        panel_active: Some(false),
        native_operations_terminal: true,
        observers_removed: Some(true),
    };
    drop(state);
    harness
}

#[test]
fn accepts_the_observed_tao_to_nonactivating_panel_contract() {
    let mut facts = safe_conversion();
    assert!(valid_conversion(&facts));
    facts["textInputMethodAdded"] = Value::Bool(true);
    assert!(valid_conversion(&facts));
    facts["textInputMethodAdded"] = Value::Null;
    assert!(valid_conversion(&facts));
    facts["textInputMethodAdded"] = json!("unknown");
    assert!(!valid_conversion(&facts));
}

fn kvo_conversion() -> Value {
    let mut facts = safe_conversion();
    facts["originalClass"] = json!("NSKVONotifying_TaoWindow");
    facts["originalClassAssessment"] = json!({
        "kind": "foundation-kvo-content-view",
        "actualClass": "NSKVONotifying_TaoWindow",
        "reportedClass": "TaoWindow",
        "actualSuperclass": "TaoWindow",
        "actualInstanceSize": 512,
        "taoInstanceSize": 512,
        "ownIvarCount": 0,
        "ownMethodNames": ["_isKVOA", "class", "dealloc", "setContentView:"],
        "taoDirectSuperclassIsNsWindow": true
    });
    facts
}

#[test]
fn accepts_plain_tao_and_verified_foundation_kvo_assessments() {
    assert!(valid_conversion(&safe_conversion()));
    assert!(valid_conversion(&kvo_conversion()));
}

#[test]
fn rejects_kvo_assessments_with_unverified_runtime_facts() {
    let mutations = [
        ("actualClass", json!("TaoWindow")),
        ("reportedClass", json!("OtherWindow")),
        ("actualSuperclass", json!("NSWindow")),
        ("actualInstanceSize", json!(513)),
        ("taoInstanceSize", json!(511)),
        ("ownIvarCount", json!(1)),
        (
            "ownMethodNames",
            json!(["_isKVOA", "class", "setContentView:"]),
        ),
        ("taoDirectSuperclassIsNsWindow", json!(false)),
        ("kind", json!("other")),
    ];
    for (field, value) in mutations {
        let mut facts = kvo_conversion();
        facts["originalClassAssessment"][field] = value;
        assert!(
            !valid_conversion(&facts),
            "accepted invalid assessment {field}"
        );
    }
}

#[test]
fn rejects_wrong_runtime_classes_even_when_claimed_layout_flags_are_true() {
    for (field, wrong) in [
        ("originalClass", json!("NSWindow")),
        ("panelClass", json!("NSPanel")),
    ] {
        let mut facts = safe_conversion();
        facts[field] = wrong;
        assert!(!valid_conversion(&facts), "accepted wrong {field}");
    }
}

#[test]
fn rejects_conversion_layout_ranges_that_cannot_contain_the_focusable_ivar() {
    let cases = [
        ("panelInstanceSize", json!(513)),
        ("panelInstanceSize", json!(-1)),
        ("taoFocusableOffset", json!(447)),
        ("taoFocusableOffset", json!(512)),
        ("taoFocusableOffset", json!(u64::MAX)),
        ("originalInstanceSize", json!(480)),
        ("originalInstanceSize", json!(null)),
    ];
    for (field, wrong) in cases {
        let mut facts = safe_conversion();
        facts[field] = wrong;
        assert!(!valid_conversion(&facts), "accepted invalid {field}");
    }
}

#[test]
fn rejects_conversion_facts_with_unknown_or_opposite_safety_values() {
    for field in [
        "scopedIdentifierMatches",
        "mainWindowHiddenBeforeConversion",
        "sameNativeWindow",
        "focusableLayoutSafe",
        "isPanel",
        "panelClassMatches",
        "nonactivatingStyle",
        "selectorAvailable",
        "canBecomeKey",
        "stillHidden",
        "originalDelegateUnchanged",
        "contentViewAndParentUnchanged",
        "collectionBehaviorUnchanged",
        "releasedWhenClosedUnchanged",
        "subviewMasksAdjusted",
    ] {
        for unknown in [false, true] {
            let mut facts = safe_conversion();
            facts[field] = if unknown {
                Value::Null
            } else {
                Value::Bool(false)
            };
            assert!(!valid_conversion(&facts), "accepted unsafe {field}");
        }
    }
    for (field, wrong) in [
        ("canBecomeMain", json!(true)),
        ("nsPanelOwnIvarCount", json!(1)),
        ("floating", json!(false)),
        ("hidesOnDeactivate", json!(true)),
        ("becomesKeyOnlyIfNeeded", json!(true)),
        ("runtimeMethodRemovalSupported", json!(true)),
        ("runtimeMethodLifetime", json!("removable")),
        (
            "level",
            json!(i64::try_from(objc2_app_kit::NSModalPanelWindowLevel + 2).unwrap()),
        ),
    ] {
        let mut facts = safe_conversion();
        facts[field] = wrong;
        assert!(!valid_conversion(&facts), "accepted unsafe {field}");
    }
    let mut missing_lifetime = safe_conversion();
    missing_lifetime
        .as_object_mut()
        .unwrap()
        .remove("runtimeMethodLifetime");
    assert!(!valid_conversion(&missing_lifetime));
    let mut missing_optional_fact = safe_conversion();
    missing_optional_fact
        .as_object_mut()
        .unwrap()
        .remove("textInputMethodAdded");
    assert!(!valid_conversion(&missing_optional_fact));
}

#[test]
fn accepts_complete_restoration_when_optional_text_input_probe_is_unknown() {
    assert!(valid_restoration(&complete_restoration()));
    let mut known_no_delta = complete_restoration();
    known_no_delta["textInputMethodRemains"] = Value::Bool(false);
    assert!(valid_restoration(&known_no_delta));
    known_no_delta["textInputMethodRemains"] = Value::Bool(true);
    assert!(valid_restoration(&known_no_delta));
}

#[test]
fn rejects_incomplete_or_false_restoration_evidence() {
    for field in [
        "sameNativeWindow",
        "originalClassRestored",
        "originalDelegateRestored",
        "releasedWhenClosedRestored",
        "subviewMasksRestored",
        "contentViewRestored",
        "styleMaskRestored",
        "levelRestored",
        "collectionBehaviorRestored",
        "hidesOnDeactivateRestored",
        "canBecomeKeyRestored",
        "canBecomeMainRestored",
        "panelFloatingBaselineRestored",
        "panelBecomesKeyBaselineRestored",
        "windowRestored",
    ] {
        let mut facts = complete_restoration();
        facts[field] = Value::Bool(false);
        assert!(!valid_restoration(&facts), "accepted false {field}");
    }
    for (field, invalid) in [
        ("textInputMethodRemains", json!("unknown")),
        ("runtimeMethodLifetime", json!("until-next-window")),
        ("runtimeMethodRemovalSupported", json!(true)),
    ] {
        let mut facts = complete_restoration();
        facts[field] = invalid;
        assert!(!valid_restoration(&facts), "accepted invalid {field}");
    }
    let mut missing = complete_restoration();
    missing.as_object_mut().unwrap().remove("windowRestored");
    assert!(!valid_restoration(&missing));
    let mut missing_optional_fact = complete_restoration();
    missing_optional_fact
        .as_object_mut()
        .unwrap()
        .remove("textInputMethodRemains");
    assert!(!valid_restoration(&missing_optional_fact));
}

#[test]
fn report_requires_text_input_delta_facts_to_be_known_and_equal() {
    let mut conversion = safe_conversion();
    let mut restoration = complete_restoration();
    restoration["textInputMethodRemains"] = Value::Bool(false);
    assert!(text_method_state_matches(
        Some(&conversion),
        Some(&restoration)
    ));

    conversion["textInputMethodAdded"] = Value::Bool(true);
    restoration["textInputMethodRemains"] = Value::Bool(true);
    assert!(text_method_state_matches(
        Some(&conversion),
        Some(&restoration)
    ));

    restoration["textInputMethodRemains"] = Value::Bool(false);
    assert!(!text_method_state_matches(
        Some(&conversion),
        Some(&restoration)
    ));

    conversion["textInputMethodAdded"] = Value::Null;
    restoration["textInputMethodRemains"] = Value::Null;
    assert!(!text_method_state_matches(
        Some(&conversion),
        Some(&restoration)
    ));
    assert!(!text_method_state_matches(Some(&conversion), None));
}

#[test]
fn report_pass_requires_known_equal_text_method_delta_facts() {
    for known in [false, true] {
        let report = super::report(&report_harness(true, Some(known), Some(known)));
        assert_eq!(report["passed"], true);
        assert_eq!(report["fullProductAcceptance"], false);
    }
    for (added, remains) in [
        (Some(false), Some(true)),
        (Some(true), Some(false)),
        (None, None),
        (Some(false), None),
        (None, Some(false)),
    ] {
        let report = super::report(&report_harness(true, added, remains));
        assert_eq!(report["passed"], false);
    }
}
