use serde_json::{json, Value};

use super::{verify_stage, EventLedger, NativeObservation, Stage, QUERY};

fn native() -> NativeObservation {
    NativeObservation {
        visible: Some(true),
        focused: Some(true),
        application_active: Some(true),
        application_hidden: Some(false),
        frontmost_is_self: Some(true),
        window_occlusion_visible: Some(true),
        main_bundle_identifier: Some("dev.atools.renderer-smoke.test".into()),
        running_application_bundle_identifier: Some("dev.atools.renderer-smoke.test".into()),
        incognito_data_store_persistent: Some(false),
    }
}

fn adapter(disposed: bool) -> Value {
    let source = json!({
        "subscribers": if disposed { 0 } else { 1 },
        "listenerState": if disposed { "disposed" } else { "listening" },
        "deliveredEvents": 1,
        "registrationErrors": 0,
        "callbackErrors": 0,
        "registrationsPending": 0,
        "cleanupPending": 0,
        "cleanupErrors": 0
    });
    json!({
        "disposed": disposed,
        "outstandingNativeCalls": 0,
        "nativeCalls": { "get_ztools_renderer_settings": 1 },
        "focusEvents": source,
        "appCatalog": { "cachedApps": if disposed { 0 } else { 1 }, "readPending": false, "eventSource": source },
        "settingsSnapshot": { "cached": 14, "inFlight": false, "disposed": disposed },
        "appState": {
            "historySubscribers": if disposed { 0 } else { 1 },
            "pinnedSubscribers": if disposed { 0 } else { 1 },
            "queuedMutations": 0,
            "eventSource": source,
            "disposed": disposed
        },
        "contextMenu": {
            "subscribers": if disposed { 0 } else { 1 },
            "eventSource": source,
            "disposed": disposed
        }
    })
}

fn dom(stage_ready: bool, visibility: &str, has_focus: bool, input_focused: bool) -> Value {
    json!({
        "stageReady": stage_ready,
        "inputFound": true,
        "documentVisibility": visibility,
        "documentHasFocus": has_focus,
        "inputFocused": input_focused,
        "inputValue": QUERY,
        "selectionStart": QUERY.len(),
        "selectionEnd": QUERY.len(),
        "adapter": adapter(false),
        "disposeError": null,
        "preDisposeCounters": null
    })
}

fn pre_dispose_counters() -> Value {
    json!({
        "nativeCalls": { "get_ztools_renderer_settings": 1 },
        "eventSourceDeliveredEvents": {
            "focusEvents": 1,
            "appState": 1,
            "contextMenu": 1,
            "appCatalog": 1
        }
    })
}

#[test]
fn only_fixed_stage_names_are_accepted() {
    assert_eq!(Stage::parse("shown"), Some(Stage::Shown));
    assert_eq!(Stage::parse("disposed-return"), Some(Stage::DisposedReturn));
    assert_eq!(Stage::parse("file:///tmp/arbitrary.js"), None);
}

#[test]
fn foreground_pass_requires_native_dom_and_bundle_identity_evidence() {
    let value = dom(true, "visible", true, true);
    assert!(verify_stage(
        Stage::Shown,
        "never",
        "dev.atools.renderer-smoke.test",
        &value,
        &native(),
        None
    )
    .is_empty());

    let mut missing_occlusion = native();
    missing_occlusion.window_occlusion_visible = None;
    assert!(verify_stage(
        Stage::Shown,
        "never",
        "dev.atools.renderer-smoke.test",
        &value,
        &missing_occlusion,
        None
    )
    .contains(&"foreground-native-dom-or-app-identity-evidence-incomplete"));
}

#[test]
fn hidden_stage_needs_both_native_and_document_hidden_evidence() {
    let mut hidden = native();
    hidden.visible = Some(false);
    hidden.focused = Some(false);
    let value = dom(true, "hidden", false, false);
    assert!(verify_stage(
        Stage::Hidden,
        "immediately",
        "dev.atools.renderer-smoke.test",
        &value,
        &hidden,
        None
    )
    .is_empty());

    let mut still_focused = hidden.clone();
    still_focused.focused = Some(true);
    assert!(verify_stage(
        Stage::Hidden,
        "immediately",
        "dev.atools.renderer-smoke.test",
        &value,
        &still_focused,
        None
    )
    .contains(&"main-window-native-focus-did-not-become-lost"));

    let visible_dom = dom(true, "visible", false, false);
    assert!(verify_stage(
        Stage::Hidden,
        "immediately",
        "dev.atools.renderer-smoke.test",
        &visible_dom,
        &hidden,
        None
    )
    .contains(&"main-document-did-not-become-hidden"));
}

