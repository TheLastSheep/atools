use super::super::expectations::settings_input_matches;
use super::valid_dom;
use serde_json::{json, Value};

fn event_source() -> Value {
    json!({
        "subscribers": 1,
        "listenerState": "listening",
        "deliveredEvents": 0,
        "registrationErrors": 0,
        "callbackErrors": 0,
        "registrationsPending": 0,
        "lateListenerUnlistens": 0,
        "cleanupPending": 0,
        "cleanupErrors": 0
    })
}

fn input_snapshot(callbacks: u64, disposed: bool) -> Value {
    json!({
        "callbacks": callbacks,
        "invalidPayloads": 0,
        "stalePayloads": 0,
        "callbackErrors": 0,
        "notifyFailures": 0,
        "staleReplies": 0,
        "notifyPending": false,
        "notifyInFlight": false,
        "disposed": disposed
    })
}

fn valid_dom_fixture() -> Value {
    let mut focus = event_source();
    focus["windowContextAvailable"] = json!(false);
    let mut local_shortcuts = event_source();
    local_shortcuts["invalidEvents"] = json!(0);
    local_shortcuts["staleEvents"] = json!(0);
    local_shortcuts["latestRevision"] = Value::Null;
    local_shortcuts["replayPending"] = json!(false);
    let settings_view = json!({
        "version": 1,
        "listenerState": "listening",
        "activePhase": null,
        "input": input_snapshot(5, false),
        "pendingOpen": false,
        "openFailures": 0,
        "closeFailures": 0,
        "invalidPayloads": 0,
        "registrationErrors": 0,
        "lateListenerUnlistens": 0,
        "cleanupErrors": 0
    });
    let window_drag = json!({
        "disposed": false,
        "pending": 0,
        "queued": 0,
        "inFlight": null,
        "pendingPositionReads": 0,
        "queuedMoves": 0,
        "queuedLocks": 0,
        "positionReads": 0,
        "moveRequests": 0,
        "lockRequests": 0,
        "dispatchedPositions": 0,
        "dispatchedMoves": 0,
        "dispatchedLocks": 0,
        "coalescedMoves": 0,
        "rejectedOperations": 0,
        "failures": 0,
        "cancelledReads": 0,
        "droppedAfterDispose": 0
    });
    let source = event_source();
    let dom = json!({
        "inputValue": "",
        "pastedText": "",
        "selectedTitle": "",
        "visibility": "hidden",
        "documentHasFocus": false,
        "inputFocused": true,
        "actions": {
            "metaFDefaultPrevented": null,
            "launchRejected": null,
            "launchResolved": null,
            "arrowDownDefaultPrevented": null,
            "enterDefaultPrevented": null
        },
        "adapter": {
            "launchCalls": 0,
            "outstandingNativeCalls": 0,
            "listeners": {
                "focusEvents": focus,
                "appState": {
                    "version": 1, "revision": null, "historySubscribers": 1, "pinnedSubscribers": 1,
                    "listenerState": "listening", "eventSource": source.clone(), "queuedMutations": 0,
                    "acceptedReplies": 0, "acceptedEvents": 0, "stalePayloads": 0, "invalidPayloads": 0,
                    "mutationFailures": 0, "applyErrors": 0, "callbackErrors": 0, "disposed": false
                },
                "appCatalog": {"cachedApps": 2, "readPending": false, "invalidations": 0, "eventSource": source.clone()},
                "appLaunched": {"invalidPayloads": 0, "eventSource": source.clone()},
                "contextMenu": {
                    "version": 1, "subscribers": 1, "showInFlight": false, "whitelistedCommands": 0,
                    "showRequests": 0, "showFailures": 0, "acceptedCommands": 0, "ignoredEvents": 0,
                    "invalidEvents": 0, "callbackErrors": 0, "eventSource": source.clone(), "disposed": false
                },
                "settingsView": settings_view,
                "generalPreferenceEvents": {"version": 1, "invalidPayloads": 0, "notifiedFields": {"placeholder": 0}},
                "localShortcutEvents": local_shortcuts
            },
            "windowDrag": window_drag
        }
    });
    dom
}

#[test]
fn valid_dom_accepts_settings_input_contract_and_rejects_bad_shapes() {
    let dom = valid_dom_fixture();
    assert!(valid_dom(&dom));

    let mut missing = dom.clone();
    missing["adapter"]["listeners"]["settingsView"]
        .as_object_mut()
        .unwrap()
        .remove("input");
    assert!(!valid_dom(&missing));

    let mut bad_pending_type = dom.clone();
    bad_pending_type["adapter"]["listeners"]["settingsView"]["input"]["notifyPending"] =
        json!("false");
    assert!(!valid_dom(&bad_pending_type));

    let mut unknown = dom;
    unknown["adapter"]["listeners"]["settingsView"]["input"]["unexpected"] = json!(0);
    assert!(!valid_dom(&unknown));
}

#[test]
fn settings_input_phase_gate_requires_idle_callbacks_and_disposed_cleanup() {
    let mut active = valid_dom_fixture();
    assert!(settings_input_matches(&active, false));

    active["adapter"]["listeners"]["settingsView"]["input"]["callbacks"] = json!(4);
    assert!(!settings_input_matches(&active, false));
    active["adapter"]["listeners"]["settingsView"]["input"] = input_snapshot(5, false);
    active["adapter"]["listeners"]["settingsView"]["input"]["notifyPending"] = json!(true);
    assert!(!settings_input_matches(&active, false));
    active["adapter"]["listeners"]["settingsView"]["input"] = input_snapshot(5, false);
    active["adapter"]["listeners"]["settingsView"]["input"]["notifyInFlight"] = json!(true);
    assert!(!settings_input_matches(&active, false));

    for field in [
        "invalidPayloads",
        "stalePayloads",
        "callbackErrors",
        "notifyFailures",
        "staleReplies",
    ] {
        let mut invalid = valid_dom_fixture();
        invalid["adapter"]["listeners"]["settingsView"]["input"][field] = json!(1);
        assert!(
            !settings_input_matches(&invalid, false),
            "{field} must remain zero"
        );
    }

    let mut disposed = valid_dom_fixture();
    disposed["adapter"]["listeners"]["settingsView"]["listenerState"] = json!("disposed");
    disposed["adapter"]["listeners"]["settingsView"]["input"] = input_snapshot(0, true);
    assert!(settings_input_matches(&disposed, true));
    disposed["adapter"]["listeners"]["settingsView"]["input"]["callbacks"] = json!(1);
    assert!(!settings_input_matches(&disposed, true));
}
