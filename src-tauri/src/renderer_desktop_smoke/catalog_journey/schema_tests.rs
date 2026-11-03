use super::*;
use crate::renderer_desktop_smoke::catalog_journey::report::{
    EventSourceObservation, EventSources, IconObservation, ListenerState, SettingsViewObservation,
    QUERY,
};
use serde_json::json;

fn source(listener_state: ListenerState, subscribers: u64) -> EventSourceObservation {
    EventSourceObservation {
        subscribers,
        listener_state,
        delivered_events: 0,
        registration_errors: 0,
        callback_errors: 0,
        registrations_pending: 0,
        cleanup_pending: 0,
        cleanup_errors: 0,
    }
}

fn dom(stage: Stage, calls: u64, delivered: u64, native_events: u64) -> DomObservation {
    let disposed = matches!(stage, Stage::Disposed | Stage::PostDispose);
    let listener = if disposed {
        ListenerState::Disposed
    } else {
        ListenerState::Listening
    };
    let subscribers = if disposed { 0 } else { 2 };
    let titles = if stage == Stage::Added {
        vec![
            "ATools Catalog Added".to_owned(),
            "ATools Catalog Initial".to_owned(),
        ]
    } else {
        vec!["ATools Catalog Initial".to_owned()]
    };
    let icon = matches!(stage, Stage::Initial | Stage::Added).then_some(IconObservation {
        complete: true,
        width: 64,
        height: 64,
        analysis_succeeded: true,
    });
    DomObservation {
        input_found: true,
        input_value: QUERY.to_owned(),
        titles,
        document_visibility: "hidden".to_owned(),
        document_has_focus: false,
        app_list_calls: calls,
        catalog_delivered_events: delivered,
        catalog_subscriber_count: subscribers,
        pending_native_calls: 0,
        app_read_pending: false,
        disposed,
        icon,
        event_sources: EventSources {
            focus_events: source(listener, subscribers),
            app_state: source(listener, subscribers),
            context_menu: source(listener, subscribers),
            app_catalog: source(listener, subscribers),
        },
        settings_view: SettingsViewObservation {
            listener_state: listener,
            registration_errors: 0,
            cleanup_errors: 0,
        },
        native_catalog_events: native_events,
        witness_stopped: stage == Stage::PostDispose,
    }
}

fn native(items: Option<u64>) -> NativeObservation {
    NativeObservation {
        visible: Some(false),
        focused: Some(false),
        focus_gained_events: 0,
        active_child_layouts: Some(0),
        child_webviews: Some(0),
        data_store_persistent: Some(false),
        catalog_items: items,
    }
}

fn previous(stage: Stage, dom: DomObservation, native: NativeObservation) -> StageObservation {
    StageObservation {
        stage: stage.as_str(),
        elapsed_ms: 1,
        dom,
        native,
        errors: Vec::new(),
    }
}

#[test]
fn parser_accepts_exact_contract_dom_shape() {
    let value = serde_json::to_value(dom(Stage::Initial, 1, 0, 0)).unwrap();
    assert!(parse_dom(value).is_ok());
}

#[test]
fn parser_rejects_unknown_missing_and_ill_typed_fields() {
    let mut unknown = serde_json::to_value(dom(Stage::Initial, 1, 0, 0)).unwrap();
    unknown["eventSources"]["appCatalog"]["rawPayload"] = json!("must-not-pass");
    assert!(matches!(
        parse_dom(unknown),
        Err("catalog-probe-protocol-rejected")
    ));

    let mut missing = serde_json::to_value(dom(Stage::Initial, 1, 0, 0)).unwrap();
    missing
        .as_object_mut()
        .unwrap()
        .remove("nativeCatalogEvents");
    assert!(matches!(
        parse_dom(missing),
        Err("catalog-probe-protocol-rejected")
    ));

    let mut wrong_type = serde_json::to_value(dom(Stage::Initial, 1, 0, 0)).unwrap();
    wrong_type["settingsView"]["cleanupErrors"] = json!("0");
    assert!(matches!(
        parse_dom(wrong_type),
        Err("catalog-probe-protocol-rejected")
    ));
}

#[test]
fn parser_rejects_oversized_input_and_title_values() {
    let mut long_input = serde_json::to_value(dom(Stage::Initial, 1, 0, 0)).unwrap();
    long_input["inputValue"] = json!("x".repeat(MAX_INPUT_BYTES + 1));
    assert!(matches!(
        parse_dom(long_input),
        Err("catalog-probe-protocol-rejected")
    ));

    let mut long_title = serde_json::to_value(dom(Stage::Initial, 1, 0, 0)).unwrap();
    long_title["titles"] = json!(["x".repeat(MAX_TITLE_BYTES + 1)]);
    assert!(matches!(
        parse_dom(long_title),
        Err("catalog-probe-protocol-rejected")
    ));
}

#[test]
fn added_requires_both_real_adapter_and_native_event_deltas() {
    let initial = previous(
        Stage::Initial,
        dom(Stage::Initial, 1, 0, 0),
        native(Some(1)),
    );
    let prior = [initial.clone()];
    let added_dom = dom(Stage::Added, 2, 1, 1);
    assert!(validate_stage(Stage::Added, 1, &prior, &added_dom, &native(Some(2))).is_ok());

    let no_native_delta = dom(Stage::Added, 2, 1, 0);
    assert_eq!(
        validate_stage(Stage::Added, 1, &prior, &no_native_delta, &native(Some(2))),
        Err("catalog-dom-stage-evidence-incomplete")
    );
    let no_adapter_delta = dom(Stage::Added, 1, 0, 1);
    assert_eq!(
        validate_stage(Stage::Added, 1, &prior, &no_adapter_delta, &native(Some(2))),
        Err("catalog-dom-stage-evidence-incomplete")
    );
}

#[test]
fn post_dispose_requires_external_event_without_adapter_activity() {
    let disposed = previous(
        Stage::Disposed,
        dom(Stage::Disposed, 3, 2, 2),
        native(Some(1)),
    );
    let prior = [
        previous(
            Stage::Initial,
            dom(Stage::Initial, 1, 0, 0),
            native(Some(1)),
        ),
        previous(Stage::Added, dom(Stage::Added, 2, 1, 1), native(Some(2))),
        previous(
            Stage::Removed,
            dom(Stage::Removed, 3, 2, 2),
            native(Some(1)),
        ),
        disposed,
    ];
    let valid = dom(Stage::PostDispose, 3, 2, 3);
    assert!(validate_stage(Stage::PostDispose, 4, &prior, &valid, &native(Some(2))).is_ok());

    let adapter_changed = dom(Stage::PostDispose, 4, 2, 3);
    assert_eq!(
        validate_stage(
            Stage::PostDispose,
            4,
            &prior,
            &adapter_changed,
            &native(Some(2))
        ),
        Err("catalog-dom-stage-evidence-incomplete")
    );
    let witness_missing = dom(Stage::PostDispose, 3, 2, 2);
    assert_eq!(
        validate_stage(
            Stage::PostDispose,
            4,
            &prior,
            &witness_missing,
            &native(Some(2))
        ),
        Err("catalog-dom-stage-evidence-incomplete")
    );
}

#[test]
fn unknown_native_values_do_not_count_as_hidden_or_empty() {
    let dom = dom(Stage::Initial, 1, 0, 0);
    assert_eq!(
        validate_stage(Stage::Initial, 0, &[], &dom, &native(None)),
        Err("catalog-hidden-native-state-not-verified")
    );
}