#[test]
fn return_behavior_checks_auto_clear_or_select_all_policy() {
    let visible = native();
    let cleared = dom(true, "visible", true, true);
    let mut cleared = cleared;
    cleared["inputValue"] = json!("");
    cleared["selectionStart"] = json!(0);
    cleared["selectionEnd"] = json!(0);
    assert!(verify_stage(
        Stage::Reshown,
        "immediately",
        "dev.atools.renderer-smoke.test",
        &cleared,
        &visible,
        None
    )
    .is_empty());

    let mut selected = dom(true, "visible", true, true);
    selected["selectionStart"] = json!(0);
    assert!(verify_stage(
        Stage::BlurReturn,
        "never",
        "dev.atools.renderer-smoke.test",
        &selected,
        &visible,
        None
    )
    .is_empty());
    assert!(verify_stage(
        Stage::BlurReturn,
        "immediately",
        "dev.atools.renderer-smoke.test",
        &selected,
        &visible,
        None
    )
    .contains(&"auto-clear-return-search-state-mismatch"));
}

#[test]
fn disposed_stage_rejects_queued_callback_growth_and_checks_four_clean_sources() {
    let visible = native();
    let mut disposed = dom(true, "visible", true, true);
    disposed["adapter"] = adapter(true);
    disposed["preDisposeCounters"] = pre_dispose_counters();
    let pre_dispose = disposed["preDisposeCounters"].clone();
    assert!(verify_stage(
        Stage::Disposed,
        "never",
        "dev.atools.renderer-smoke.test",
        &disposed,
        &visible,
        None
    )
    .is_empty());
    assert!(verify_stage(
        Stage::DisposedReturn,
        "never",
        "dev.atools.renderer-smoke.test",
        &disposed,
        &visible,
        Some(&pre_dispose)
    )
    .is_empty());

    let mut dirty = disposed.clone();
    dirty["adapter"]["focusEvents"]["cleanupErrors"] = json!(1);
    assert!(verify_stage(
        Stage::Disposed,
        "never",
        "dev.atools.renderer-smoke.test",
        &dirty,
        &visible,
        None
    )
    .contains(&"production-event-source-not-fully-disposed"));

    for (field, value) in [("cachedApps", json!(1)), ("readPending", json!(true))] {
        let mut catalog_work = disposed.clone();
        catalog_work["adapter"]["appCatalog"][field] = value;
        assert!(verify_stage(
            Stage::Disposed,
            "never",
            "dev.atools.renderer-smoke.test",
            &catalog_work,
            &visible,
            None
        )
        .contains(&"production-app-catalog-work-remains-after-dispose"));
    }

    let mut threw = disposed.clone();
    threw["disposeError"] = json!("adapter-dispose-threw");
    assert!(verify_stage(
        Stage::Disposed,
        "never",
        "dev.atools.renderer-smoke.test",
        &threw,
        &visible,
        None
    )
    .contains(&"production-adapter-dispose-threw"));

    let mut queued_callback = disposed.clone();
    queued_callback["adapter"]["nativeCalls"]["get_ztools_renderer_settings"] = json!(2);
    queued_callback["adapter"]["focusEvents"]["deliveredEvents"] = json!(2);
    assert!(verify_stage(
        Stage::Disposed,
        "never",
        "dev.atools.renderer-smoke.test",
        &queued_callback,
        &visible,
        None
    )
    .contains(&"post-dispose-native-call-counter-increased"));
    assert!(verify_stage(
        Stage::Disposed,
        "never",
        "dev.atools.renderer-smoke.test",
        &queued_callback,
        &visible,
        None
    )
    .contains(&"post-dispose-event-delivery-counter-increased"));
    assert!(verify_stage(
        Stage::DisposedReturn,
        "never",
        "dev.atools.renderer-smoke.test",
        &queued_callback,
        &visible,
        Some(&pre_dispose)
    )
    .contains(&"post-dispose-event-delivery-counter-increased"));

    let mut changed_baseline = disposed.clone();
    changed_baseline["preDisposeCounters"]["nativeCalls"]["get_ztools_renderer_settings"] =
        json!(2);
    assert!(verify_stage(
        Stage::DisposedReturn,
        "never",
        "dev.atools.renderer-smoke.test",
        &changed_baseline,
        &visible,
        Some(&pre_dispose)
    )
    .contains(&"pre-dispose-counter-baseline-changed"));
}

#[test]
fn event_ledger_is_bounded_and_counts_overflow() {
    let mut events = EventLedger::default();
    events.start(std::time::Instant::now());
    for _ in 0..(super::MAX_WINDOW_EVENTS + 3) {
        events.record("main", "focus-lost");
    }
    let value = events.snapshot();
    assert_eq!(
        value["events"].as_array().unwrap().len(),
        super::MAX_WINDOW_EVENTS
    );
    assert_eq!(value["total"], (super::MAX_WINDOW_EVENTS + 3) as u32);
    assert_eq!(value["overflow"], 3);
    assert!(events.contains("main", "focus-lost"));
    assert!(super::window_event_flow_errors(&[], &events)
        .contains(&"window-event-observation-log-overflowed"));
}
